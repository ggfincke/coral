# packages/coral-backend/src/coral_backend/protocol.py
# load generated pydantic models from protocol/generated/python

from __future__ import annotations

from pathlib import Path
from types import ModuleType
import importlib
import os
import sys

from coral_backend.config import PROTOCOL_PYTHON_ENV

_PKG = "coral_backend._protocol_gen"


def _generated_dir() -> Path:
    env = os.environ.get(PROTOCOL_PYTHON_ENV)
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env).expanduser())
    here = Path(__file__).resolve()
    cwd = Path.cwd().resolve()
    prefix = Path(sys.prefix).resolve()
    virtual = os.environ.get("VIRTUAL_ENV")
    roots = [here.parent, *here.parents, cwd, *cwd.parents, prefix, *prefix.parents]
    if virtual:
        venv = Path(virtual).resolve()
        roots.extend([venv, *venv.parents])
    for parent in roots:
        candidates.append(parent / "protocol" / "generated" / "python")
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if (resolved / "envelope.py").is_file():
            return resolved
    raise RuntimeError(
        "protocol/generated/python not found; run from the Coral checkout "
        f"or set {PROTOCOL_PYTHON_ENV}"
    )


# register generated files as a private package so imports stay off sys.path
def _ensure_generated_package() -> str:
    if _PKG in sys.modules:
        return _PKG
    gen_dir = _generated_dir()
    pkg = ModuleType(_PKG)
    pkg.__file__ = str(gen_dir / "__init__.py")
    pkg.__path__ = [str(gen_dir)]
    pkg.__package__ = _PKG
    sys.modules[_PKG] = pkg
    return _PKG


_ensure_generated_package()

envelope = importlib.import_module(f"{_PKG}.envelope")
handshake = importlib.import_module(f"{_PKG}.handshake")
chat = importlib.import_module(f"{_PKG}.chat")
model = importlib.import_module(f"{_PKG}.model")

EnvelopePayload = envelope.EnvelopePayload
EnvelopeErrorPayload = envelope.EnvelopeErrorPayload
EnvelopeRequest = envelope.EnvelopeRequest
EnvelopeEvent = envelope.EnvelopeEvent
EnvelopeResult = envelope.EnvelopeResult
EnvelopeCancel = envelope.EnvelopeCancel
EnvelopeError = envelope.EnvelopeError

HandshakeRequest = handshake.HandshakeRequest
HandshakeResult = handshake.HandshakeResult
HandshakeVersions = handshake.HandshakeVersions

ChatRequest = chat.ChatRequest
ChatResponse = chat.ChatResponse
OllamaMessage = chat.OllamaMessage
OllamaTool = chat.OllamaTool
OllamaToolCall = chat.OllamaToolCall
OllamaToolCallFunction = chat.OllamaToolCallFunction
ChatJsonObject = chat.ChatJsonObject
ModelRequestMessage = chat.ModelRequestMessage

Model = model.Model
ModelInfo = model.ModelInfo
ModelRef = model.ModelRef
ModelListRequest = model.ModelListRequest
ModelShowRequest = model.ModelShowRequest
ModelListResult = model.ModelListResult

embedding = importlib.import_module(f"{_PKG}.embedding")
EmbedRequest = embedding.EmbedRequest
EmbedResult = embedding.EmbedResult

ENVELOPE_BY_KIND = {
    "request": EnvelopeRequest,
    "event": EnvelopeEvent,
    "result": EnvelopeResult,
    "cancel": EnvelopeCancel,
    "error": EnvelopeError,
}
