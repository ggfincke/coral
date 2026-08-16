# packages/coral-sdk/src/coral_sdk/subprocess.py
# discover the coral binary and spawn exec as an argv array, never a shell

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
import asyncio
import errno
import json
import os
import shutil
import signal

from coral_sdk.errors import CoralBinaryError, CoralProtocolError, CoralUsageError

# StreamReader default (64 KiB) is below MCP/tool output caps
_STDOUT_LIMIT = 16 * 1024 * 1024


# map posix -N signal deaths to the 128+N codes docs/cli.md documents
def normalize_exit_code(code: int | None) -> int:
    if code is None:
        return -1
    if code < 0:
        return 128 + (-code)
    return code


def _node_command(script: Path, env: Mapping[str, str]) -> list[str]:
    node = shutil.which("node", path=env.get("PATH"))
    if node is None:
        raise CoralBinaryError(
            "node not found on PATH; coral exec needs Node >= 24"
        )
    return [node, str(script)]


def _tsx_command(script: Path, env: Mapping[str, str]) -> list[str]:
    tsx = shutil.which("tsx", path=env.get("PATH"))
    if tsx is None:
        for parent in script.parents:
            local = parent / "node_modules" / ".bin" / "tsx"
            if local.is_file():
                tsx = str(local)
                break
    if tsx is None:
        raise CoralBinaryError(
            "tsx not found; run npm run build and point CORAL_BIN at "
            "dist/cli/main.js, or install tsx on PATH"
        )
    return [tsx, str(script)]


def _is_coral_checkout(path: Path) -> bool:
    package_json = path / "package.json"
    if not package_json.is_file():
        return False
    dist = path / "dist" / "cli" / "main.js"
    src = path / "src" / "cli" / "main.tsx"
    if not dist.is_file() and not src.is_file():
        return False
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return data.get("name") == "coral"


def find_coral_checkout() -> Path | None:
    package_file = Path(__file__).resolve()
    for parent in [package_file.parent, *package_file.parents]:
        if _is_coral_checkout(parent):
            return parent
    return None


def _command_for_bin_path(path: Path, env: Mapping[str, str]) -> list[str]:
    suffix = path.suffix.lower()
    if suffix == ".js":
        return _node_command(path, env)
    if suffix in {".ts", ".tsx"}:
        return _tsx_command(path, env)
    if path.is_file():
        return [str(path)]
    found = shutil.which(str(path), path=env.get("PATH"))
    if found:
        return [found]
    return [str(path)]


# CORAL_BIN -> PATH `coral` -> trusted checkout dist or locally installed tsx source
def discover_coral_command(
    explicit: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> list[str]:
    environ = os.environ if env is None else env
    if explicit is not None:
        return _command_for_bin_path(Path(str(explicit)).expanduser(), environ)
    coral_bin = environ.get("CORAL_BIN")
    if coral_bin:
        return _command_for_bin_path(Path(coral_bin).expanduser(), environ)
    on_path = shutil.which("coral", path=environ.get("PATH"))
    if on_path:
        return [on_path]
    checkout = find_coral_checkout()
    if checkout is not None:
        dist = checkout / "dist" / "cli" / "main.js"
        if dist.is_file():
            return _node_command(dist, environ)
        src = checkout / "src" / "cli" / "main.tsx"
        if src.is_file():
            return _tsx_command(src, environ)
    raise CoralBinaryError(
        "coral executable not found; set CORAL_BIN, put `coral` on PATH, "
        "or run from a coral checkout (npm run build -> dist/cli/main.js; "
        "Node >= 24)"
    )


class SubprocessTransport:
    """Spawn `coral exec --output-format stream-json` and parse stdout NDJSON."""

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[bytes] | None = None
        self._stderr = b""

    @property
    def stderr_text(self) -> str:
        return self._stderr.decode("utf-8", errors="replace")

    async def start(self, argv: Sequence[str], env: Mapping[str, str]) -> None:
        if self._proc is not None:
            raise CoralProtocolError("transport already started")
        if not argv:
            raise CoralBinaryError("empty argv")
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=dict(env),
                limit=_STDOUT_LIMIT,
            )
        except FileNotFoundError as exc:
            raise CoralBinaryError(
                f"failed to spawn {argv[0]!r}: {exc}"
            ) from exc
        except OSError as exc:
            if exc.errno == errno.E2BIG:
                raise CoralUsageError(
                    "prompt too large for argv; pass prompt_file=True"
                ) from exc
            raise CoralBinaryError(
                f"failed to spawn {argv[0]!r}: {exc}"
            ) from exc
        assert self._proc.stderr is not None
        self._stderr_task = asyncio.create_task(self._proc.stderr.read())

    async def events(self) -> AsyncIterator[dict[str, object]]:
        if self._proc is None or self._proc.stdout is None:
            raise CoralProtocolError("transport has not started")
        while True:
            raw = await self._proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8")
            if line.endswith("\n"):
                line = line[:-1]
            if line.endswith("\r"):
                line = line[:-1]
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CoralProtocolError(
                    f"malformed NDJSON from coral exec: {line[:200]!r}"
                ) from exc
            if not isinstance(parsed, dict):
                raise CoralProtocolError(
                    "exec event is not a JSON object: "
                    f"{type(parsed).__name__}"
                )
            yield parsed

    def cancel(self) -> None:
        if self._proc is None or self._proc.returncode is not None:
            return
        try:
            self._proc.send_signal(signal.SIGINT)
        except ProcessLookupError:
            return
        except OSError:
            try:
                self._proc.terminate()
            except (ProcessLookupError, OSError):
                return

    async def wait(self) -> int:
        if self._proc is None:
            raise CoralProtocolError("transport has not started")
        code = await self._proc.wait()
        if self._stderr_task is not None:
            try:
                self._stderr = await self._stderr_task
            except Exception:
                self._stderr = b""
            self._stderr_task = None
        return normalize_exit_code(code)
