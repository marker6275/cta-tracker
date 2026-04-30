from __future__ import annotations

from fastapi import WebSocket


class WebSocketManager:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)

    async def broadcast(self, event: dict) -> None:
        dead_clients: list[WebSocket] = []
        for client in self._clients:
            try:
                await client.send_json(event)
            except Exception:
                dead_clients.append(client)

        for client in dead_clients:
            self.disconnect(client)

    @property
    def clients_count(self) -> int:
        return len(self._clients)
