# packages/coral-backend/src/coral_backend/config.py
# protocol constants and models-dir / backend seam env

from __future__ import annotations

from pathlib import Path
import os

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 16 * 1024 * 1024
HANDSHAKE_METHOD = "handshake"
PHASE2_METHODS = ("chat.start", "model.list", "model.show", "embed")
WORKER_METHODS = PHASE2_METHODS
DEFAULT_NUM_PREDICT = 8192
NS_PER_SEC = 1_000_000_000

MODELS_DIR_ENV = "CORAL_MLX_MODELS_DIR"
BACKEND_MODULE_ENV = "CORAL_BACKEND_MODULE"
FAKE_GENERATE_ENV = "CORAL_FAKE_GENERATE"
FAKE_CAPTURE_ENV = "CORAL_FAKE_CAPTURE"
PROTOCOL_PYTHON_ENV = "CORAL_PROTOCOL_PYTHON"

DEFAULT_MODELS_DIR = Path.home() / ".coral" / "mlx-models"


# env wins over handshake so spawn-time CORAL_MLX_MODELS_DIR matches TS precedence
def resolve_models_dir(handshake_dir: str | None = None) -> Path:
    env = os.environ.get(MODELS_DIR_ENV)
    if env:
        return Path(env).expanduser()
    if handshake_dir:
        return Path(handshake_dir).expanduser()
    return DEFAULT_MODELS_DIR
