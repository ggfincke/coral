# packages/coral-backend/src/coral_backend/stream.py
# split streamed model text into content / thinking / indexed tool_call deltas

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from coral_backend.errors import WorkerError
from coral_backend.tools import (
    ParsedToolCall,
    detect_family,
    delims_for,
    parse_partial_tool_region,
    parse_tool_region,
    unsupported_marker_in,
    SUPPORTED_FAMILIES,
)


@dataclass
class StreamDelta:
    """One Ollama-dialect message delta emitted while generation is in flight."""

    content: str = ""
    thinking: str = ""
    tool_calls: list[dict[str, Any]] | None = None


@dataclass
class OutputSplitter:
    """Prefix-safe splitter that assigns function.index on every partial tool chunk."""

    family: str
    _buf: str = ""
    _mode: str = "content"
    _tool_start: str = ""
    _tool_end: str = ""
    _think_end: str = ""
    _tool_index: int = 0
    _last_partial: ParsedToolCall | None = None
    _needles: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        delims = delims_for(self.family)
        starts = [pair[0] for pair in delims.tool_pairs] + [pair[0] for pair in delims.think_pairs]
        self._needles = tuple(starts)

    def feed(self, text: str) -> list[StreamDelta]:
        if not text:
            return []
        self._buf += text
        return self._drain(final=False)

    def finish(self) -> list[StreamDelta]:
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> list[StreamDelta]:
        out: list[StreamDelta] = []
        while self._buf:
            if self._mode == "content":
                delta = self._drain_content(final=final)
                if delta is None:
                    break
                out.extend(delta)
            elif self._mode == "thinking":
                delta = self._drain_until(self._think_end, "thinking", final=final)
                if delta is None:
                    break
                out.extend(delta)
            else:
                delta = self._drain_tool(final=final)
                if delta is None:
                    break
                out.extend(delta)
        if final and self._buf:
            if self._mode == "thinking":
                out.append(StreamDelta(thinking=self._buf))
            elif self._mode == "tool":
                out.extend(self._close_tool(self._buf, partial=False))
            else:
                self._reject_unsupported(self._buf)
                out.append(StreamDelta(content=self._buf))
            self._buf = ""
        return [item for item in out if item.content or item.thinking or item.tool_calls]

    def _reject_unsupported(self, text: str) -> None:
        if self.family in SUPPORTED_FAMILIES or not text:
            return
        marker = unsupported_marker_in(text)
        if marker:
            raise WorkerError(
                "unsupported_tool_family",
                f"saw {marker!r} but tool-call parsing is only implemented for gemma/qwen",
            )

    def _drain_content(self, *, final: bool) -> list[StreamDelta] | None:
        match = _earliest(self._buf, self._needles)
        if match is None:
            if final:
                chunk = self._buf
                self._buf = ""
                self._reject_unsupported(chunk)
                return [StreamDelta(content=chunk)] if chunk else []
            flush = _safe_flush(self._buf, self._needles)
            if not flush:
                return None
            chunk, self._buf = self._buf[:flush], self._buf[flush:]
            self._reject_unsupported(chunk)
            return [StreamDelta(content=chunk)] if chunk else []
        index, needle = match
        before = self._buf[:index]
        self._buf = self._buf[index + len(needle) :]
        self._enter(needle)
        self._reject_unsupported(before)
        return [StreamDelta(content=before)] if before else []

    def _drain_until(self, end: str, field: str, *, final: bool) -> list[StreamDelta] | None:
        index = self._buf.find(end)
        if index < 0:
            if final:
                return None
            flush = _safe_flush(self._buf, (end,))
            if not flush:
                return None
            chunk, self._buf = self._buf[:flush], self._buf[flush:]
            if not chunk:
                return []
            return [StreamDelta(**{field: chunk})]
        chunk = self._buf[:index]
        self._buf = self._buf[index + len(end) :]
        self._mode = "content"
        self._think_end = ""
        return [StreamDelta(**{field: chunk})] if chunk else []

    def _drain_tool(self, *, final: bool) -> list[StreamDelta] | None:
        index = self._buf.find(self._tool_end)
        if index < 0:
            if final:
                return None
            partial = parse_partial_tool_region(self._buf, self._tool_start, self.family)
            if partial is not None and partial != self._last_partial:
                self._last_partial = partial
                return [_tool_delta(self._tool_index, partial)]
            return None
        body = self._buf[:index]
        self._buf = self._buf[index + len(self._tool_end) :]
        deltas = self._close_tool(body, partial=False)
        self._mode = "content"
        self._tool_start = ""
        self._tool_end = ""
        self._last_partial = None
        self._tool_index += 1
        return deltas

    def _close_tool(self, body: str, *, partial: bool) -> list[StreamDelta]:
        if partial:
            parsed = parse_partial_tool_region(body, self._tool_start, self.family)
            if parsed is None:
                return []
            return [_tool_delta(self._tool_index, parsed)]
        calls = parse_tool_region(body, self._tool_start, self.family)
        deltas: list[StreamDelta] = []
        for offset, call in enumerate(calls):
            deltas.append(_tool_delta(self._tool_index + offset, call))
        if len(calls) > 1:
            self._tool_index += len(calls) - 1
        return deltas

    def _enter(self, needle: str) -> None:
        delims = delims_for(self.family)
        for start, end in delims.think_pairs:
            if needle == start:
                self._mode = "thinking"
                self._think_end = end
                return
        for start, end in delims.tool_pairs:
            if needle == start:
                if self.family == "unknown":
                    raise WorkerError(
                        "unsupported_tool_family",
                        "tool-call parsing is only implemented for gemma/qwen",
                    )
                marker = unsupported_marker_in(needle)
                if marker:
                    raise WorkerError(
                        "unsupported_tool_family",
                        f"saw {marker!r}; not a gemma/qwen tool dialect",
                    )
                self._mode = "tool"
                self._tool_start = start
                self._tool_end = end
                return
        raise WorkerError("tool_parse_failed", f"unknown delimiter {needle!r}")


def _tool_delta(index: int, call: ParsedToolCall) -> StreamDelta:
    return StreamDelta(
        tool_calls=[
            {
                "type": "function",
                "function": {
                    "index": index,
                    "name": call.name,
                    "arguments": call.arguments,
                },
            }
        ]
    )


def _earliest(text: str, needles: tuple[str, ...]) -> tuple[int, str] | None:
    best: tuple[int, str] | None = None
    for needle in needles:
        if not needle:
            continue
        index = text.find(needle)
        if index < 0:
            continue
        if best is None or index < best[0] or (index == best[0] and len(needle) > len(best[1])):
            best = (index, needle)
    return best


def _safe_flush(buf: str, needles: tuple[str, ...]) -> int:
    keep = 0
    for needle in needles:
        if not needle:
            continue
        for size in range(1, min(len(needle), len(buf)) + 1):
            if buf.endswith(needle[:size]):
                keep = max(keep, size)
    return len(buf) - keep


def family_for_model(model_name: str, architecture: str | None = None) -> str:
    return detect_family(model_name, architecture)
