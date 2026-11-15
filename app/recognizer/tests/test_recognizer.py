import json
import threading
import urllib.error
import urllib.request

import numpy as np
import pytest

from conftest import needs_models
import templates as T
from recognizer import (COUNTS, KID_LABELS, OFFSETS, RecognizeError, apply_prior, label_text, motion_energy, parse_frames,
                        should_reject, spell_columns)


def body(frames, fill=None, seed=0):
    x = np.random.default_rng(seed).random((frames, 543, 3), dtype=np.float32) if fill is None else np.full((frames, 543, 3), fill, np.float32)
    return x, x.astype("<f4").tobytes()


# ── shape validation ───────────────────────────────────────────────────────────
def test_parse_frames_ok():
    x, b = body(7)
    y = parse_frames(b, "7")
    assert y.shape == (7, 543, 3) and y.dtype == np.float32
    assert np.array_equal(x, y)


@pytest.mark.parametrize("hdr,size,code", [
    (None, 543 * 3 * 4, "bad_frames"),
    ("abc", 543 * 3 * 4, "bad_frames"),
    ("0", 0, "bad_frames"),
    ("-1", 0, "bad_frames"),
    ("2", 543 * 3 * 4, "bad_body_size"),
    ("1", 543 * 3 * 4 + 4, "bad_body_size"),
    ("385", 385 * 543 * 3 * 4, "too_many_frames"),
])
def test_parse_frames_rejects(hdr, size, code):
    with pytest.raises(RecognizeError) as e:
        parse_frames(b"\0" * size, hdr)
    assert e.value.code == code


def test_label_text_matches_compose():
    assert label_text("thankyou") == "thank you"
    assert label_text("TV") == "TV"
    assert label_text("hello") == "hello"
    assert label_text("minemy") == "my"


def test_label_text_adult_mapping():
    want = {"potty": "bathroom", "callonphone": "call", "minemy": "my", "weus": "we", "hesheit": "he", "yourself": "you",
            "haveto": "have to", "thankyou": "thank you", "frenchfries": "french fries", "glasswindow": "window",
            "icecream": "ice cream"}
    assert {k: label_text(k) for k in want} == want


# ── kid-vocabulary prior ───────────────────────────────────────────────────────
def test_kid_prior_scales_only_kid_labels():
    idx = {0: "animal", 1: "tired", 2: "zebra", 3: "hello"}
    p = np.array([0.88, 0.05, 0.04, 0.03])
    q = apply_prior(p, idx, 0.35)
    assert np.allclose(q, [0.88 * 0.35, 0.05, 0.04 * 0.35, 0.03]) and p[0] == 0.88  # input untouched, not renormalised
    assert apply_prior(p, idx, 1.0) is p  # KID_PRIOR=1.0 disables it
    assert {"animal", "zebra", "underwear", "potty"} - KID_LABELS == {"potty"}


# ── "no sign" signal ───────────────────────────────────────────────────────────
def hands(frames, step=0.0, jitter=0.0, seed=0):
    """Shoulders 0.25 wide + both hands; the hands move step (image units) per frame, plus Gaussian jitter."""
    x = np.full((frames, 543, 3), np.nan, np.float32)
    x[:, 489 + 11, :2], x[:, 489 + 12, :2] = (0.625, 0.5), (0.375, 0.5)
    rng = np.random.default_rng(seed)
    for h in (468, 522):
        base = np.stack([np.linspace(0.3, 0.4, 21), np.linspace(0.6, 0.7, 21)], 1)
        for t in range(frames):
            x[t, h:h + 21, :2] = base + [step * t, 0] + rng.normal(0, jitter, (21, 2))
    return x


def test_motion_energy():
    assert motion_energy(hands(20)) == 0.0
    assert abs(motion_energy(hands(20, step=0.01)) - 0.04) < 1e-4  # 0.01 / 0.25 shoulder widths per frame
    assert motion_energy(hands(20, jitter=0.002)) < 0.025 < motion_energy(hands(20, step=0.015))
    assert motion_energy(np.full((10, 543, 3), np.nan, np.float32)) == 0.0  # no hands at all
    assert motion_energy(hands(1, step=0.1)) == 0.0
    x = hands(20, step=0.01)
    x[::2, 468:489] = np.nan  # left hand lost every other frame; the right hand still counts
    x[:, 489 + 11] = np.nan  # no shoulders: falls back to a typical width, stays finite
    assert np.isfinite(motion_energy(x)) and motion_energy(x) > 0


def test_should_reject():
    opts = [{"label": "hello", "text": "hello", "confidence": 0.6}, {"label": "cat", "text": "cat", "confidence": 0.1}]
    assert not should_reject(opts, 0.1, 0.025, 0.2)
    assert should_reject(opts, 0.01, 0.025, 0.2)  # hands barely moved
    assert should_reject([{**opts[0], "confidence": 0.15}], 0.1, 0.025, 0.2)  # nothing confident
    assert should_reject([], 0.1, 0.025, 0.2)


# ── spell column mapping ───────────────────────────────────────────────────────
def test_spell_columns_mapping():
    pts, coords = spell_columns(["x_face_0", "y_face_61", "z_left_hand_20", "x_pose_13", "y_right_hand_0", "z_right_hand_20"])
    assert pts.tolist() == [0, 61, 468 + 20, 489 + 13, 522, 542]
    assert coords.tolist() == [0, 1, 2, 0, 1, 2]
    with pytest.raises(ValueError):
        spell_columns(["x_face_468"])
    with pytest.raises(ValueError):
        spell_columns(["w_pose_1"])
    assert OFFSETS["right_hand"] + COUNTS["right_hand"] == 543


@needs_models
def test_spell_columns_real_args(rec):
    assert len(rec.fs_points) == 390
    x = np.arange(543 * 3, dtype=np.float32).reshape(1, 543, 3)
    cols = x[:, rec.fs_points, rec.fs_coords][0]
    from recognizer import MODELS_DIR
    names = json.loads((MODELS_DIR / "fs_args.json").read_text())["selected_columns"]
    i = names.index("x_right_hand_0")
    assert cols[i] == (522 * 3 + 0)
    i = names.index("z_pose_13") if "z_pose_13" in names else names.index("z_pose_12")
    p = int(names[i].rsplit("_", 1)[1])
    assert cols[i] == (489 + p) * 3 + 2


# ── models ─────────────────────────────────────────────────────────────────────
@needs_models
def test_sign_top5_sorted_normalized(rec):
    x, _ = body(30)
    out = rec.recognize("sign", x)
    opts = out["options"]
    assert out["mode"] == "sign" and out["frames"] == 30 and len(opts) == 5
    conf = [o["confidence"] for o in opts]
    assert conf == sorted(conf, reverse=True)
    assert all(0 <= c <= 1 for c in conf)
    known = set(rec.labels) | ({T.gloss_label(g) for g in rec.templates.glosses} if rec.templates else set())
    assert all(o["label"] in known and isinstance(o["text"], str) for o in opts)
    assert set(out["timings"]) == {"inference_ms", "total_ms"}
    assert isinstance(out["motion"], float) and out["motion"] > 0.025 and out.get("reject", False) in (True, False)


@needs_models
def test_still_hands_rejected_with_options(rec):
    out = rec.recognize("sign", hands(30))
    assert out["motion"] == 0.0 and out["reject"] is True and len(out["options"]) == 5


@needs_models
@pytest.mark.parametrize("mode", ["sign", "spell"])
def test_all_nan_segment_does_not_crash(rec, mode):
    x, _ = body(20, fill=np.nan)
    out = rec.recognize(mode, x)
    assert out["mode"] == mode and out["frames"] == 20
    if mode == "sign":
        assert len(out["options"]) == 5 and all(np.isfinite(o["confidence"]) for o in out["options"])
        assert out["motion"] == 0.0 and out["reject"] is True
    else:
        assert isinstance(out["text"], str)


@needs_models
def test_single_frame(rec):
    x, _ = body(1)
    assert rec.recognize("sign", x)["frames"] == 1
    assert rec.recognize("spell", x)["text"] == ""  # too short: the model returns its "no reading" phrase


@needs_models
def test_spell_decode(rec):
    # One-hot rows for "a", "b", then E (already cut by the model, but extra ids are ignored).
    s = np.full((3, 63), -10, np.float32)
    s[0, 32] = s[1, 33] = s[2, 61] = 10
    text, conf = rec.decode_spell(s)
    assert text == "AB" and 0.9 < conf <= 1
    s2 = np.full((4, 63), -10, np.float32)
    s2[0, 33] = s2[1, 0] = s2[2, 32] = s2[3, 35] = 10  # "b ad"
    assert rec.decode_spell(s2)[0] == "BAD"
    dummy = np.full((11, 63), 0, np.float32)
    for i, ch in enumerate("2 a-e -aroe"):
        dummy[i, {v: k for k, v in rec.fs_chars.items()}[ch]] = 1
    assert rec.decode_spell(dummy) == ("", 0.0)


# ── HTTP ───────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def base(rec):
    from server import create_server
    srv = create_server("127.0.0.1", 0, rec)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def post(url, data, frames):
    req = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/octet-stream", "X-Frames": str(frames)})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@needs_models
def test_http(base):
    with urllib.request.urlopen(base + "/health") as r:
        h = json.loads(r.read())
    assert h["ok"] is True and set(h["models"]) == {"sign", "spell"}
    _, b = body(16)
    status, out = post(base + "/recognize?mode=sign", b, 16)
    assert status == 200 and len(out["options"]) == 5 and "text" not in out
    status, out = post(base + "/recognize?mode=spell", b, 16)
    assert status == 200 and isinstance(out["text"], str)
    status, out = post(base + "/recognize?mode=sign", b, 15)
    assert status == 400 and out["error"]["code"] == "bad_body_size"
    status, out = post(base + "/recognize?mode=dance", b, 16)
    assert status == 400 and out["error"]["code"] == "bad_mode"
