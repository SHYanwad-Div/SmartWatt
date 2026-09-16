"""WebSocket fan-out hub.

The ingest pipeline runs on a worker thread; FastAPI's WebSockets live on the
event loop. `broadcast_threadsafe` bridges the two.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger("smartwatt.hub")


class Hub:
    def __init__(self) -> None:
        self._clients: dict[str, set[WebSocket]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, device_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._clients[device_id].add(ws)

    def disconnect(self, device_id: str, ws: WebSocket) -> None:
        self._clients[device_id].discard(ws)

    def client_count(self, device_id: str | None = None) -> int:
        if device_id is None:
            return sum(len(v) for v in self._clients.values())
        return len(self._clients[device_id])

    async def broadcast(self, device_id: str, payload: dict) -> None:
        targets = list(self._clients.get(device_id, ()))
        if not targets:
            return
        text = json.dumps(payload, default=str)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(device_id, ws)

    def broadcast_threadsafe(self, device_id: str, payload: dict) -> None:
        """Callable from the ingest worker thread."""
        if self._loop is None or not self._clients.get(device_id):
            return
        try:
            asyncio.run_coroutine_threadsafe(self.broadcast(device_id, payload), self._loop)
        except RuntimeError:  # loop closed during shutdown
            pass


hub = Hub()
