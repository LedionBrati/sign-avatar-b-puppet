"""personal.py + enroll.py: features, training, closed-vocabulary reading with rejection, decoding a long segment,
enrollment storage (no face), and the HTTP routes. Synthetic signs (a hand moving along different paths)."""

import json
import threading
import urllib.error
import urllib.request

import numpy as np
import pytest

import enroll as E
import personal as P
from conftest import needs_models
from test_segment import FPS, frame

PATHS = {
    "HELLO": lambda t: (-0.6 + 0.9 * t, 0.2 - 0.3 * np.sin(np.pi * t)),  # across, arching
    "YES": lambda t: (-0.6, 0.3 + 0.35 * np.sin(4 * np.pi * t)),  # up / down, twice
    "NO": lambda t: (-0.6 + 0.35 * np.cos(4 * np.pi * t) - 0.35, 0.3 + 0.35 * np.sin(4 * np.pi * t)),  # circles
}


def sign(label, rng, n=None, jitter=0.002):
    """rest -> raise -> the sign's path -> lower, with a little randomness in speed and position."""
    n = n or int(rng.integers(22, 34))
    off = rng.normal(0, 0.04, 2)
    rest = np.array([-0.6, 2.2])
    f = PATHS[label]
    start = np.array(f(0.0)) + off
    out = [frame(rest, jitter=jitter, rng=rng) for _ in range(6)]
    out += [frame(rest + (start - rest) * t, jitter=jitter, rng=rng) for t in np.linspace(0, 1, 6)]
    out += [frame(np.array(f(t)) + off, jitter=jitter, rng=rng) for t in np.linspace(0, 1, n)]
    end = np.array(f(1.0)) + off
    out += [frame(end + (rest - end) * t, jitter=jitter, rng=rng) for t in np.linspace(0, 1, 6)]
    x = np.stack(out)
    x[:, :468] = 0.5  # a face is there; enrollment must drop it
    return x


@pytest.fixture(scope="module")
def model():
    rng = np.random.default_rng(0)
    clips = [(sign(l, rng), l, 1.0) for l in PATHS for _ in range(4)]
    still = [np.stack([frame([-0.6, 0.3], jitter=0.002, rng=rng) for _ in range(30)]) for _ in range(6)]
    return P.train(clips, still, sorted(PATHS) + [P.NONE], aug=3)


def test_features_shape_and_mirror():
    rng = np.random.default_rng(1)
    x = sign("HELLO", rng)
    f = P.features(x)
    assert f.shape == (P.L, 88)
    assert P.features(np.full((10, 543, 3), np.nan, np.float32)) is None


def test_classify_closed_vocab(model):
    rng = np.random.default_rng(7)
    for l in PATHS:
        r = model.classify(sign(l, rng), ["HELLO", "YES", "NO"])
        assert r["options"][0]["label"] == l and not r["reject"] and not r["unsure"], (l, r)
    r = model.classify(sign("YES", rng), ["HELLO", "NO"])  # YES is not active: never returned
    assert all(o["label"] != "YES" for o in r["options"])


def test_still_hands_rejected(model):
    rng = np.random.default_rng(3)
    x = np.stack([frame([-0.6, 0.3], jitter=0.002, rng=rng) for _ in range(30)])
    assert model.classify(x, ["HELLO", "YES", "NO"])["reject"]


def test_gislr_prior_moves_the_vote():
    g = P.gislr_share({"hello": 0.9, "yes": 0.05}, ["HELLO", "YES", "NAME"])
    assert g[0] > g[1] and g[2] > 0  # NAME is unknown to GISLR: it gets the leftover mass
    f = P.fuse(np.array([0.4, 0.6, 0.0 + 1e-6]), g)
    assert int(np.argmax(f)) == 0


def test_decode_splits_two_signs(model):
    rng = np.random.default_rng(5)
    a, b = sign("HELLO", rng, n=30), sign("NO", rng, n=30)
    a, b = a[12:42], b[12:42]  # the two signs' own movement
    glide = np.stack([frame(np.array(PATHS["HELLO"](1.0)) + (np.array(PATHS["NO"](0.0)) - PATHS["HELLO"](1.0)) * t, jitter=0.002, rng=rng)
                      for t in np.linspace(0, 1, 6)])
    x = np.concatenate([a, np.repeat(a[-1:], 3, 0), glide, b])  # signing straight through: a short slow-down, no rest
    pieces = P.decode(model, x, FPS, ["HELLO", "YES", "NO"])
    labels = [model.classify(x[s:e], ["HELLO", "YES", "NO"])["options"][0]["label"] for s, e in pieces]
    assert labels == ["HELLO", "NO"], (pieces, labels)


def test_save_load_roundtrip(model, tmp_path):
    P.save(model, tmp_path / "m.npz")
    m = P.load(tmp_path / "m.npz")
    x = sign("YES", np.random.default_rng(9))
    assert m.classify(x)["options"][0]["label"] == model.classify(x)["options"][0]["label"]


def test_store_enroll_train(tmp_path, monkeypatch):
    monkeypatch.setattr(E, "GENERIC", tmp_path / "none.npz")
    monkeypatch.setattr(E, "DEFAULT_MODEL", tmp_path / "none2.npz")
    st = E.Store(tmp_path / "enroll")
    rng = np.random.default_rng(2)
    for l in PATHS:
        for _ in range(3):
            st.add("me", l, sign(l, rng))
    st.add("me", P.NONE, np.stack([frame([-0.6, 0.3], jitter=0.002, rng=rng) for _ in range(40)]))
    rep = next((tmp_path / "enroll" / "me" / "HELLO").glob("*.npy"))
    assert np.isnan(np.load(rep)[:, :468].astype(np.float32)).all()  # no face stored
    info = st.train("me")
    assert info["trained"] and info["reps"]["HELLO"] == 3 and info["model"]["own_reps"] == 9
    m = st.model("me")
    assert m.classify(sign("NO", rng), ["HELLO", "YES", "NO"])["options"][0]["label"] == "NO"
    with pytest.raises(E.EnrollError):
        st.add("../evil", "HELLO", sign("HELLO", rng))
    with pytest.raises(E.EnrollError):
        st.add("me", "DANCE", sign("HELLO", rng))
    st.delete("me", "HELLO")
    assert "HELLO" not in st.info("me")["reps"] and not st.info("me")["trained"]
    st.delete("me")
    assert st.profiles() == []


@pytest.fixture(scope="module")
def base(rec, tmp_path_factory):
    from server import create_server

    st = E.Store(tmp_path_factory.mktemp("enroll"))
    srv = create_server("127.0.0.1", 0, rec, st)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def call(method, url, x=None):
    data = None if x is None else np.ascontiguousarray(x, "<f4").tobytes()
    headers = {"content-type": "application/octet-stream", **({"X-Frames": str(len(x))} if x is not None else {})}
    req = urllib.request.Request(url, data=data if data is not None else (b"" if method == "POST" else None), method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@needs_models
def test_http_enroll_train_recognize(base):
    rng = np.random.default_rng(4)
    for l in PATHS:
        for _ in range(3):
            s, out = call("POST", f"{base}/enroll?profile=t1&label={l}", sign(l, rng))
            assert s == 200, out
    assert out["reps"] == {"HELLO": 3, "NO": 3, "YES": 3}
    s, out = call("POST", f"{base}/train?profile=t1")
    assert s == 200 and out["trained"], out
    s, out = call("POST", f"{base}/recognize?mode=sign&profile=t1&vocab=HELLO,YES,NO", sign("YES", rng))
    assert s == 200 and out["signs"] and out["options"][0]["label"] in PATHS and out["personal"] == "t1"
    assert set(out["signs"][0]) >= {"start", "end", "options", "reject", "unsure"}
    s, out = call("POST", f"{base}/recognize?mode=sign", sign("YES", rng))  # no profile, no vocab: the open GISLR path
    assert s == 200 and "signs" not in out
    if E.DEFAULT_MODEL.exists():  # vocab without a profile: the generic demo model (no enrollment)
        s, out = call("POST", f"{base}/recognize?mode=sign&vocab=HELLO,YES,NO", sign("YES", rng))
        assert s == 200 and "signs" in out and out["personal"] == "demo", out
    s, out = call("POST", f"{base}/enroll?profile=t1&label=NOPE", sign("YES", rng))
    assert s == 400 and out["error"]["code"] == "bad_label"
    s, out = call("GET", f"{base}/enroll?profile=t1")
    assert out["trained"]
    s, out = call("DELETE", f"{base}/enroll?profile=t1")
    assert s == 200
    s, out = call("GET", f"{base}/profiles")
    assert out["profiles"] == []


def test_continuous_eval_helpers():
    """eval_continuous: one-to-one IoU matching, word edit distance, and main's old segmenter port."""
    from eval import eval_continuous as C

    assert C.match([(0, 10), (12, 20)], [(0, 9, "A"), (13, 20, "B"), (30, 40, "C")])[0] == 2
    assert C.match([(0, 40)], [(0, 9, "A"), (13, 20, "B")])[0] == 0  # one long cut over two signs matches neither well
    assert C.edit(["A", "B"], ["A", "B"]) == 0 and C.edit(["A"], ["A", "B"]) == 1 and C.edit(["B", "A"], ["A", "B"]) == 2
    rng = np.random.default_rng(6)
    x = np.concatenate([sign("HELLO", rng), np.stack([frame(None) for _ in range(20)]), sign("NO", rng)])
    assert len(C.old_segments(x, FPS)) >= 1
