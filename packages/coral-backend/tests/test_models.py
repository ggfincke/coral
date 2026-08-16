# packages/coral-backend/tests/test_models.py
# checkpoint inventory and honest ModelInfo from config.json

from __future__ import annotations

from pathlib import Path
import json
import tempfile
import unittest

from coral_backend.errors import WorkerError
from coral_backend.models import list_models, resolve_checkpoint, show_model
from driver import WorkerProc


class InventoryTest(unittest.TestCase):
    def test_inventory_requires_a_supported_weight_and_accepts_shards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_only = root / "config-only"
            config_only.mkdir()
            (config_only / "config.json").write_text("{}", encoding="utf-8")
            sharded = root / "sharded"
            sharded.mkdir()
            (sharded / "config.json").write_text("{}", encoding="utf-8")
            (sharded / "model-00001-of-00002.safetensors").write_bytes(b"a" * 8)
            (sharded / "model-00002-of-00002.safetensors").write_bytes(b"b" * 12)

            models = list_models(root)

            self.assertEqual([model.name for model in models], ["sharded"])
            self.assertEqual(models[0].size, 20)
            with self.assertRaises(WorkerError):
                resolve_checkpoint(root, "config-only")

    def test_list_and_show_gemma_kv_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(
                root / "gemma4-demo",
                {
                    "model_type": "gemma4",
                    "max_position_embeddings": 131072,
                    "num_hidden_layers": 48,
                    "num_key_value_heads": 8,
                    "head_dim": 256,
                    "hidden_size": 4096,
                    "num_attention_heads": 16,
                },
                weight_bytes=2048,
            )
            models = list_models(root)
            self.assertEqual(len(models), 1)
            self.assertEqual(models[0].name, "gemma4-demo")
            self.assertEqual(models[0].size, 2048)
            self.assertTrue(models[0].modified_at.endswith("Z"))
            info, size = show_model(root, "gemma4-demo")
            self.assertEqual(size, 2048)
            self.assertEqual(info.size, 2048)
            self.assertEqual(info.contextLength, 131072)
            self.assertEqual(info.architecture, "gemma4")
            self.assertEqual(info.blockCount, 48)
            self.assertEqual(info.kvHeadCount, 8)
            self.assertEqual(info.keyLength, 256)
            self.assertEqual(info.valueLength, 256)

    def test_nested_text_config_and_missing_context_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(
                root / "qwen3-demo",
                {
                    "model_type": "qwen3",
                    "text_config": {
                        "max_position_embeddings": 32768,
                        "num_hidden_layers": 32,
                        "num_key_value_heads": 8,
                        "hidden_size": 4096,
                        "num_attention_heads": 32,
                    },
                },
                weight_bytes=512,
            )
            info, _size = show_model(root, "qwen3-demo")
            self.assertEqual(info.architecture, "qwen3")
            self.assertEqual(info.contextLength, 32768)
            self.assertEqual(info.keyLength, 128)
            _write_checkpoint(root / "broken", {"model_type": "gemma4"}, weight_bytes=8)
            with self.assertRaises(WorkerError) as ctx:
                show_model(root, "broken")
            self.assertEqual(ctx.exception.code, "model_info_incomplete")

    def test_checkpoint_resolution_is_confined_to_inventory_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "models"
            nested = root / "team" / "demo"
            outside = base / "outside"
            _write_checkpoint(nested, {"model_type": "gemma4"}, weight_bytes=8)
            _write_checkpoint(outside, {"model_type": "gemma4"}, weight_bytes=8)
            self.assertEqual(resolve_checkpoint(root, "team/demo"), nested.resolve())
            for unsafe in (str(outside), "../outside", "demo"):
                with self.subTest(name=unsafe):
                    with self.assertRaises(WorkerError):
                        resolve_checkpoint(root, unsafe)

    def test_worker_model_list_and_show(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(
                root / "demo",
                {
                    "model_type": "gemma4",
                    "max_position_embeddings": 8192,
                    "num_hidden_layers": 2,
                    "num_key_value_heads": 1,
                    "head_dim": 64,
                },
                weight_bytes=128,
            )
            worker = WorkerProc({"chunks": [{"content": "x"}]}, models_dir=root)
            try:
                worker.handshake({"modelsDir": str(root)})
                worker.send(
                    {
                        "v": 1,
                        "id": "list",
                        "kind": "request",
                        "method": "model.list",
                        "payload": {},
                    }
                )
                listed = worker.read()
                names = [item["name"] for item in listed["payload"]["models"]]
                self.assertEqual(names, ["demo"])
                self.assertEqual(listed["payload"]["models"][0]["size"], 128)
                worker.send(
                    {
                        "v": 1,
                        "id": "show",
                        "kind": "request",
                        "method": "model.show",
                        "payload": {"name": "demo"},
                    }
                )
                shown = worker.read()
                self.assertEqual(shown["payload"]["architecture"], "gemma4")
                self.assertEqual(shown["payload"]["contextLength"], 8192)
                self.assertEqual(shown["payload"]["size"], 128)
                worker.send(
                    {
                        "v": 1,
                        "id": "show-bad",
                        "kind": "request",
                        "method": "model.show",
                        "payload": {"model": "demo"},
                    }
                )
                bad = worker.read()
                self.assertEqual(bad["kind"], "error")
                self.assertEqual(bad["payload"]["code"], "schema_failure")
            finally:
                worker.close()

    def test_model_list_request_override_does_not_beat_env_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            env_root = base / "env-models"
            request_root = base / "request-models"
            _write_checkpoint(env_root / "from-env", {}, weight_bytes=8)
            _write_checkpoint(request_root / "from-request", {}, weight_bytes=8)
            worker = WorkerProc({"chunks": []}, models_dir=env_root)
            try:
                worker.handshake()
                worker.send(
                    {
                        "v": 1,
                        "id": "list-precedence",
                        "kind": "request",
                        "method": "model.list",
                        "payload": {"modelsDir": str(request_root)},
                    }
                )
                listed = worker.read()
                names = [item["name"] for item in listed["payload"]["models"]]
                self.assertEqual(names, ["from-env"])
            finally:
                worker.close()


def _write_checkpoint(path: Path, config: dict[str, object], *, weight_bytes: int) -> None:
    path.mkdir(parents=True)
    (path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (path / "model.safetensors").write_bytes(b"\0" * weight_bytes)
