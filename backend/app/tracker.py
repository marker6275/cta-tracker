from __future__ import annotations

import math
import time
from collections.abc import Iterable

from .models import ArrivalEvent, CTAStop, Train

ARRIVAL_DISTANCE_METERS = 75.0
DEBOUNCE_SECONDS = 60


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius * c


class ArrivalTracker:
    def __init__(self, stops_by_id: dict[str, CTAStop]) -> None:
        self._stops_by_id = stops_by_id
        self._previous_distance: dict[str, float] = {}
        self._recent_arrivals: dict[tuple[str, str], int] = {}

    def detect_arrivals(self, trains: Iterable[Train]) -> list[ArrivalEvent]:
        now = int(time.time())
        arrivals: list[ArrivalEvent] = []

        for train in trains:
            stop = self._stops_by_id.get(train.nextStopId)
            if stop is None:
                continue

            train_key = f"{train.id}:{train.nextStopId}"
            distance = haversine_meters(train.lat, train.lng, stop.lat, stop.lng)
            previous_distance = self._previous_distance.get(train_key, 10_000)
            self._previous_distance[train_key] = distance

            crossed_threshold = (
                distance < ARRIVAL_DISTANCE_METERS
                and previous_distance > ARRIVAL_DISTANCE_METERS
            )
            if not crossed_threshold:
                continue

            dedupe_key = (train.id, train.nextStopId)
            last_triggered = self._recent_arrivals.get(dedupe_key, 0)
            if now - last_triggered < DEBOUNCE_SECONDS:
                continue

            self._recent_arrivals[dedupe_key] = now
            arrivals.append(
                ArrivalEvent(
                    line=train.line,
                    stopId=train.nextStopId,
                    timestamp=now,
                )
            )

        return arrivals
