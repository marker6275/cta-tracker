"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import staticDataJson from "@/data/cta-static.json";
import { useArrivalSocket } from "@/hooks/useArrivalSocket";
import { audioEngine } from "@/lib/audioEngine";
import type { CTAEvent, CTAStaticData, Train } from "@/types/cta";
const defaultBounds: LngLatBoundsLike = [
  [-87.95, 41.62],
  [-87.5, 42.08],
];
const staticData = staticDataJson as CTAStaticData;
const STOP_ARRIVAL_RADIUS_METERS = 5;
const STOP_CAPTURE_RADIUS_METERS = 30;
const STOP_DWELL_MS = 12_000;
const STOP_RESOLVE_FALLBACK_MAX_METERS = 1200;
const MIN_SPEED_MPS = 1.5;
const MAX_SPEED_MPS = 22;
const ANIMATION_SPEED_FACTOR = 0.4;
const DEBUG_TRAIN_ID = "921";
const NOTE_SCALE = ["C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5", "G5", "A5"];

type SimTrainState = {
  id: string;
  line: string;
  lat: number;
  lng: number;
  nextStopId: string;
  nextStopName?: string | null;
  speedMps: number;
  headingLatPerSec: number;
  headingLngPerSec: number;
  routeCursorIndex: number;
  routeDirection: 1 | -1;
  dwellStopId: string | null;
  dwellUntilMs: number;
  lastDwelledStopId: string | null;
};

type LineStop = { id: string; lat: number; lng: number };
type RenderTrain = Train & { direction: string };

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

function applyCoast(sim: SimTrainState, deltaSeconds: number): void {
  sim.lat += sim.headingLatPerSec * ANIMATION_SPEED_FACTOR * deltaSeconds;
  sim.lng += sim.headingLngPerSec * ANIMATION_SPEED_FACTOR * deltaSeconds;
}

function nearestRouteIndex(
  points: [number, number][],
  lat: number,
  lng: number,
): number {
  if (points.length <= 1) {
    return 0;
  }
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

function moveAlongRoute(
  sim: SimTrainState,
  points: [number, number][],
  deltaSeconds: number,
): void {
  if (points.length <= 1) {
    return;
  }
  const direction: 1 | -1 = sim.routeDirection === -1 ? -1 : 1;
  sim.routeDirection = direction;
  let nextIndex = Math.max(
    0,
    Math.min(sim.routeCursorIndex + direction, points.length - 1),
  );
  if (nextIndex === sim.routeCursorIndex) {
    sim.routeDirection = sim.routeDirection === 1 ? -1 : 1;
    nextIndex = Math.max(
      0,
      Math.min(sim.routeCursorIndex + sim.routeDirection, points.length - 1),
    );
  }
  const [targetLng, targetLat] = points[nextIndex];
  const moved = moveTowards(
    sim.lat,
    sim.lng,
    targetLat,
    targetLng,
    sim.speedMps * ANIMATION_SPEED_FACTOR * deltaSeconds,
  );
  sim.lat = moved.lat;
  sim.lng = moved.lng;
  const distanceToPoint = distanceMeters(
    sim.lat,
    sim.lng,
    targetLat,
    targetLng,
  );
  if (distanceToPoint <= 8 && nextIndex >= 0 && nextIndex < points.length) {
    sim.routeCursorIndex = nextIndex;
  }
}

function resolveStopByIdOrNearest(
  stops: LineStop[],
  stopId: string,
  nearLat: number,
  nearLng: number,
): LineStop | null {
  const exact = stops.find((stop) => stop.id === stopId);
  if (exact) {
    return exact;
  }
  if (stops.length === 0) {
    return null;
  }

  let nearest: LineStop | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const distance = distanceMeters(nearLat, nearLng, stop.lat, stop.lng);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = stop;
    }
  }

  if (nearest && nearestDistance <= STOP_RESOLVE_FALLBACK_MAX_METERS) {
    return nearest;
  }
  return null;
}

function normalizeTrainNextStopId(
  train: Train,
  lineStopsByLine: Map<string, LineStop[]>,
  nextStopMappingCache: Map<string, string>,
): { train: Train; rawNextStopId: string; mappedNextStopId: string } {
  const lineStops = (lineStopsByLine.get(train.line) ?? []) as LineStop[];
  const rawNextStopId = train.nextStopId;
  const cacheKey = `${train.line}:${rawNextStopId}`;

  const exact = lineStops.find((stop) => stop.id === rawNextStopId);
  if (exact) {
    nextStopMappingCache.set(cacheKey, exact.id);
    return {
      train: { ...train, nextStopId: exact.id },
      rawNextStopId,
      mappedNextStopId: exact.id,
    };
  }

  const cachedMappedId = nextStopMappingCache.get(cacheKey);
  if (cachedMappedId) {
    return {
      train: { ...train, nextStopId: cachedMappedId },
      rawNextStopId,
      mappedNextStopId: cachedMappedId,
    };
  }

  const resolvedStop = resolveStopByIdOrNearest(
    lineStops,
    rawNextStopId,
    train.lat,
    train.lng,
  );
  const mappedNextStopId = resolvedStop?.id ?? rawNextStopId;
  if (resolvedStop) {
    nextStopMappingCache.set(cacheKey, resolvedStop.id);
  }
  return {
    train: { ...train, nextStopId: mappedNextStopId },
    rawNextStopId,
    mappedNextStopId,
  };
}

function trainFeatureCollection(
  trains: Train[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const usedLabels = new Set<string>();
  const collisionCounts = new Map<string, number>();

  const buildUniqueLabel = (train: Train): string => {
    const lineInitial = train.line.slice(0, 1).toUpperCase() || "T";
    const base = `${lineInitial}${train.id}`;
    if (!usedLabels.has(base)) {
      usedLabels.add(base);
      return base;
    }

    const nextIndex = (collisionCounts.get(base) ?? 1) + 1;
    collisionCounts.set(base, nextIndex);
    const withSuffix = `${base}${nextIndex}`;
    usedLabels.add(withSuffix);
    return withSuffix;
  };

  return {
    type: "FeatureCollection",
    features: trains.map((train) => ({
      type: "Feature",
      properties: {
        id: train.id,
        line: train.line,
        shortLabel: buildUniqueLabel(train),
      },
      geometry: {
        type: "Point",
        coordinates: [train.lng, train.lat],
      },
    })),
  };
}

function getTrainById(trains: Train[], trainId: string): Train | undefined {
  return trains.find((train) => train.id === trainId);
}

function cardinalDirection(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): string {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  if (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) {
    return "Stationary";
  }
  const angle = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  const normalized = (angle + 360) % 360;
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}

function directionLabel(direction: string): string {
  const labels: Record<string, string> = {
    N: "North",
    NE: "Northeast",
    E: "East",
    SE: "Southeast",
    S: "South",
    SW: "Southwest",
    W: "West",
    NW: "Northwest",
    Unknown: "Unknown",
    Stationary: "Stationary",
  };
  return labels[direction] ?? direction;
}

function trainDirection(
  sim: SimTrainState,
  points: [number, number][],
): string {
  if (points.length <= 1) {
    return "Unknown";
  }
  const direction: 1 | -1 = sim.routeDirection === -1 ? -1 : 1;
  let nextIndex = Math.max(
    0,
    Math.min(sim.routeCursorIndex + direction, points.length - 1),
  );
  if (nextIndex === sim.routeCursorIndex) {
    nextIndex = Math.max(
      0,
      Math.min(sim.routeCursorIndex - direction, points.length - 1),
    );
  }
  const [targetLng, targetLat] = points[nextIndex] ?? [sim.lng, sim.lat];
  return cardinalDirection(sim.lat, sim.lng, targetLat, targetLng);
}

function noteForStopId(stopId: string): string {
  const hash = stopId
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return NOTE_SCALE[hash % NOTE_SCALE.length];
}

export function MapView() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const liveTrainsRef = useRef<Map<string, Train>>(new Map());
  const lastSyncedCoordsRef = useRef<Map<string, { lat: number; lng: number }>>(
    new Map(),
  );
  const simTrainsRef = useRef<Map<string, SimTrainState>>(new Map());
  const nextStopMappingCacheRef = useRef<Map<string, string>>(new Map());
  const didLogInitialTrainsRef = useRef(false);
  const lastFrameMsRef = useRef<number | null>(null);
  const lastPublishMsRef = useRef(0);
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
  const lineStopsRef = useRef(
    new Map(
      staticData.routes.map((route) => [
        route.line,
        staticData.stops
          .filter((stop) => stop.lines.includes(route.line))
          .map((stop) => ({ id: stop.id, lat: stop.lat, lng: stop.lng })),
      ]),
    ),
  );
  const [trains, setTrains] = useState<RenderTrain[]>([]);
  const [lastSyncMs, setLastSyncMs] = useState<number | null>(null);
  const [secondsSinceSync, setSecondsSinceSync] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const handleSocketEvent = (event: CTAEvent) => {
    if (event.type === "arrival") {
      audioEngine.schedulePlay({
        line: event.line,
        note: noteForStopId(event.stopId),
      });
      return;
    }

    if (event.type === "train_update") {
      const now = performance.now();
      setLastSyncMs(Date.now());
      const normalizedTrains = event.trains.map((train) =>
        normalizeTrainNextStopId(
          train,
          lineStopsRef.current,
          nextStopMappingCacheRef.current,
        ),
      );
      const nextLive = new Map(
        normalizedTrains.map((normalized) => [
          normalized.train.id,
          normalized.train,
        ]),
      );
      if (!didLogInitialTrainsRef.current) {
        didLogInitialTrainsRef.current = true;
        console.log("[initial-trains]", {
          count: normalizedTrains.length,
          trains: normalizedTrains.map((normalized) => ({
            id: normalized.train.id,
            line: normalized.train.line,
            lat: normalized.train.lat,
            lng: normalized.train.lng,
            rawNextStopId: normalized.rawNextStopId,
            mappedNextStopId: normalized.mappedNextStopId,
          })),
        });
      }

      liveTrainsRef.current = nextLive;

      const nextSim = new Map(simTrainsRef.current);
      for (const [id, liveTrain] of nextLive.entries()) {
        const lastSyncedCoords = lastSyncedCoordsRef.current.get(id);
        const coordsChanged =
          !lastSyncedCoords ||
          lastSyncedCoords.lat !== liveTrain.lat ||
          lastSyncedCoords.lng !== liveTrain.lng;
        lastSyncedCoordsRef.current.set(id, {
          lat: liveTrain.lat,
          lng: liveTrain.lng,
        });

        const existing = nextSim.get(id);
        if (!existing) {
          const points = linePointsRef.current.get(liveTrain.line) ?? [];
          nextSim.set(id, {
            id,
            line: liveTrain.line,
            lat: liveTrain.lat,
            lng: liveTrain.lng,
            nextStopId: liveTrain.nextStopId,
            nextStopName: liveTrain.nextStopName,
            speedMps: (MIN_SPEED_MPS + MAX_SPEED_MPS) / 2,
            headingLatPerSec: 0,
            headingLngPerSec: 0,
            routeCursorIndex: nearestRouteIndex(
              points,
              liveTrain.lat,
              liveTrain.lng,
            ),
            routeDirection: 1,
            dwellStopId: null,
            dwellUntilMs: 0,
            lastDwelledStopId: null,
          });
          continue;
        }

        if (existing.routeDirection !== 1 && existing.routeDirection !== -1) {
          existing.routeDirection = 1;
        }
        existing.headingLatPerSec = 0;
        existing.headingLngPerSec = 0;

        const points = linePointsRef.current.get(existing.line) ?? [];
        if (points.length > 1 && coordsChanged) {
          const nearestLiveIndex = nearestRouteIndex(
            points,
            liveTrain.lat,
            liveTrain.lng,
          );
          const [anchorLng, anchorLat] = points[existing.routeCursorIndex] ?? [
            liveTrain.lng,
            liveTrain.lat,
          ];
          const anchorDistance = distanceMeters(
            existing.lat,
            existing.lng,
            anchorLat,
            anchorLng,
          );
          if (anchorDistance > 200) {
            existing.routeCursorIndex = nearestLiveIndex;
          }
        }

        if (coordsChanged) {
          // On feed position changes, snap immediately to the new live coordinate.
          existing.lat = liveTrain.lat;
          existing.lng = liveTrain.lng;
        }

        existing.line = liveTrain.line;
        // Preserve simulated position between API updates; only metadata should sync directly.
        existing.nextStopId = liveTrain.nextStopId;
        existing.nextStopName = liveTrain.nextStopName;
      }

      for (const id of nextSim.keys()) {
        if (!nextLive.has(id)) {
          nextSim.delete(id);
          lastSyncedCoordsRef.current.delete(id);
        }
      }

      simTrainsRef.current = nextSim;
      const debugSim = nextSim.get(DEBUG_TRAIN_ID);
      if (debugSim) {
        const direction = trainDirection(
          debugSim,
          linePointsRef.current.get(debugSim.line) ?? [],
        );
        console.log("[train-direction]", {
          trainId: debugSim.id,
          shouldHead: directionLabel(direction),
          shortDirection: direction,
          nextStopId: debugSim.nextStopId,
          timestamp: event.timestamp,
        });
      }
    }
  };

  const { isConnected } = useArrivalSocket(handleSocketEvent);

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
      map.addLayer({
        id: "stops-labels-layer",
        type: "symbol",
        source: "stops",
        minzoom: 10.5,
        layout: {
          "text-field": ["concat", ["get", "id"], " - ", ["get", "name"]],
          "text-size": 9,
          "text-font": ["Open Sans Regular"],
          "text-offset": [0.8, 0.2],
          "text-anchor": "left",
          "text-max-width": 10,
        },
        paint: {
          "text-color": "#cbd5e1",
          "text-halo-color": "#020617",
          "text-halo-width": 0.8,
          "text-opacity": 0.7,
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
      map.addLayer({
        id: "trains-labels-layer",
        type: "symbol",
        source: "trains",
        layout: {
          "text-field": ["get", "shortLabel"],
          "text-size": 10,
          "text-font": ["Open Sans Bold"],
          "text-offset": [0, 1.4],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#f8fafc",
          "text-halo-color": "#0f172a",
          "text-halo-width": 1.2,
        },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (lastSyncMs === null) {
        setSecondsSinceSync(0);
        return;
      }
      setSecondsSinceSync(Math.floor((Date.now() - lastSyncMs) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [lastSyncMs]);

  useEffect(() => {
    let frameId: number | null = null;

    const tick = (now: number) => {
      if (lastFrameMsRef.current === null) {
        lastFrameMsRef.current = now;
      }
      const deltaSeconds = (now - lastFrameMsRef.current) / 1000;
      lastFrameMsRef.current = now;

      if (simTrainsRef.current.size === 0) {
        frameId = window.requestAnimationFrame(tick);
        return;
      }

      for (const [id, sim] of simTrainsRef.current.entries()) {
        const live = liveTrainsRef.current.get(id);
        const linePoints = linePointsRef.current.get(sim.line) ?? [];
        const lineStops = (lineStopsRef.current.get(sim.line) ??
          []) as LineStop[];

        if (sim.dwellStopId && now < sim.dwellUntilMs) {
          const dwellStop = resolveStopByIdOrNearest(
            lineStops,
            sim.dwellStopId,
            sim.lat,
            sim.lng,
          );
          if (dwellStop) {
            sim.lat = dwellStop.lat;
            sim.lng = dwellStop.lng;
            continue;
          }
          sim.dwellStopId = null;
          sim.dwellUntilMs = 0;
        }

        if (sim.dwellStopId && now >= sim.dwellUntilMs) {
          sim.dwellStopId = null;
          sim.dwellUntilMs = 0;
        }

        const nextStop = resolveStopByIdOrNearest(
          lineStops,
          sim.nextStopId,
          live?.lat ?? sim.lat,
          live?.lng ?? sim.lng,
        );
        if (nextStop) {
          const distanceToNextStop = distanceMeters(
            sim.lat,
            sim.lng,
            nextStop.lat,
            nextStop.lng,
          );

          if (
            distanceToNextStop <= STOP_ARRIVAL_RADIUS_METERS &&
            sim.lastDwelledStopId !== nextStop.id
          ) {
            audioEngine.schedulePlay({
              line: sim.line,
              note: noteForStopId(nextStop.id),
            });
            sim.dwellStopId = nextStop.id;
            sim.dwellUntilMs = now + STOP_DWELL_MS;
            sim.lastDwelledStopId = nextStop.id;
            sim.lat = nextStop.lat;
            sim.lng = nextStop.lng;
            continue;
          }

          if (
            distanceToNextStop <= STOP_CAPTURE_RADIUS_METERS &&
            sim.lastDwelledStopId !== nextStop.id
          ) {
            const movedToStop = moveTowards(
              sim.lat,
              sim.lng,
              nextStop.lat,
              nextStop.lng,
              sim.speedMps * ANIMATION_SPEED_FACTOR * deltaSeconds,
            );
            sim.lat = movedToStop.lat;
            sim.lng = movedToStop.lng;
            continue;
          }
        }

        if (linePoints.length > 1) {
          moveAlongRoute(sim, linePoints, deltaSeconds);
          continue;
        }

        if (live) {
          const moved = moveTowards(
            sim.lat,
            sim.lng,
            live.lat,
            live.lng,
            sim.speedMps * ANIMATION_SPEED_FACTOR * deltaSeconds,
          );
          sim.lat = moved.lat;
          sim.lng = moved.lng;
        } else {
          applyCoast(sim, deltaSeconds);
        }
      }

      if (now - lastPublishMsRef.current >= 120) {
        lastPublishMsRef.current = now;
        setTrains(
          Array.from(simTrainsRef.current.values()).map((sim) => ({
            direction: trainDirection(
              sim,
              linePointsRef.current.get(sim.line) ?? [],
            ),
            id: sim.id,
            line: sim.line,
            lat: sim.lat,
            lng: sim.lng,
            nextStopId: sim.nextStopId,
            nextStopName: liveTrainsRef.current.get(sim.id)?.nextStopName,
            timestamp: Date.now(),
          })),
        );
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
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

  return (
    <div className="relative h-screen w-screen">
      <div ref={mapContainerRef} className="h-full w-full" />
      <div className="absolute left-4 top-4 flex max-w-sm flex-col gap-3 rounded-lg bg-slate-900/80 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
        <h1 className="text-base font-semibold">CTA Live Trains</h1>
        <div className="flex items-center justify-between">
          <span>WebSocket</span>
          <span className={isConnected ? "text-emerald-300" : "text-amber-300"}>
            {isConnected ? "Connected" : "Reconnecting..."}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Live Trains</span>
          <span className="rounded bg-slate-700 px-2 py-1 text-xs">
            {trains.length}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Last Sync</span>
          <span className="rounded bg-sky-900/70 px-2 py-1 text-xs text-sky-100">
            {lastSyncMs === null ? "--" : `${secondsSinceSync}s ago`}
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
        <p className="text-xs text-slate-300">
          Colored CTA lines, stop tick marks, train markers, and line/stop notes
          on arrivals.
        </p>
      </div>
    </div>
  );
}
