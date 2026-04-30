# CTA Train Map

Real-time CTA rail visualization with generative audio triggers.

## Stack

- Frontend: Next.js App Router + TypeScript + Tailwind + MapLibre GL + Tone.js (Bun)
- Backend: FastAPI + WebSockets + CTA polling/arrival detection (Python)

## Project layout

```text
cta/
  frontend/
  backend/
  shared/
```

## Frontend setup (Bun)

```bash
cd frontend
cp .env.example .env.local
bun install
bun run dev
```

Open http://localhost:3000.

No Mapbox token is required. The map uses MapLibre with a public dark basemap style by default.

## Backend setup (FastAPI)

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

`CTA_API_KEY` is optional in development. If omitted, backend emits mock train updates.
Default poll interval is 15s (`POLL_INTERVAL_SECONDS`).

## Generate real CTA line geometry (GTFS)

Run this once (or when CTA updates static feed) to build real map lines/stops:

```bash
cd backend
python scripts/build_gtfs_static.py
```

This overwrites `frontend/src/data/cta-static.json` with GTFS-derived routes and stops.

## What is implemented

- Fullscreen map with CTA line polylines and station markers
- Real-time train marker updates via WebSocket events
- Arrival detection using:
  - distance < 75m and previous distance > 75m
  - 60s per train/stop debounce
- Tone.js instrument mapping per line
- Note mapping from latitude (required scale mapping)
- Audio controls:
  - enable/mute toggle
  - master volume
  - event density limiter (max 5 notes/sec)
  - quantized scheduling with `Tone.Transport.scheduleOnce(..., "+0.1")`

## Notes

- Use `backend/scripts/build_gtfs_static.py` to refresh full route/stop data from GTFS.
- Add station pulse and line highlight animations in the map layer styles for polish phase.
