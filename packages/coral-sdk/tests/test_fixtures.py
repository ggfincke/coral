# packages/coral-sdk/tests/test_fixtures.py
# load protocol/fixtures bytes through pydantic; never modify a fixture

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import sys
import types
import unittest

from pydantic import TypeAdapter, ValidationError

from coral_sdk.errors import CoralProtocolError
from coral_sdk.events import KNOWN_EVENT_TYPES, parse_frame

from fakes import repo_root


# import generated models from protocol/ without putting them on sys.path
def _load_gen(name: str) -> types.ModuleType:
    path = repo_root() / "protocol" / "generated" / "python" / f"{name}.py"
    mod_name = f"_coral_protocol_{name}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


def _list_fixtures(kind: str) -> list[str]:
    folder = repo_root() / "protocol" / "fixtures" / kind
    return sorted(path.name for path in folder.glob("*.json"))


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


# filename prefix selects the schema, matching tests/protocol/fixtures.test.ts
def _validate(filename: str, value: object) -> None:
    prefix = filename.split("-", 1)[0]
    if prefix == "exec":
        parse_frame(value)
        return
    if prefix == "envelope":
        adapter = TypeAdapter(_load_gen("envelope").Envelope)
        adapter.rebuild()
        adapter.validate_python(value)
        return
    if prefix == "handshake":
        adapter = TypeAdapter(_load_gen("handshake").HandshakeFrame)
        adapter.rebuild()
        adapter.validate_python(value)
        return
    if prefix == "chat":
        adapter = TypeAdapter(_load_gen("chat").ChatProtocol)
        adapter.rebuild()
        adapter.validate_python(value)
        return
    if prefix == "model":
        adapter = TypeAdapter(_load_gen("model").ModelProtocol)
        adapter.rebuild()
        adapter.validate_python(value)
        return
    if prefix == "embedding":
        adapter = TypeAdapter(_load_gen("embedding").EmbeddingProtocol)
        adapter.rebuild()
        adapter.validate_python(value)
        return
    raise AssertionError(f"no validator mapped for fixture {filename}")


def _rejects(filename: str, value: object) -> bool:
    try:
        _validate(filename, value)
    except (CoralProtocolError, ValidationError):
        return True
    return False


class GoldenFixtureTest(unittest.TestCase):
    def test_valid_fixtures_are_accepted(self) -> None:
        files = _list_fixtures("valid")
        self.assertTrue(files)
        seen_exec_types: set[str] = set()
        saw_bare_result = False
        saw_empty_response = False
        fixtures = repo_root() / "protocol" / "fixtures" / "valid"
        for filename in files:
            value = _load_json(fixtures / filename)
            try:
                _validate(filename, value)
            except (CoralProtocolError, ValidationError) as exc:
                self.fail(f"{filename} should be valid: {exc}")
            if (
                filename.startswith("exec-")
                and isinstance(value, dict)
                and isinstance(value.get("type"), str)
            ):
                seen_exec_types.add(value["type"])
            if filename == "exec-result-object.json":
                saw_bare_result = True
            if filename == "exec-result-empty.json":
                saw_empty_response = True
        for event_type in KNOWN_EVENT_TYPES:
            self.assertIn(
                event_type,
                seen_exec_types,
                f"missing valid fixture for exec type {event_type}",
            )
        self.assertTrue(saw_bare_result)
        self.assertTrue(saw_empty_response)

    def test_invalid_fixtures_are_rejected(self) -> None:
        files = _list_fixtures("invalid")
        self.assertIn("exec-unknown-type.json", files)
        self.assertIn("exec-missing-run-id.json", files)
        self.assertIn("exec-wrong-usage-shape.json", files)
        fixtures = repo_root() / "protocol" / "fixtures" / "invalid"
        for filename in files:
            value = _load_json(fixtures / filename)
            self.assertTrue(
                _rejects(filename, value),
                f"{filename} should be invalid",
            )
