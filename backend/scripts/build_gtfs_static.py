#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import re
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

GTFS_URL = "https://www.transitchicago.com/downloads/sch_data/google_transit.zip"
USER_AGENT = "Mozilla/5.0 (compatible; CTA-Music-Map/1.0)"
LINE_NAMES = ["Red", "Blue", "Brown", "Green", "Orange", "Pink", "Purple", "Yellow"]
ROUTE_ID_TO_LINE: dict[str, str] = {}
LINE_COLORS = {
    "Red": "#C60C30",
    "Blue": "#00A1DE",
    "Brown": "#62361B",
    "Green": "#009B3A",
    "Orange": "#F9461C",
    "Pink": "#E27EA6",
    "Purple": "#522398",
    "Yellow": "#F9E300",
}


def read_csv_from_zip(zip_file: zipfile.ZipFile, filename: str) -> list[dict[str, str]]:
    with zip_file.open(filename) as handle:
        text = handle.read().decode("utf-8-sig").splitlines()
    return list(csv.DictReader(text))


def pick_primary_shape_ids(trips: list[dict[str, str]]) -> dict[str, str]:
    """Pick the most frequent shape_id for each route_id."""
    counter: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for trip in trips:
        route_id = trip.get("route_id", "")
        shape_id = trip.get("shape_id", "")
        if not route_id or not shape_id:
            continue
        if route_id not in ROUTE_ID_TO_LINE:
            continue
        counter[route_id][shape_id] += 1

    primary: dict[str, str] = {}
    for route_id, shape_counts in counter.items():
        primary[route_id] = max(shape_counts.items(), key=lambda item: item[1])[0]
    return primary


def build_shapes(
    shapes_rows: list[dict[str, str]],
    primary_shape_ids: dict[str, str],
) -> dict[str, list[list[float]]]:
    shape_points: dict[str, list[tuple[int, list[float]]]] = defaultdict(list)
    for row in shapes_rows:
        shape_id = row.get("shape_id", "")
        if not shape_id:
            continue
        sequence = int(row.get("shape_pt_sequence", "0"))
        lat = float(row.get("shape_pt_lat", "0"))
        lon = float(row.get("shape_pt_lon", "0"))
        shape_points[shape_id].append((sequence, [lon, lat]))

    line_to_coords: dict[str, list[list[float]]] = {}
    for route_id, shape_id in primary_shape_ids.items():
        line = ROUTE_ID_TO_LINE.get(route_id)
        if not line:
            continue
        ordered = sorted(shape_points.get(shape_id, []), key=lambda item: item[0])
        if len(ordered) < 2:
            continue
        line_to_coords[line] = [point for _, point in ordered]
    return line_to_coords


def build_stop_lines(
    stop_times: list[dict[str, str]],
    trips: list[dict[str, str]],
) -> dict[str, set[str]]:
    trip_to_line: dict[str, str] = {}
    for trip in trips:
        route_id = trip.get("route_id", "")
        trip_id = trip.get("trip_id", "")
        if route_id not in ROUTE_ID_TO_LINE or not trip_id:
            continue
        line = ROUTE_ID_TO_LINE.get(route_id)
        if line:
            trip_to_line[trip_id] = line

    stop_lines: dict[str, set[str]] = defaultdict(set)
    for row in stop_times:
        stop_id = row.get("stop_id", "")
        trip_id = row.get("trip_id", "")
        line = trip_to_line.get(trip_id)
        if stop_id and line:
            stop_lines[stop_id].add(line)
    return stop_lines


def build_output_json(
    routes: dict[str, list[list[float]]],
    stops_rows: list[dict[str, str]],
    stop_lines: dict[str, set[str]],
) -> dict:
    output_routes = []
    for line in LINE_NAMES:
        coords = routes.get(line)
        if not coords:
            continue
        output_routes.append(
            {
                "line": line,
                "color": LINE_COLORS[line],
                "coordinates": coords,
                "segments": [coords],
            }
        )

    output_stops = []
    for stop in stops_rows:
        stop_id = stop.get("stop_id", "")
        lines = stop_lines.get(stop_id)
        if not lines:
            continue
        output_stops.append(
            {
                "id": stop_id,
                "name": stop.get("stop_name", ""),
                "lat": float(stop.get("stop_lat", "0")),
                "lng": float(stop.get("stop_lon", "0")),
                "lines": sorted(lines),
            }
        )

    return {"routes": output_routes, "stops": output_stops}


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z]", "", value.lower())


def infer_route_id_to_line(routes_rows: list[dict[str, str]]) -> dict[str, str]:
    route_map: dict[str, str] = {}
    color_lookup = {v.lower().replace("#", ""): k for k, v in LINE_COLORS.items()}

    for row in routes_rows:
        # GTFS route_type 1 = subway/metro. This excludes bus routes.
        route_type = row.get("route_type", "").strip()
        if route_type != "1":
            continue

        route_id = row.get("route_id", "")
        if not route_id:
            continue
        text = " ".join(
            [
                row.get("route_id", ""),
                row.get("route_short_name", ""),
                row.get("route_long_name", ""),
                row.get("route_desc", ""),
            ]
        )
        normalized = _normalize(text)
        line_match = None
        for line in LINE_NAMES:
            if _normalize(line) in normalized:
                line_match = line
                break

        if line_match is None:
            route_color = row.get("route_color", "").lower().replace("#", "")
            line_match = color_lookup.get(route_color)

        if line_match:
            route_map[route_id] = line_match

    return route_map


def main() -> None:
    global ROUTE_ID_TO_LINE
    repo_root = Path(__file__).resolve().parents[2]
    output_path = repo_root / "frontend" / "src" / "data" / "cta-static.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temp_dir:
        zip_path = Path(temp_dir) / "google_transit.zip"
        print(f"Downloading GTFS from {GTFS_URL}...")
        request = urllib.request.Request(GTFS_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request) as response:
            zip_path.write_bytes(response.read())

        with zipfile.ZipFile(zip_path) as archive:
            routes_rows = read_csv_from_zip(archive, "routes.txt")
            trips = read_csv_from_zip(archive, "trips.txt")
            shapes_rows = read_csv_from_zip(archive, "shapes.txt")
            stops_rows = read_csv_from_zip(archive, "stops.txt")
            stop_times = read_csv_from_zip(archive, "stop_times.txt")

    ROUTE_ID_TO_LINE = infer_route_id_to_line(routes_rows)
    if not ROUTE_ID_TO_LINE:
        raise RuntimeError("Could not infer CTA rail routes from routes.txt")

    primary_shape_ids = pick_primary_shape_ids(trips)
    line_shapes = build_shapes(shapes_rows, primary_shape_ids)
    stop_lines = build_stop_lines(stop_times, trips)
    output_data = build_output_json(line_shapes, stops_rows, stop_lines)

    output_path.write_text(json.dumps(output_data, indent=2), encoding="utf-8")
    print(
        f"Wrote {output_path} with {len(output_data['routes'])} routes "
        f"and {len(output_data['stops'])} stops."
    )


if __name__ == "__main__":
    main()
