# packages/coral-backend/src/coral_backend/backend.py
# generation backend protocol plus env-selected factory (no mlx import)

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import importlib
import os
import threading

from coral_backend.config import BACKEND_MODULE_ENV, FAKE_GENERATE_ENV
from coral_backend.protocol import ChatRequest


@dataclass
class BackendEvent:
    """One generation step: raw text, an already-normalized delta, or both."""

    text: str = ""
    normalized: dict[str, Any] | None = None
    prompt_eval_count: float | None = None
    prompt_eval_duration: float | None = None
    eval_count: float | None = None
    eval_duration: float | None = None
    done: bool = False


class GenerationBackend(ABC):
    """Swap-out generation source so protocol tests never import mlx or weights."""

    @abstractmethod
    def supports_thinking(self, model: str, models_dir: Path | None) -> bool:
        raise NotImplementedError

    @abstractmethod
    def family_for(self, model: str, models_dir: Path | None) -> str:
        raise NotImplementedError

    @abstractmethod
    def generate(
        self,
        request: ChatRequest,
        *,
        cancel: threading.Event,
        models_dir: Path | None,
    ) -> Iterator[BackendEvent]:
        raise NotImplementedError

    @abstractmethod
    def embed(
        self,
        model: str,
        texts: list[str],
        *,
        models_dir: Path | None,
        cancel: threading.Event,
    ) -> list[list[float]]:
        raise NotImplementedError


def load_backend() -> GenerationBackend:
    module_name = os.environ.get(BACKEND_MODULE_ENV)
    if module_name:
        module = importlib.import_module(module_name)
        create = getattr(module, "create_backend", None)
        if not callable(create):
            raise RuntimeError(f"{module_name} must export create_backend()")
        backend = create()
        if not isinstance(backend, GenerationBackend):
            raise RuntimeError(f"{module_name}.create_backend() must return GenerationBackend")
        return backend
    if os.environ.get(FAKE_GENERATE_ENV):
        from coral_backend.fake import FakeBackend

        return FakeBackend.from_env()
    from coral_backend.mlx_backend import MlxBackend

    return MlxBackend()
