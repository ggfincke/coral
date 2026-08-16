# packages/coral-backend/tests/test_fixtures.py
# golden protocol fixtures must validate on the generated pydantic models

from __future__ import annotations

from pathlib import Path
import json
import unittest

from pydantic import ValidationError

from coral_backend.protocol import (
    ChatRequest,
    ChatResponse,
    EmbedRequest,
    EmbedResult,
    HandshakeRequest,
    HandshakeResult,
    Model,
    ModelInfo,
    ModelListRequest,
    ModelListResult,
    ModelRef,
    ModelShowRequest,
)
from coral_backend.server import parse_envelope

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "protocol" / "fixtures"

CHAT_MODELS = (ChatRequest, ChatResponse)
HANDSHAKE_MODELS = (HandshakeRequest, HandshakeResult)
EMBED_MODELS = (EmbedRequest, EmbedResult)
MODEL_MODELS = (
    Model,
    ModelInfo,
    ModelRef,
    ModelListRequest,
    ModelShowRequest,
    ModelListResult,
)


class GoldenFixtureTest(unittest.TestCase):
    def test_importing_worker_does_not_import_mlx(self) -> None:
        import sys

        import coral_backend.chat
        import coral_backend.models
        import coral_backend.server

        self.assertIsNotNone(coral_backend.chat)
        self.assertIsNotNone(coral_backend.models)
        self.assertIsNotNone(coral_backend.server)
        self.assertNotIn("mlx", sys.modules)
        self.assertNotIn("mlx_lm", sys.modules)

    def test_valid_worker_fixtures_accept(self) -> None:
        valid = FIXTURES / "valid"
        self.assertTrue(valid.is_dir())
        checked = 0
        for path in sorted(valid.glob("*.json")):
            schema = _schema_for(path.name)
            if schema is None:
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            _accept(schema, data)
            checked += 1
        self.assertGreaterEqual(checked, 4)

    def test_invalid_embedding_fixtures_reject(self) -> None:
        invalid = FIXTURES / "invalid"
        checked = 0
        for path in sorted(invalid.glob("embedding-*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            accepted = False
            for model in EMBED_MODELS:
                try:
                    model.model_validate(data)
                    accepted = True
                except ValidationError:
                    pass
            self.assertFalse(accepted, f"{path.name} should be invalid")
            checked += 1
        self.assertGreaterEqual(checked, 1)

    def test_invalid_envelope_fixture_rejects(self) -> None:
        path = FIXTURES / "invalid" / "envelope-unknown-kind.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        with self.assertRaises((ValidationError, Exception)):
            parse_envelope(data)

    def test_generated_models_reject_non_finite_protocol_numbers(self) -> None:
        cases = (
            (ModelInfo, {"contextLength": float("inf")}),
            (EmbedResult, {"vectors": [[float("nan")]]}),
        )
        for model, payload in cases:
            with self.subTest(model=model.__name__):
                with self.assertRaises(ValidationError):
                    model.model_validate(payload)


def _schema_for(name: str) -> str | None:
    if name.startswith("envelope-"):
        return "envelope"
    if name.startswith("handshake-"):
        return "handshake"
    if name.startswith("chat-"):
        return "chat"
    if name.startswith("model-"):
        return "model"
    if name.startswith("embedding-"):
        return "embedding"
    return None


def _accept(schema: str, data: object) -> None:
    if schema == "envelope":
        if not isinstance(data, dict):
            raise AssertionError("envelope fixture must be an object")
        parse_envelope(data)
        return
    models = {
        "handshake": HANDSHAKE_MODELS,
        "chat": CHAT_MODELS,
        "model": MODEL_MODELS,
        "embedding": EMBED_MODELS,
    }[schema]
    errors: list[str] = []
    for model in models:
        try:
            model.model_validate(data)
            return
        except ValidationError as exc:
            errors.append(f"{model.__name__}: {exc}")
    raise AssertionError("no generated model accepted fixture: " + "; ".join(errors))
