# packages/coral-sdk/src/coral_sdk/sync.py
# thin asyncio wrapper around CoralClient; does not reimplement transport

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator
from types import TracebackType
import asyncio

from coral_sdk.client import CoralClient
from coral_sdk.events import CoralExecEvent, CoralExecResult


class SyncCoralClient:
    """Blocking facade that drives CoralClient on one dedicated event loop."""

    def __init__(self, client: CoralClient) -> None:
        self._async = client
        self._loop: asyncio.AbstractEventLoop | None = None
        self._streams: set[AsyncGenerator[CoralExecEvent, None]] = set()

    def __enter__(self) -> SyncCoralClient:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(self._async.__aenter__())
        except BaseException:
            loop.close()
            self._loop = None
            raise
        self._loop = loop
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            for stream in tuple(self._streams):
                loop.run_until_complete(stream.aclose())
            self._streams.clear()
            loop.run_until_complete(self._async.__aexit__(exc_type, exc, tb))
        finally:
            loop.close()
            self._loop = None

    def _require_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            raise RuntimeError("SyncCoralClient must be used as a context manager")
        return self._loop

    def cancel(self) -> None:
        self._async.cancel()

    def run(self, prompt: str) -> CoralExecResult:
        return self._require_loop().run_until_complete(self._async.run(prompt))

    def stream(self, prompt: str) -> Iterator[CoralExecEvent]:
        loop = self._require_loop()
        agen = self._async.stream(prompt)
        self._streams.add(agen)
        try:
            while True:
                try:
                    yield loop.run_until_complete(agen.__anext__())
                except StopAsyncIteration:
                    break
        finally:
            self._streams.discard(agen)
            if not loop.is_closed():
                loop.run_until_complete(agen.aclose())
