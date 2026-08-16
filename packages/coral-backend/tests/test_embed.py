# packages/coral-backend/tests/test_embed.py
# embed protocol, digest stability, and stable fake vector dims

from __future__ import annotations

from pathlib import Path
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import coral_backend.models as models_module
from coral_backend.errors import WorkerError
from coral_backend.mlx_backend import MlxBackend
from coral_backend.models import artifact_digest
from driver import WorkerProc


class EmbedProtocolTest(unittest.TestCase):
    def test_embed_returns_stable_dims_over_two_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(root / "embed-demo")
            worker = WorkerProc(
                {"chunks": [{"content": "x"}], "embed": {"dimensions": 4}},
                models_dir=root,
            )
            try:
                worker.handshake({"modelsDir": str(root)})
                first = _embed(worker, "e1", "embed-demo", ["alpha", "beta"])
                second = _embed(worker, "e2", "embed-demo", ["alpha", "beta"])
                self.assertEqual(first["kind"], "result")
                self.assertEqual(len(first["payload"]["vectors"]), 2)
                self.assertEqual(len(first["payload"]["vectors"][0]), 4)
                self.assertEqual(len(first["payload"]["vectors"][1]), 4)
                self.assertEqual(first["payload"]["vectors"], second["payload"]["vectors"])
                self.assertGreater(len(first["payload"]["vectors"][0]), 0)
            finally:
                worker.close()

    def test_embed_empty_texts_returns_empty_vectors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(root / "embed-demo")
            worker = WorkerProc({"chunks": [{"content": "x"}]}, models_dir=root)
            try:
                worker.handshake({"modelsDir": str(root)})
                frame = _embed(worker, "empty", "embed-demo", [])
                self.assertEqual(frame["kind"], "result")
                self.assertEqual(frame["payload"]["vectors"], [])
            finally:
                worker.close()

    def test_embed_missing_model_is_schema_failure(self) -> None:
        worker = WorkerProc({"chunks": [{"content": "x"}]})
        try:
            worker.handshake()
            worker.send(
                {
                    "v": 1,
                    "id": "bad",
                    "kind": "request",
                    "method": "embed",
                    "payload": {"texts": ["hi"]},
                }
            )
            err = worker.read()
            self.assertEqual(err["kind"], "error")
            self.assertEqual(err["payload"]["code"], "schema_failure")
        finally:
            worker.close()

    def test_embed_cancel_is_pumped_and_worker_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(root / "embed-demo")
            worker = WorkerProc(
                {"chunks": [], "embed": {"dimensions": 4, "delay_ms": 500}},
                models_dir=root,
            )
            try:
                worker.handshake({"modelsDir": str(root)})
                worker.send(
                    {
                        "v": 1,
                        "id": "slow",
                        "kind": "request",
                        "method": "embed",
                        "payload": {"model": "embed-demo", "texts": ["alpha"]},
                    }
                )
                worker.send({"v": 1, "id": "slow", "kind": "cancel"})
                cancelled = worker.read()
                self.assertEqual(cancelled["kind"], "error")
                self.assertEqual(cancelled["payload"]["code"], "cancelled")
                recovered = _embed(worker, "after", "embed-demo", ["beta"])
                self.assertEqual(recovered["kind"], "result")
            finally:
                worker.close()

    def test_embed_cancel_keeps_worker_busy_until_opaque_call_settles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(root / "embed-demo")
            worker = WorkerProc(
                {"chunks": [], "embed": {"dimensions": 4, "opaque_delay_ms": 400}},
                models_dir=root,
            )
            try:
                worker.handshake()
                worker.send(_embed_request("opaque", "embed-demo", ["alpha"]))
                time.sleep(0.1)
                worker.send({"v": 1, "id": "opaque", "kind": "cancel"})
                worker.send(_embed_request("while-busy", "embed-demo", ["beta"]))
                terminals = {frame["id"]: frame for frame in (worker.read(), worker.read())}
                self.assertEqual(terminals["while-busy"]["payload"]["code"], "busy")
                self.assertEqual(terminals["opaque"]["payload"]["code"], "cancelled")
                recovered = _embed(worker, "after-opaque", "embed-demo", ["gamma"])
                self.assertEqual(recovered["kind"], "result")
            finally:
                worker.close()


class ArtifactDigestTest(unittest.TestCase):
    def test_digest_stable_across_two_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            first = artifact_digest(path)
            second = artifact_digest(path)
            self.assertEqual(len(first), 64)
            self.assertEqual(first, second)
            self.assertRegex(first, r"^[a-f0-9]{64}$")

    def test_digest_cache_hit_does_not_reread_checkpoint_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            with patch(
                "coral_backend.models._file_digest",
                wraps=models_module._file_digest,
            ) as file_digest:
                first = artifact_digest(path)
                hashed_files = file_digest.call_count
                second = artifact_digest(path)
            self.assertGreater(hashed_files, 0)
            self.assertEqual(file_digest.call_count, hashed_files)
            self.assertEqual(first, second)

    def test_digest_streams_files_without_read_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            with patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("whole-file read"),
            ):
                digest = artifact_digest(path)
            self.assertRegex(digest, r"^[a-f0-9]{64}$")

    def test_digest_changes_when_weights_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            before = artifact_digest(path)
            (path / "model.safetensors").write_bytes(b"\1" * 64)
            after = artifact_digest(path)
            self.assertNotEqual(before, after)

    def test_digest_changes_after_same_size_write_with_restored_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            weight = (path / "model.safetensors").resolve()
            stat = weight.stat()
            before = artifact_digest(path)
            weight.write_bytes(b"\1" * 64)
            os.utime(weight, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            after = artifact_digest(path)
            self.assertNotEqual(before, after)

    def test_digest_replace_race_retries_once_then_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            _write_checkpoint(path, tokenizer=True)
            weight = (path / "model.safetensors").resolve()
            attempts = 0
            original_file_digest = models_module._file_digest

            def replace_during_hash(file_path: Path) -> bytes:
                nonlocal attempts
                if file_path != weight:
                    return original_file_digest(file_path)
                attempts += 1
                file_path.unlink()
                file_path.write_bytes(bytes([attempts]) * 64)
                raise FileNotFoundError(file_path)

            with (
                patch(
                    "coral_backend.models._file_digest",
                    side_effect=replace_during_hash,
                ),
                self.assertRaises(WorkerError) as ctx,
            ):
                artifact_digest(path)

            self.assertEqual(attempts, 2)
            self.assertEqual(ctx.exception.code, "model_artifact_changed")

    def test_show_exposes_digest_and_worker_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ckpt = root / "embed-demo"
            _write_checkpoint(ckpt, tokenizer=True)
            expected = artifact_digest(ckpt)
            worker = WorkerProc({"chunks": [{"content": "x"}]}, models_dir=root)
            try:
                worker.handshake({"modelsDir": str(root)})
                worker.send(
                    {
                        "v": 1,
                        "id": "show",
                        "kind": "request",
                        "method": "model.show",
                        "payload": {"name": "embed-demo"},
                    }
                )
                shown = worker.read()
                self.assertEqual(shown["kind"], "result")
                self.assertEqual(shown["payload"]["digest"], expected)
            finally:
                worker.close()

    def test_digest_stable_across_two_worker_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ckpt = root / "embed-demo"
            _write_checkpoint(ckpt, tokenizer=True)
            first = _show_digest(root, "embed-demo")
            second = _show_digest(root, "embed-demo")
            self.assertEqual(first, second)
            self.assertRegex(first, r"^[a-f0-9]{64}$")

    def test_resident_embed_cache_is_keyed_by_artifact_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            path.mkdir()
            loads: list[tuple[object, object]] = []

            def load(_path: str) -> tuple[object, object]:
                loaded = (object(), object())
                loads.append(loaded)
                return loaded

            backend = MlxBackend()
            with (
                patch(
                    "coral_backend.mlx_backend.artifact_digest",
                    side_effect=["digest-a", "digest-a", "digest-b"],
                ),
                patch(
                    "coral_backend.mlx_backend._import_mlx_lm",
                    return_value=(load, object()),
                ),
            ):
                first = backend._load_embed(path)
                second = backend._load_embed(path)
                replaced = backend._load_embed(path)

            self.assertIs(first[0], second[0])
            self.assertIsNot(first[0], replaced[0])
            self.assertEqual(len(loads), 2)

    def test_chat_load_reuses_matching_embed_first_resident_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            path.mkdir()
            loads: list[tuple[object, object]] = []

            def load(_path: str) -> tuple[object, object]:
                loaded = (object(), object())
                loads.append(loaded)
                return loaded

            backend = MlxBackend()
            with (
                patch(
                    "coral_backend.mlx_backend.artifact_digest",
                    side_effect=["digest-a", "digest-a"],
                ),
                patch(
                    "coral_backend.mlx_backend._import_mlx_lm",
                    return_value=(load, object()),
                ),
            ):
                embedded = backend._load_embed(path)
                chatted = backend._load(path)

            self.assertIs(embedded[0], chatted[0])
            self.assertEqual(len(loads), 1)

    def test_cross_role_digest_change_evicts_stale_resident_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ckpt"
            path.mkdir()
            loads: list[tuple[object, object]] = []

            def load(_path: str) -> tuple[object, object]:
                loaded = (object(), object())
                loads.append(loaded)
                return loaded

            backend = MlxBackend()
            with (
                patch(
                    "coral_backend.mlx_backend.artifact_digest",
                    side_effect=["digest-old", "digest-new", "digest-new"],
                ),
                patch(
                    "coral_backend.mlx_backend._import_mlx_lm",
                    return_value=(load, object()),
                ),
            ):
                old_chat = backend._load(path)
                new_embed = backend._load_embed(path)
                self.assertIsNone(backend._cache)
                new_chat = backend._load(path)

            self.assertIsNot(old_chat[0], new_embed[0])
            self.assertIs(new_embed[0], new_chat[0])
            self.assertEqual(len(loads), 2)
            self.assertIsNone(backend._embed_cache)
            self.assertEqual(backend._cache[:2], (str(path.resolve()), "digest-new"))

    def test_mlx_embed_observes_cancel_after_opaque_tensor_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_checkpoint(root / "embed-demo")
            cancel = threading.Event()
            backend = MlxBackend()

            def embed_one(_model: object, _tokenizer: object, _text: str) -> list[float]:
                cancel.set()
                return [1.0]

            with (
                patch.object(backend, "_load_embed", return_value=(object(), object())),
                patch("coral_backend.mlx_backend._embed_one", side_effect=embed_one),
                self.assertRaises(WorkerError) as ctx,
            ):
                backend.embed(
                    "embed-demo",
                    ["alpha"],
                    models_dir=root,
                    cancel=cancel,
                )

            self.assertEqual(ctx.exception.code, "cancelled")


def _show_digest(models_dir: Path, name: str) -> str:
    worker = WorkerProc({"chunks": [{"content": "x"}]}, models_dir=models_dir)
    try:
        worker.handshake({"modelsDir": str(models_dir)})
        worker.send(
            {
                "v": 1,
                "id": "show",
                "kind": "request",
                "method": "model.show",
                "payload": {"name": name},
            }
        )
        shown = worker.read()
        if shown["kind"] != "result":
            raise AssertionError(f"model.show failed: {shown}")
        digest = shown["payload"]["digest"]
        if not isinstance(digest, str):
            raise AssertionError("model.show digest missing")
        return digest
    finally:
        worker.close()


def _embed(worker: WorkerProc, request_id: str, model: str, texts: list[str]) -> dict:
    worker.send(_embed_request(request_id, model, texts))
    return worker.read()


def _embed_request(
    request_id: str,
    model: str,
    texts: list[str],
) -> dict[str, object]:
    return {
        "v": 1,
        "id": request_id,
        "kind": "request",
        "method": "embed",
        "payload": {"model": model, "texts": texts},
    }


def _write_checkpoint(path: Path, *, tokenizer: bool = False) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text(
        json.dumps(
            {
                "model_type": "qwen3",
                "max_position_embeddings": 8192,
                "num_hidden_layers": 2,
                "num_key_value_heads": 1,
                "head_dim": 64,
                "hidden_size": 256,
            }
        ),
        encoding="utf-8",
    )
    (path / "model.safetensors").write_bytes(b"\0" * 64)
    if tokenizer:
        (path / "tokenizer.json").write_text("{}", encoding="utf-8")
        (path / "tokenizer_config.json").write_text("{}", encoding="utf-8")
