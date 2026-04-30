from __future__ import annotations

import asyncio
import os
import time
from contextlib import suppress

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .cta_client import CTAClient
from .models import TrainUpdateEvent
from .tracker import ArrivalTracker
from .websocket_manager import WebSocketManager

load_dotenv()

POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "15"))

app = FastAPI(title="CTA Music Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

socket_manager = WebSocketManager()
cta_client = CTAClient()
arrival_tracker = ArrivalTracker({stop.id: stop for stop in cta_client.get_stops()})
poller_task: asyncio.Task | None = None


async def poll_and_broadcast() -> None:
    while True:
        try:
            trains = await cta_client.fetch_positions()
            used_labels: set[str] = set()
            collision_counts: dict[str, int] = {}
            label_to_train: dict[str, dict] = {}
            for train in trains:
                line_initial = (train.line[:1] or "T").upper()
                id_token = next((char.upper() for char in train.id if char.isalnum()), "0")
                base = f"{line_initial}{id_token}"
                label = base
                if label in used_labels:
                    next_index = collision_counts.get(base, 1) + 1
                    collision_counts[base] = next_index
                    label = f"{base}{next_index}"
                used_labels.add(label)
                label_to_train[label] = {
                    "trainId": train.id,
                    "lat": train.lat,
                    "lng": train.lng,
                    "next_stop_id": train.nextStopId,
                }
            train_update = TrainUpdateEvent(trains=trains, timestamp=int(time.time()))
            await socket_manager.broadcast(train_update.model_dump())

            arrivals = arrival_tracker.detect_arrivals(trains)
            for arrival in arrivals:
                await socket_manager.broadcast(arrival.model_dump())
        except Exception as exc:
            print(f"[poller] failed: {exc}")

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


@app.on_event("startup")
async def on_startup() -> None:
    global poller_task
    poller_task = asyncio.create_task(poll_and_broadcast())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global poller_task
    if poller_task:
        poller_task.cancel()
        with suppress(asyncio.CancelledError):
            await poller_task
    poller_task = None


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "clients": socket_manager.clients_count}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await socket_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        socket_manager.disconnect(websocket)
    except Exception:
        socket_manager.disconnect(websocket)
