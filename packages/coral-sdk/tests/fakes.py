# packages/coral-sdk/tests/fakes.py
# in-memory Transport and repo-root helpers for recorded-NDJSON tests

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
import json


# walk up from this test module to the coral checkout
def repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "protocol" / "fixtures").is_dir() and (
            parent / "package.json"
        ).is_file():
            return parent
    raise RuntimeError("coral repo root not found from coral_sdk tests")


# recorded NDJSON next to this helper module
def recordings_dir() -> Path:
    return Path(__file__).resolve().parent / "recordings"


# skip blank lines; keep the raw JSON text for FakeTransport
def load_ndjson(path: Path) -> list[str]:
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.strip():
            lines.append(raw)
    return lines


class FakeTransport:
    def __init__(
        self,
        lines: Sequence[str],
        *,
        exit_code: int = 0,
        fail_start: OSError | None = None,
    ) -> None:
        self.lines = list(lines)
        self.exit_code = exit_code
        self.fail_start = fail_start
        self.argv: list[str] | None = None
        self.env: dict[str, str] | None = None
        self.cancelled = False
        self._started = False
        self.stderr_text = ""

    async def start(self, argv: Sequence[str], env: Mapping[str, str]) -> None:
        if self.fail_start is not None:
            raise self.fail_start
        self.argv = list(argv)
        self.env = dict(env)
        self._started = True

    async def events(self) -> AsyncIterator[dict[str, object]]:
        if not self._started:
            raise RuntimeError("transport has not started")
        for line in self.lines:
            yield json.loads(line)

    def cancel(self) -> None:
        self.cancelled = True

    async def wait(self) -> int:
        return self.exit_code
