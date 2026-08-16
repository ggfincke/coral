# packages/coral-backend/src/coral_backend/server.py
# ndjson envelope loop: handshake, chat.start, model.list/show, embed, cancel

from __future__ import annotations

from pathlib import Path
from typing import Any, BinaryIO, TextIO
import json
import sys
import threading
import traceback

from pydantic import ValidationError

from coral_backend.backend import GenerationBackend, load_backend
from coral_backend.chat import run_chat
from coral_backend.config import (
    HANDSHAKE_METHOD,
    MAX_FRAME_BYTES,
    PHASE2_METHODS,
    PROTOCOL_VERSION,
    resolve_models_dir,
)
from coral_backend.errors import WorkerError
from coral_backend.models import list_models, show_model
from coral_backend.protocol import (
    ENVELOPE_BY_KIND,
    ChatRequest,
    ChatResponse,
    EmbedRequest,
    EmbedResult,
    EnvelopeCancel,
    EnvelopeError,
    EnvelopeErrorPayload,
    EnvelopeEvent,
    EnvelopePayload,
    EnvelopeRequest,
    EnvelopeResult,
    HandshakeRequest,
    HandshakeResult,
    HandshakeVersions,
    ModelListRequest,
    ModelShowRequest,
)

MALFORMED_ID = "malformed"


class Worker:
    """Persistent stdio worker. stdout is protocol-only; human logs go to stderr."""

    def __init__(
        self,
        backend: GenerationBackend,
        stdin: BinaryIO,
        stdout: BinaryIO,
        stderr: TextIO,
    ) -> None:
        self.backend = backend
        self.stdin = stdin
        self.stdout = stdout
        self.stderr = stderr
        self.handshook = False
        self.models_dir: Path | None = None
        self.reader = FrameReader(stdin, MAX_FRAME_BYTES)
        self._stdout_lock = threading.Lock()
        self._active_id: str | None = None
        self._cancel = threading.Event()
        self._busy = threading.Lock()

    def run(self) -> None:
        while True:
            frame = self.reader.read()
            if frame is None:
                return
            line, over_limit = frame
            self._handle_line(line, over_limit=over_limit)

    def _handle_line(self, line: bytes, *, over_limit: bool) -> None:
        if over_limit:
            request_id = _peek_id(line) or MALFORMED_ID
            if self._active_id == request_id:
                self._cancel.set()
            self._emit_error(
                request_id,
                "over_limit",
                f"frame exceeds {MAX_FRAME_BYTES} bytes",
            )
            return
        if not line.strip():
            return
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            self._emit_error(MALFORMED_ID, "malformed_frame", "frame is not valid utf-8")
            return
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            self._emit_error(MALFORMED_ID, "malformed_frame", f"invalid JSON: {exc.msg}")
            return
        if not isinstance(parsed, dict):
            self._emit_error(MALFORMED_ID, "malformed_frame", "frame must be a JSON object")
            return
        request_id = _id_from(parsed) or MALFORMED_ID
        try:
            frame = parse_envelope(parsed)
        except WorkerError as exc:
            self._emit_error(request_id, exc.code, exc.message)
            return
        except ValidationError as exc:
            self._emit_error(request_id, "schema_failure", _validation_message(exc))
            return
        try:
            self._dispatch(frame)
        except WorkerError as exc:
            method = getattr(frame, "method", None)
            self._emit_error(getattr(frame, "id", request_id), exc.code, exc.message, method)
        except Exception as exc:
            traceback.print_exc(file=self.stderr)
            method = getattr(frame, "method", None)
            self._emit_error(
                getattr(frame, "id", request_id),
                "internal",
                str(exc),
                method,
            )

    def _dispatch(self, frame: object) -> None:
        if isinstance(frame, EnvelopeCancel):
            self._handle_cancel(frame)
            return
        if not isinstance(frame, EnvelopeRequest):
            raise WorkerError("schema_failure", "worker stdin accepts request and cancel only")
        if frame.v != PROTOCOL_VERSION:
            raise WorkerError(
                "protocol_version",
                f"unknown protocol major {frame.v}; worker speaks v={PROTOCOL_VERSION}",
            )
        if not self.handshook and frame.method != HANDSHAKE_METHOD:
            raise WorkerError(
                "handshake_required",
                "handshake must be the first request after spawn",
            )
        if frame.method == HANDSHAKE_METHOD:
            self._handle_handshake(frame)
            return
        if frame.method not in PHASE2_METHODS:
            raise WorkerError(
                "unknown_method",
                f"method {frame.method!r} is not advertised",
            )
        if frame.method == "chat.start":
            self._handle_chat(frame)
            return
        if frame.method == "model.list":
            self._handle_list(frame)
            return
        if frame.method == "embed":
            self._handle_embed(frame)
            return
        self._handle_show(frame)

    def _handle_handshake(self, frame: EnvelopeRequest) -> None:
        payload = _payload_dict(frame.payload)
        try:
            request = HandshakeRequest.model_validate(payload)
        except ValidationError as exc:
            raise WorkerError("schema_failure", _validation_message(exc)) from exc
        if request.protocolVersion != PROTOCOL_VERSION:
            raise WorkerError(
                "protocol_version",
                f"handshake protocolVersion {request.protocolVersion} is not {PROTOCOL_VERSION}",
            )
        handshake_dir = request.modelsDir or _optional_str(
            payload, "mlxModelsDir", "models_dir", "mlx_models_dir"
        )
        self.models_dir = resolve_models_dir(handshake_dir)
        self.handshook = True
        result = HandshakeResult(
            protocolVersion=PROTOCOL_VERSION,
            methods=list(PHASE2_METHODS),
            versions=_versions(),
        )
        self._emit_result(frame.id, frame.method, result.model_dump(exclude_none=True))

    def _handle_chat(self, frame: EnvelopeRequest) -> None:
        if not self._busy.acquire(blocking=False):
            raise WorkerError(
                "busy",
                f"generation already in flight for {self._active_id}",
            )
        try:
            try:
                request = ChatRequest.model_validate(_payload_dict(frame.payload))
            except ValidationError as exc:
                raise WorkerError("schema_failure", _validation_message(exc)) from exc
            self._active_id = frame.id
            self._cancel = threading.Event()
            finished = threading.Event()
            error: list[BaseException] = []
            result_payload: list[dict[str, object]] = [{}]

            def emit(response: ChatResponse) -> None:
                self._emit_event(
                    frame.id,
                    frame.method,
                    response.model_dump(exclude_none=True),
                )

            def work() -> None:
                try:
                    result_payload[0] = run_chat(
                        request,
                        self.backend,
                        cancel=self._cancel,
                        models_dir=self.models_dir,
                        emit=emit,
                    )
                except BaseException as exc:
                    error.append(exc)
                finally:
                    finished.set()

            thread = threading.Thread(target=work, name="coral-chat", daemon=True)
            thread.start()
            self._pump_until(finished)
            thread.join()
            if error:
                raise error[0]
            self._emit_result(frame.id, frame.method, result_payload[0])
        finally:
            self._active_id = None
            self._cancel = threading.Event()
            self._busy.release()

    def _pump_until(self, finished: threading.Event) -> None:
        # * share FrameReader so a cancel that arrived in the same stdin burst is not stuck
        while not finished.is_set():
            if finished.wait(timeout=0.02):
                return
            incoming = self.reader.read(timeout=0.0)
            if incoming is None:
                if self.reader.eof:
                    self._cancel.set()
                    return
                continue
            line, over_limit = incoming
            if over_limit or not line.strip():
                self._handle_line(line, over_limit=over_limit)
                continue
            try:
                parsed = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._handle_line(line, over_limit=False)
                continue
            if isinstance(parsed, dict) and parsed.get("kind") == "cancel":
                try:
                    cancel = EnvelopeCancel.model_validate(parsed)
                except ValidationError:
                    self._handle_line(line, over_limit=False)
                    continue
                self._handle_cancel(cancel)
                continue
            self._handle_line(line, over_limit=False)

    def _handle_cancel(self, frame: EnvelopeCancel) -> None:
        if self._active_id is not None and frame.id == self._active_id:
            self._cancel.set()
            return
        print(f"coral_backend: cancel for idle id {frame.id}", file=self.stderr)

    def _handle_list(self, frame: EnvelopeRequest) -> None:
        payload = _payload_dict(frame.payload)
        try:
            request = ModelListRequest.model_validate(payload)
        except ValidationError as exc:
            raise WorkerError("schema_failure", _validation_message(exc)) from exc
        override = request.modelsDir
        models_dir = resolve_models_dir(override) if override else self.models_dir
        if models_dir is None:
            models_dir = resolve_models_dir(None)
        models = [item.model_dump(exclude_none=True) for item in list_models(models_dir)]
        self._emit_result(frame.id, frame.method, {"models": models})

    def _handle_show(self, frame: EnvelopeRequest) -> None:
        payload = _payload_dict(frame.payload)
        try:
            request = ModelShowRequest.model_validate(payload)
        except ValidationError as exc:
            raise WorkerError("schema_failure", _validation_message(exc)) from exc
        models_dir = self.models_dir or resolve_models_dir(None)
        info, _size = show_model(models_dir, request.name)
        self._emit_result(frame.id, frame.method, info.model_dump(exclude_none=True))

    def _handle_embed(self, frame: EnvelopeRequest) -> None:
        if not self._busy.acquire(blocking=False):
            raise WorkerError(
                "busy",
                f"generation already in flight for {self._active_id}",
            )
        try:
            try:
                request = EmbedRequest.model_validate(_payload_dict(frame.payload))
            except ValidationError as exc:
                raise WorkerError("schema_failure", _validation_message(exc)) from exc
            self._active_id = frame.id
            self._cancel = threading.Event()
            models_dir = self.models_dir or resolve_models_dir(None)
            finished = threading.Event()
            error: list[BaseException] = []
            result_vectors: list[list[list[float]]] = [[]]

            def work() -> None:
                try:
                    result_vectors[0] = self.backend.embed(
                        request.model,
                        list(request.texts),
                        models_dir=models_dir,
                        cancel=self._cancel,
                    )
                except BaseException as exc:
                    error.append(exc)
                finally:
                    finished.set()

            thread = threading.Thread(target=work, name="coral-embed", daemon=True)
            thread.start()
            self._pump_until(finished)
            thread.join()
            if error:
                raise error[0]
            if self._cancel.is_set():
                raise WorkerError("cancelled", "embed cancelled")
            vectors = result_vectors[0]
            if len(vectors) != len(request.texts):
                raise WorkerError(
                    "embed_count",
                    f"embed returned {len(vectors)} vectors for {len(request.texts)} texts",
                )
            result = EmbedResult(vectors=vectors)
            self._emit_result(frame.id, frame.method, result.model_dump())
        finally:
            self._active_id = None
            self._cancel = threading.Event()
            self._busy.release()

    def _emit_event(self, request_id: str, method: str, payload: dict[str, Any]) -> None:
        frame = EnvelopeEvent(
            v=PROTOCOL_VERSION,
            id=request_id,
            kind="event",
            method=method,
            payload=EnvelopePayload.model_validate(payload),
        )
        self._write(frame.model_dump(exclude_none=True))

    def _emit_result(self, request_id: str, method: str, payload: dict[str, Any]) -> None:
        frame = EnvelopeResult(
            v=PROTOCOL_VERSION,
            id=request_id,
            kind="result",
            method=method,
            payload=EnvelopePayload.model_validate(payload),
        )
        self._write(frame.model_dump(exclude_none=True))

    def _emit_error(
        self,
        request_id: str,
        code: str,
        message: str,
        method: str | None = None,
    ) -> None:
        values: dict[str, object] = {
            "v": PROTOCOL_VERSION,
            "id": request_id or MALFORMED_ID,
            "kind": "error",
            "payload": EnvelopeErrorPayload.model_validate(
                {"code": code, "message": message}
            ),
        }
        if method is not None:
            values["method"] = method
        frame = EnvelopeError.model_validate(values)
        self._write(frame.model_dump(exclude_none=True))

    def _write(self, payload: dict[str, Any]) -> None:
        encoded = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        with self._stdout_lock:
            self.stdout.write(encoded)
            self.stdout.flush()


class FrameReader:
    """Byte-capped NDJSON reader shared by the main loop and in-flight cancel pump."""

    def __init__(self, raw: BinaryIO, max_bytes: int) -> None:
        self.raw = raw
        self.max_bytes = max_bytes
        self.buf = bytearray()
        self.skipping = False
        self.eof = False

    def read(self, timeout: float | None = None) -> tuple[bytes, bool] | None:
        while True:
            extracted = self._extract()
            if extracted is not None:
                return extracted
            if self.eof:
                return None
            if timeout is not None and not _stdin_ready(self.raw, timeout):
                return None
            chunk = _read_chunk(self.raw)
            if not chunk:
                self.eof = True
                if self.buf and not self.skipping:
                    line = bytes(self.buf)
                    self.buf.clear()
                    return line, len(line) > self.max_bytes
                return None
            self.buf.extend(chunk)

    def _extract(self) -> tuple[bytes, bool] | None:
        while True:
            if self.skipping:
                nl = self.buf.find(b"\n")
                if nl < 0:
                    self.buf.clear()
                    return None
                del self.buf[: nl + 1]
                self.skipping = False
                continue
            if len(self.buf) > self.max_bytes and b"\n" not in self.buf:
                line = bytes(self.buf[: self.max_bytes + 1])
                self.buf.clear()
                self.skipping = True
                return line, True
            nl = self.buf.find(b"\n")
            if nl < 0:
                return None
            line = bytes(self.buf[:nl])
            del self.buf[: nl + 1]
            return line, len(line) > self.max_bytes


def parse_envelope(data: dict[str, Any]) -> object:
    major = data.get("v")
    if major is not None and major != PROTOCOL_VERSION:
        raise WorkerError(
            "protocol_version",
            f"unknown protocol major {major}; worker speaks v={PROTOCOL_VERSION}",
        )
    kind = data.get("kind")
    cls = ENVELOPE_BY_KIND.get(kind) if isinstance(kind, str) else None
    if cls is None:
        raise WorkerError("schema_failure", f"unknown envelope kind {kind!r}")
    return cls.model_validate(data)


def _read_chunk(raw: BinaryIO) -> bytes:
    # BufferedReader.read(n) waits to fill n bytes on a pipe; read1 returns the first burst
    read1 = getattr(raw, "read1", None)
    if callable(read1):
        chunk = read1(64 * 1024)
        return chunk if isinstance(chunk, (bytes, bytearray)) else b""
    return raw.read(64 * 1024) or b""


def _stdin_ready(raw: BinaryIO, timeout: float) -> bool:
    try:
        import select

        ready, _w, _x = select.select([raw], [], [], timeout)
        return bool(ready)
    except (OSError, ValueError):
        return False


def _payload_dict(payload: object) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return payload
    dumped = payload.model_dump()
    return dumped if isinstance(dumped, dict) else {}


def _optional_str(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _id_from(data: dict[str, Any]) -> str | None:
    value = data.get("id")
    if isinstance(value, str) and value:
        return value
    return None


def _peek_id(line: bytes) -> str | None:
    try:
        text = line.decode("utf-8", errors="replace")
    except Exception:
        return None
    marker = '"id"'
    index = text.find(marker)
    if index < 0:
        return None
    rest = text[index + len(marker) :]
    colon = rest.find(":")
    if colon < 0:
        return None
    rest = rest[colon + 1 :].lstrip()
    if not rest.startswith('"'):
        return None
    end = rest.find('"', 1)
    if end < 0:
        return None
    return rest[1:end] or None


def _validation_message(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "schema validation failed"
    first = errors[0]
    loc = ".".join(str(part) for part in first.get("loc", ()))
    msg = str(first.get("msg", "invalid"))
    return f"{loc}: {msg}" if loc else msg


def _versions() -> HandshakeVersions:
    from importlib.metadata import PackageNotFoundError, version

    def pkg(name: str) -> str | None:
        try:
            return version(name)
        except PackageNotFoundError:
            return None

    python = (
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    )
    values = {"python": python, "mlx": pkg("mlx"), "mlx_lm": pkg("mlx-lm")}
    return HandshakeVersions.model_validate(
        {key: value for key, value in values.items() if value is not None}
    )


def main(argv: list[str] | None = None) -> int:
    del argv
    worker = Worker(
        backend=load_backend(),
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr,
    )
    worker.run()
    return 0
