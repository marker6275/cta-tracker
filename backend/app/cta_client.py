from __future__ import annotations

import os
import time
import xml.etree.ElementTree as ET

import httpx

from .models import CTAStop, Train

DEFAULT_LINES = ["Red", "Blue", "Brown", "Green", "Orange", "Pink", "Purple", "Yellow"]
ROUTE_CODE = {
    "Red": "red",
    "Blue": "blue",
    "Brown": "brn",
    "Green": "g",
    "Orange": "org",
    "Pink": "pink",
    "Purple": "p",
    "Yellow": "y",
}
CODE_TO_LINE = {code: line for line, code in ROUTE_CODE.items()}


class CTAClient:
    def __init__(self) -> None:
        self._api_key = os.getenv("CTA_API_KEY", "").strip()
        self._base_url = os.getenv(
            "CTA_API_BASE_URL",
            "https://lapi.transitchicago.com/api/1.0/ttpositions.aspx",
        )
        self._timeout = httpx.Timeout(10.0)
        self._fallback_stops = [
            CTAStop(id="30173", name="Howard", lat=42.019, lng=-87.673),
            CTAStop(id="41320", name="Belmont", lat=41.939, lng=-87.653),
            CTAStop(id="41450", name="Chicago", lat=41.896, lng=-87.629),
            CTAStop(id="40380", name="Clark/Lake", lat=41.885, lng=-87.630),
            CTAStop(id="40570", name="California", lat=41.922, lng=-87.697),
            CTAStop(id="40250", name="Kedzie", lat=41.804, lng=-87.705),
        ]

    async def fetch_positions(self) -> list[Train]:
        if not self._api_key:
            return self._mock_trains()

        route_codes = ",".join(ROUTE_CODE[line] for line in DEFAULT_LINES)
        params = {"key": self._api_key, "rt": route_codes, "outputType": "XML"}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(self._base_url, params=params)
            response.raise_for_status()
        return self._parse_positions_xml(response.text)

    def get_stops(self) -> list[CTAStop]:
        return self._fallback_stops

    def _parse_positions_xml(self, xml_payload: str) -> list[Train]:
        trains: list[Train] = []
        root = ET.fromstring(xml_payload)
        now = int(time.time())
        for route in root.findall(".//route"):
            route_code = (
                route.findtext("rt")
                or route.get("rt")
                or route.get("name")
                or route.findtext("name")
                or ""
            ).strip().lower()
            route_name = CODE_TO_LINE.get(route_code, "Unknown")
            for train_node in route.findall("train"):
                train = Train(
                    id=train_node.findtext("rn", default="unknown"),
                    line=route_name,
                    lat=float(train_node.findtext("lat", default="0")),
                    lng=float(train_node.findtext("lon", default="0")),
                    nextStopId=train_node.findtext("nextStaId", default=""),
                    nextStopName=train_node.findtext("nextStaNm", default=""),
                    timestamp=now,
                )
                if train.nextStopId:
                    trains.append(train)
        return trains

    def _mock_trains(self) -> list[Train]:
        now = int(time.time())
        return [
            Train(
                id="mock-red-1",
                line="Red",
                lat=41.900 + ((now % 10) * 0.001),
                lng=-87.629,
                nextStopId="41450",
                nextStopName="Chicago",
                timestamp=now,
            ),
            Train(
                id="mock-blue-1",
                line="Blue",
                lat=41.921 - ((now % 10) * 0.001),
                lng=-87.697,
                nextStopId="40570",
                nextStopName="California",
                timestamp=now,
            ),
        ]
