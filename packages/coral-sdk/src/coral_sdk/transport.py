# packages/coral-sdk/src/coral_sdk/transport.py
# subprocess-free Transport protocol so a later serve backend can reuse types

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Protocol


class Transport(Protocol):
    """One coral exec invocation as start / NDJSON objects / cancel / wait."""

    # spawn the child with an argv array; never a shell string
    async def start(self, argv: Sequence[str], env: Mapping[str, str]) -> None: ...

    # yield each stdout JSON object; non-JSON lines are protocol errors
    def events(self) -> AsyncIterator[dict[str, object]]: ...

    # SIGINT the child; a later wait() reports the real exit code
    def cancel(self) -> None: ...

    # return the child's exit code, mapping signal deaths to 128+N
    async def wait(self) -> int: ...
