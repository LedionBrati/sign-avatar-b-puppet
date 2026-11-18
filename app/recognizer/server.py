"""Flux recognizer service (contract: RecognizeResponse in app/core/src/api.ts).

    uv run python server.py            # RECOGNIZER_PORT=8788 RECOGNIZER_HOST=127.0.0.1 (0.0.0.0 to expose it; normally only app/server calls it)

    GET  /health                       {ok, models: {sign, spell}, warm_ms}
    POST /recognize?mode=sign|spell    body: float32 [frames x 543 x 3] (little-endian), header X-Frames
                                       -> {mode, options: [{label, text, confidence}], text?, frames, timings}
         &profile=<name>&vocab=A,B,..  sign mode, closed vocabulary (enroll.py / personal.py): + signs: [{start, end,
                                       options, reject}] (a long segment can hold several signs); profile=demo = the
                                       generic demo model (models/demo_model.npz), also used for
                                       vocab without profile. Optional header X-Fps (default 30).
    "Train my signs":
    GET    /enroll?profile=P           {profile, reps: {LABEL: n}, trained, model?}
    POST   /enroll?profile=P&label=L   one rep (same body as /recognize); stored without face points
    DELETE /enroll?profile=P[&label=L] forget the reps (and the model)
    POST   /train?profile=P            fit the profile's model (seconds) -> GET /enroll's answer
    GET    /profiles                   {profiles: [...]}

Errors are {error: {code, message}}. Request bodies are landmark data (biometric): never logged.
"""

from __future__ import annotations

import os

# BLAS on every core spins against the browser and MediaPipe on a busy laptop (a 1000 x 2000 SVD took 40+ s):
# a few threads are faster here. Must be set before numpy loads.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import enroll as E
from recognizer import MAX_FRAMES, POINTS, RecognizeError, Recognizer, parse_frames

MAX_BODY = MAX_FRAMES * POINTS * 3 * 4


def make_handler(rec: Recognizer, info: dict, store: E.Store | None = None):
    store = store or E.Store()

    class Handler(BaseHTTPRequestHandler):
        server_version = "flux-recognizer/0.1"
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
            self.send_header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type, x-frames, x-fps")
            self.send_header("content-length", "0")
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/health", "/api/health"):
                demo = store.model("demo")
                personal = {"demo": f"{len(demo.labels) - 1} signs", "profiles": store.profiles()} if demo else {"demo": None, "profiles": store.profiles()}
                return self._json(200, {"ok": True, "models": rec.models, "personal": personal, **info})
            q = parse_qs(urlparse(self.path).query)
            try:
                if path in ("/enroll", "/api/enroll"):
                    return self._json(200, store.info((q.get("profile") or [""])[0]))
                if path in ("/profiles", "/api/profiles"):
                    return self._json(200, {"profiles": store.profiles()})
            except E.EnrollError as e:
                return self._error(e.status, e.code, str(e))
            if path == "/":
                return self._json(200, {"name": "flux-recognizer", "routes": ["/health", "POST /recognize?mode=sign|spell[&profile=&vocab=]",
                                                                                 "GET|POST|DELETE /enroll?profile=", "POST /train?profile=", "/profiles"]})
            self._error(404, "not_found", f"no route GET {path}")

        def do_DELETE(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path not in ("/enroll", "/api/enroll"):
                return self._error(404, "not_found", f"no route DELETE {url.path}")
            try:
                return self._json(200, store.delete((q.get("profile") or [""])[0], (q.get("label") or [None])[0]))
            except E.EnrollError as e:
                return self._error(e.status, e.code, str(e))

        def do_POST(self):
            t0 = time.perf_counter()
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path in ("/train", "/api/train"):
                self._drain()
                try:
                    return self._json(200, store.train((q.get("profile") or [""])[0]))
                except E.EnrollError as e:
                    return self._error(e.status, e.code, str(e))
            if url.path not in ("/recognize", "/api/recognize", "/enroll", "/api/enroll"):
                self._drain()
                return self._error(404, "not_found", f"no route POST {url.path}")
            mode = (q.get("mode") or ["sign"])[0]
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
                if url.path.endswith("/enroll"):
                    return self._json(200, store.add((q.get("profile") or [""])[0], (q.get("label") or [""])[0], x))
                # closed vocabulary when a profile or a vocab is asked for; no profile (or one without a model) = the
                # generic demo model (models/demo_model.npz: WLASL signers, no enrollment)
                profile = (q.get("profile") or [None])[0] or ("demo" if q.get("vocab") else None)
                model = store.model(profile) if mode == "sign" and profile else None
                if model is not None:
                    vocab = [v.strip().upper() for v in (q.get("vocab") or [""])[0].split(",") if v.strip()] or None
                    try:
                        fps = min(120.0, max(5.0, float(self.headers.get("x-fps") or 30)))
                    except ValueError:
                        fps = 30.0
                    out = E.read(rec, model, x, vocab, fps)
                    out["frames"] = int(x.shape[0])
                    out["timings"] = {"inference_ms": round((time.perf_counter() - t0) * 1000, 2)}
                else:
                    out = rec.recognize(mode, x)
            except (RecognizeError, E.EnrollError) as e:
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


def create_server(host: str = "127.0.0.1", port: int = 8788, rec: Recognizer | None = None, store: E.Store | None = None) -> ThreadingHTTPServer:
    rec = rec or Recognizer()
    info = {"warm_ms": rec.warm_up()}
    srv = ThreadingHTTPServer((host, port), make_handler(rec, info, store))
    srv.daemon_threads = True
    return srv


def main():
    host = os.environ.get("RECOGNIZER_HOST", "127.0.0.1")
    port = int(os.environ.get("RECOGNIZER_PORT", "8788"))
    t = time.perf_counter()
    srv = create_server(host, port)
    print(f"Flux recognizer on http://{host}:{port} (models loaded and warm in {time.perf_counter() - t:.1f} s)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
