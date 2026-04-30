from __future__ import annotations

from pydantic import BaseModel


class Train(BaseModel):
    id: str
    line: str
    lat: float
    lng: float
    nextStopId: str
    nextStopName: str | None = None
    timestamp: int


class ArrivalEvent(BaseModel):
    type: str = "arrival"
    line: str
    stopId: str
    timestamp: int


class TrainUpdateEvent(BaseModel):
    type: str = "train_update"
    trains: list[Train]
    timestamp: int


class CTAStop(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
