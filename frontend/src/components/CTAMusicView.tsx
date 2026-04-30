"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import staticDataJson from "@/data/cta-static.json";
import { audioEngine } from "@/lib/audioEngine";
import type { CTAStaticData, CTAStop, Train } from "@/types/cta";

const defaultBounds: LngLatBoundsLike = [
  [-87.95, 41.62],
  [-87.5, 42.08],
];
const staticData = staticDataJson as CTAStaticData;
const TRAIN_COUNT = 40;
const TRAIN_SPEED_MPS = 60;
const ARRIVAL_EPSILON_METERS = 4;

const MELODY_NOTES = [
  "C4",
  "B3",
  "C4",
  "A3",
  "F3",
  "G3",
  "A3",
  "G#3",
  "A3",
  "F3",
  "D3",
  "E3",
  "F3",
  "G3",
  "F3",
  "E3",
  "F3",
  "E3",
  "F3",
  "G3",
  "A3",
  "G3",
  "F#3",
  "G3",
  "A3",
  "Bb3",
  "B3",
  "C4",
  "C4",
  "B3",
  "C4",
  "A3",
  "F3",
  "G3",
  "A3",
  "Bb3",
  "A3",
  "G#3",
  "A3",
  "F3",
  "D3",
  "E3",
  "F3",
  "G3",
  "F3",
  "F3",
  "G3",
  "A3",
  "Bb3",
  "C4",
  "D4",
  "C4",
  "A3",
  "Bb3",
  "G3",
  "F3",
  "C5",
];

type LineStop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  routeIndex: number;
};
type MusicTrainState = {
  id: string;
  line: string;
  lat: number;
  lng: number;
  currentStopIndex: number;
  nextStopIndex: number;
  direction: 1 | -1;
  speedMps: number;
  routeCursorIndex: number;
};

function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const radius = 6_371_000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function moveTowards(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  stepMeters: number,
): { lat: number; lng: number } {
  const distance = distanceMeters(fromLat, fromLng, toLat, toLng);
  if (distance <= stepMeters || distance === 0) {
    return { lat: toLat, lng: toLng };
  }
  const ratio = stepMeters / distance;
  return {
    lat: fromLat + (toLat - fromLat) * ratio,
    lng: fromLng + (toLng - fromLng) * ratio,
  };
}

function nearestRouteIndex(
  points: [number, number][],
  lat: number,
  lng: number,
): number {
  if (points.length <= 1) return 0;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const [pointLng, pointLat] = points[i];
    const distance = distanceMeters(lat, lng, pointLat, pointLng);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function trainFeatureCollection(
  trains: Train[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: trains.map((train) => ({
      type: "Feature",
      properties: {
        id: train.id,
        line: train.line,
        shortLabel: `${train.line.slice(0, 1).toUpperCase()}${train.id}`,
      },
      geometry: {
        type: "Point",
        coordinates: [train.lng, train.lat],
      },
    })),
  };
}

function lineStopsInRouteOrder(routeLine: string): LineStop[] {
  const route = staticData.routes.find((entry) => entry.line === routeLine);
  if (!route) return [];
  const points = (
    route.segments && route.segments.length > 0
      ? route.segments.flat()
      : route.coordinates
  ) as [number, number][];
  const stops = staticData.stops
    .filter((stop) => stop.lines.includes(routeLine))
    .map((stop) => ({
      ...stop,
      order: nearestRouteIndex(points, stop.lat, stop.lng),
    }))
    .sort((a, b) => a.order - b.order);

  const seenIds = new Set<string>();
  return stops
    .filter((stop) => {
      if (seenIds.has(stop.id)) return false;
      seenIds.add(stop.id);
      return true;
    })
    .map((stop) => ({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      routeIndex: stop.order,
    }));
}

export function CTAMusicView() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const simTrainsRef = useRef<Map<string, MusicTrainState>>(new Map());
  const lastFrameMsRef = useRef<number | null>(null);
  const lastPublishMsRef = useRef(0);
  const melodyIndexRef = useRef(0);
  const lineStopsRef = useRef(
    new Map(
      staticData.routes.map((route) => [
        route.line,
        lineStopsInRouteOrder(route.line),
      ]),
    ),
  );
  const linePointsRef = useRef(
    new Map(
      staticData.routes.map((route) => {
        const points = (
          route.segments && route.segments.length > 0
            ? route.segments.flat()
            : route.coordinates
        ) as [number, number][];
        return [route.line, points];
      }),
    ),
  );
  const [trains, setTrains] = useState<Train[]>([]);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    const eligibleLines = staticData.routes
      .map((route) => route.line)
      .filter((line) => (lineStopsRef.current.get(line) ?? []).length >= 2);
    const nextSim = new Map<string, MusicTrainState>();

    for (let i = 0; i < TRAIN_COUNT; i += 1) {
      const line =
        eligibleLines[Math.floor(Math.random() * eligibleLines.length)];
      const stops = lineStopsRef.current.get(line) ?? [];
      const currentStopIndex = Math.floor(Math.random() * (stops.length - 1));
      const direction: 1 | -1 = Math.random() > 0.5 ? 1 : -1;
      const unclampedNext = currentStopIndex + direction;
      const nextStopIndex =
        unclampedNext < 0 || unclampedNext >= stops.length
          ? currentStopIndex - direction
          : unclampedNext;
      const startStop = stops[currentStopIndex];
      nextSim.set(`music-${i + 1}`, {
        id: `music-${i + 1}`,
        line,
        lat: startStop.lat,
        lng: startStop.lng,
        currentStopIndex,
        nextStopIndex,
        direction: nextStopIndex > currentStopIndex ? 1 : -1,
        speedMps: TRAIN_SPEED_MPS,
        routeCursorIndex: startStop.routeIndex,
      });
    }

    simTrainsRef.current = nextSim;
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style:
        process.env.NEXT_PUBLIC_MAP_STYLE_URL ??
        "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      bounds: defaultBounds,
      fitBoundsOptions: { padding: 24 },
    });
    mapRef.current = map;

    map.on("load", () => {
      staticData.routes.forEach((route) => {
        const segments =
          route.segments && route.segments.length > 0
            ? route.segments
            : [route.coordinates];
        segments.forEach((segment, segmentIndex) => {
          const sourceId = `route-${route.line}-${segmentIndex}`;
          map.addSource(sourceId, {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: segment },
            },
          });
          map.addLayer({
            id: sourceId,
            type: "line",
            source: sourceId,
            paint: {
              "line-width": 4,
              "line-color": route.color,
              "line-opacity": 0.92,
            },
          });
        });
      });

      map.addSource("stops", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: staticData.stops.map((stop) => ({
            type: "Feature",
            properties: { id: stop.id, name: stop.name },
            geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
          })),
        },
      });
      map.addLayer({
        id: "stops-ticks-layer",
        type: "circle",
        source: "stops",
        paint: {
          "circle-radius": 1.8,
          "circle-color": "#f8fafc",
          "circle-opacity": 0.85,
        },
      });

      map.addSource("trains", {
        type: "geojson",
        data: trainFeatureCollection([]),
      });
      map.addLayer({
        id: "trains-layer",
        type: "circle",
        source: "trains",
        paint: {
          "circle-radius": 7,
          "circle-color": "#f8fafc",
          "circle-stroke-color": "#38bdf8",
          "circle-stroke-width": 2,
          "circle-blur": 0.3,
        },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let frameId: number | null = null;

    const tick = (now: number) => {
      if (lastFrameMsRef.current === null) {
        lastFrameMsRef.current = now;
      }
      const deltaSeconds = (now - lastFrameMsRef.current) / 1000;
      lastFrameMsRef.current = now;

      for (const sim of simTrainsRef.current.values()) {
        const stops = lineStopsRef.current.get(sim.line) ?? [];
        const linePoints = linePointsRef.current.get(sim.line) ?? [];
        if (stops.length < 2) continue;

        const targetStop: CTAStop | LineStop = stops[sim.nextStopIndex];
        let remainingMeters = sim.speedMps * deltaSeconds;

        if (linePoints.length > 1) {
          while (
            remainingMeters > 0 &&
            sim.routeCursorIndex !== targetStop.routeIndex
          ) {
            const stepDirection: 1 | -1 =
              targetStop.routeIndex > sim.routeCursorIndex ? 1 : -1;
            const nextRouteIndex = sim.routeCursorIndex + stepDirection;
            if (nextRouteIndex < 0 || nextRouteIndex >= linePoints.length) {
              break;
            }

            const [targetLng, targetLat] = linePoints[nextRouteIndex];
            const beforeLat = sim.lat;
            const beforeLng = sim.lng;
            const moved = moveTowards(
              sim.lat,
              sim.lng,
              targetLat,
              targetLng,
              remainingMeters,
            );
            sim.lat = moved.lat;
            sim.lng = moved.lng;
            const traveled = distanceMeters(
              beforeLat,
              beforeLng,
              sim.lat,
              sim.lng,
            );
            remainingMeters = Math.max(0, remainingMeters - traveled);

            const distanceToRoutePoint = distanceMeters(
              sim.lat,
              sim.lng,
              targetLat,
              targetLng,
            );
            if (distanceToRoutePoint <= 1) {
              sim.lat = targetLat;
              sim.lng = targetLng;
              sim.routeCursorIndex = nextRouteIndex;
            } else {
              break;
            }
          }
        } else {
          const moved = moveTowards(
            sim.lat,
            sim.lng,
            targetStop.lat,
            targetStop.lng,
            remainingMeters,
          );
          sim.lat = moved.lat;
          sim.lng = moved.lng;
        }

        const reachedTargetOnRoute =
          linePoints.length > 1 &&
          sim.routeCursorIndex === targetStop.routeIndex;
        if (!reachedTargetOnRoute) {
          const distanceToTarget = distanceMeters(
            sim.lat,
            sim.lng,
            targetStop.lat,
            targetStop.lng,
          );
          if (distanceToTarget > ARRIVAL_EPSILON_METERS) {
            continue;
          }
        }

        sim.lat = targetStop.lat;
        sim.lng = targetStop.lng;
        sim.routeCursorIndex = targetStop.routeIndex;
        const nextNote =
          MELODY_NOTES[melodyIndexRef.current % MELODY_NOTES.length];
        melodyIndexRef.current += 1;
        audioEngine.schedulePlay({
          line: sim.line,
          note: nextNote,
        });
        sim.currentStopIndex = sim.nextStopIndex;

        let nextDirection = sim.direction;
        let candidateNext = sim.currentStopIndex + nextDirection;
        if (candidateNext < 0 || candidateNext >= stops.length) {
          nextDirection = nextDirection === 1 ? -1 : 1;
          candidateNext = sim.currentStopIndex + nextDirection;
        }
        sim.direction = nextDirection;
        sim.nextStopIndex = Math.max(
          0,
          Math.min(candidateNext, stops.length - 1),
        );
      }

      if (now - lastPublishMsRef.current >= 120) {
        lastPublishMsRef.current = now;
        setTrains(
          Array.from(simTrainsRef.current.values()).map((sim) => {
            const stops = lineStopsRef.current.get(sim.line) ?? [];
            const nextStop = stops[sim.nextStopIndex];
            return {
              id: sim.id,
              line: sim.line,
              lat: sim.lat,
              lng: sim.lng,
              nextStopId: nextStop?.id ?? "",
              nextStopName: nextStop?.name ?? "",
              timestamp: Date.now(),
            };
          }),
        );
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    const source = map.getSource("trains") as GeoJSONSource | undefined;
    source?.setData(trainFeatureCollection(trains));
  }, [trains]);

  const handleEnableAudio = async () => {
    await audioEngine.start();
    audioEngine.setMuted(false);
    setIsMuted(false);
    setAudioEnabled(true);
  };

  const handleMuteToggle = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    audioEngine.setMuted(nextMuted);
  };

  return (
    <div className="relative h-screen w-screen">
      <div ref={mapContainerRef} className="h-full w-full" />
      <div className="absolute left-4 top-4 flex max-w-sm flex-col gap-3 rounded-lg bg-slate-900/80 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
        <h1 className="text-base font-semibold">CTA Music Simulator</h1>
        <div className="flex items-center justify-between">
          <span>Mode</span>
          <span className="rounded bg-indigo-900/70 px-2 py-1 text-xs text-indigo-100">
            Local Simulation
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>Audio</span>
          {!audioEnabled ? (
            <button
              type="button"
              onClick={() => void handleEnableAudio()}
              className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Enable
            </button>
          ) : (
            <button
              type="button"
              onClick={handleMuteToggle}
              className="rounded bg-slate-700 px-2 py-1 text-xs font-semibold text-slate-100 hover:bg-slate-600"
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
