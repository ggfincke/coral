# tests/scripts/mlx-benchmark/server_with_metrics.py
# instrument the pinned stock server with read-only MLX allocator counters

import json
from http.server import ThreadingHTTPServer

import mlx.core as mx
import mlx_lm.server as server


# add allocator evidence without changing stock inference behavior
class BenchmarkAPIHandler(server.APIHandler):
    def do_GET(self):
        if self.path not in {"/benchmark/memory", "/benchmark/memory/reset"}:
            return super().do_GET()

        if self.path.endswith("/reset"):
            mx.reset_peak_memory()
        payload = json.dumps(
            {
                "activeBytes": int(mx.get_active_memory()),
                "cacheBytes": int(mx.get_cache_memory()),
                "peakBytes": int(mx.get_peak_memory()),
                "modelIdentity": self._model_identity(),
            }
        ).encode()
        self._set_completion_headers(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def _model_identity(self):
        key = self.response_generator.model_provider.model_key
        return key[0] if isinstance(key, tuple) and isinstance(key[0], str) else None


_stock_http_server = server._run_http_server


def _instrumented_http_server(
    host,
    port,
    response_generator,
    server_class=ThreadingHTTPServer,
    handler_class=BenchmarkAPIHandler,
):
    return _stock_http_server(
        host,
        port,
        response_generator,
        server_class=server_class,
        handler_class=handler_class,
    )


server._run_http_server = _instrumented_http_server
server.main()
