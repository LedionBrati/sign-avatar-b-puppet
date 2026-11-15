"""SIGNLAYER recognizer service (contract: RecognizeResponse in app/core/src/api.ts).

    uv run python server.py            # RECOGNIZER_PORT=8788 RECOGNIZER_HOST=127.0.0.1 (0.0.0.0 to expose it; normally only app/server calls it)

    GET  /health                       {ok, models: {sign, spell}, warm_ms}
    POST /recognize?mode=sign|spell    body: float32 [frames x 543 x 3] (little-endian), header X-Frames
                                       -> {mode, options: [{label, text, confidence}], text?, frames, timings}

Errors are {error: {code, message}}. Request bodies are landmark data (biometric): never logged.
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from recognizer import MAX_FRAMES, POINTS, RecognizeError, Recognizer, parse_frames

MAX_BODY = MAX_FRAMES * POINTS * 3 * 4


def make_handler(rec: Recognizer, info: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "signlayer-recognizer/0.1"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # method + path + status only, never bodies
            sys.stderr.write(f"{self.address_string()} {fmt % args}\n")

        def _json(self, status: int, body: dict):
            if os.environ.get("RECOG_DEBUG") == "1" and isinstance(body, dict) and "options" in body:  # labels only, never landmarks
                top = " | ".join(f"{o.get('text')} {o.get('confidence', 0):.2f}" for o in body["options"][:4])
                sys.stderr.write(f"DEBUG frames={body.get('frames')} motion={body.get('motion')} reject={body.get('reject', False)} :: {top}" + chr(10))
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str, message: str):
            self._json(status, {"error": {"code": code, "message": message}})

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type, x-frames")
            self.send_header("content-length", "0")
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/health", "/api/health"):
                return self._json(200, {"ok": True, "models": rec.models, **info})
            if path == "/":
                return self._json(200, {"name": "signlayer-recognizer", "routes": ["/health", "POST /recognize?mode=sign|spell"]})
            self._error(404, "not_found", f"no route GET {path}")

        def do_POST(self):
            t0 = time.perf_counter()
            url = urlparse(self.path)
            if url.path not in ("/recognize", "/api/recognize"):
                self._drain()
                return self._error(404, "not_found", f"no route POST {url.path}")
            mode = (parse_qs(url.query).get("mode") or ["sign"])[0]
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                length = -1
            if length < 0:
                self.close_connection = True
                return self._error(411, "length_required", "send a content-length")
            if length > MAX_BODY:
                self.close_connection = True
                return self._error(413, "too_many_frames", f"body over {MAX_BODY} bytes ({MAX_FRAMES} frames)")
            body = self.rfile.read(length)
            try:
                if mode not in ("sign", "spell"):
                    raise RecognizeError(400, "bad_mode", "mode must be sign or spell")
                x = parse_frames(body, self.headers.get("x-frames"))
                out = rec.recognize(mode, x)
            except RecognizeError as e:
                return self._error(e.status, e.code, str(e))
            except Exception as e:  # noqa: BLE001 - report the type only, never the data
                sys.stderr.write(f"error: {type(e).__name__}\n")
                return self._error(500, "internal", "recognizer failed")
            out["timings"]["total_ms"] = round((time.perf_counter() - t0) * 1000, 2)
            self._json(200, out)

        def _drain(self):
            try:
                n = int(self.headers.get("content-length") or 0)
                if 0 < n <= MAX_BODY:
                    self.rfile.read(n)
            except ValueError:
                pass

    return Handler


def create_server(host: str = "127.0.0.1", port: int = 8788, rec: Recognizer | None = None) -> ThreadingHTTPServer:
    rec = rec or Recognizer()
    info = {"warm_ms": rec.warm_up()}
    srv = ThreadingHTTPServer((host, port), make_handler(rec, info))
    srv.daemon_threads = True
    return srv


def main():
    host = os.environ.get("RECOGNIZER_HOST", "127.0.0.1")
    port = int(os.environ.get("RECOGNIZER_PORT", "8788"))
    t = time.perf_counter()
    srv = create_server(host, port)
    print(f"SIGNLAYER recognizer on http://{host}:{port} (models loaded and warm in {time.perf_counter() - t:.1f} s)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
