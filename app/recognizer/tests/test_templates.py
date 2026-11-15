import numpy as np

import templates as T


def segment(path, frames=40, shift=(0.0, 0.0), scale=1.0, left=False):
    """Synthetic 543 x 3 segment: shoulders + a flat hand whose wrist follows path(t) (shoulder-frame units)."""
    x = np.full((frames, 543, 3), np.nan, np.float32)
    sh_w, neck = 0.25 * scale, 0.14 * scale
    c = np.array([0.5 + shift[0], 0.55 + shift[1]])
    x[:, T.POSE + 0, :2] = c - [0, neck]  # nose
    x[:, T.POSE + 11, :2] = c + [sh_w / 2, 0]  # subject's left shoulder (image right)
    x[:, T.POSE + 12, :2] = c - [sh_w / 2, 0]
    x[:, T.POSE:T.POSE + 33, 2] = 0
    hand = np.stack([np.linspace(0, 0.3, 21), -np.linspace(0, 1, 21)], 1) * 0.3
    for i in range(frames):
        w = np.array(path(i / (frames - 1)))
        if left:
            w = w * [-1, 1]
        pts = c + (w + hand * ([-1, 1] if left else 1)) * [sh_w, neck]
        start = T.LH if left else T.RH
        x[i, start:start + 21, :2], x[i, start:start + 21, 2] = pts, 0
    return x


UP = lambda t: (-0.6, 1.5 - 2.5 * t)  # noqa: E731
ACROSS = lambda t: (-1.2 + 1.8 * t, 0.0)  # noqa: E731
CIRCLE = lambda t: (-0.6 + 0.5 * np.cos(6.28 * t), 0.5 * np.sin(6.28 * t))  # noqa: E731


def test_features_invariant_to_position_and_scale():
    a = T.features(segment(UP))
    b = T.features(segment(UP, shift=(0.1, -0.05), scale=1.4))
    assert a.shape == (T.L, 88) and np.allclose(a, b, atol=1e-3)
    assert T.features(np.full((5, 543, 3), np.nan, np.float32)) is None


def test_bank_match_and_mirror(tmp_path):
    feats = np.stack([T.features(segment(p)) for p in (UP, ACROSS, CIRCLE)])
    np.savez(tmp_path / "templates.npz", glosses=np.array(["GOOD", "THANK YOU", "HOW"]), gloss_idx=np.arange(3, dtype=np.int32),
             stems=np.array(["a", "b", "c"]), feats=feats.astype(np.float16))
    bank = T.TemplateBank(tmp_path / "templates.npz")
    out = bank.match(segment(ACROSS, scale=0.8))
    assert out[0]["label"] == "THANK_YOU" and out[0]["text"] == "thank you" and out[0]["confidence"] > 0.5
    assert bank.match(segment(CIRCLE, left=True))[0]["label"] == "HOW"  # a left-handed signer matches too
    assert bank.match(np.full((8, 543, 3), np.nan, np.float32)) == []


def test_merge():
    g = [{"label": "animal", "text": "animal", "confidence": 0.5}, {"label": "hello", "text": "hello", "confidence": 0.2}]
    t = [{"label": "TIRED", "text": "tired", "confidence": 0.7, "distance": 0.3}, {"label": "HELLO", "text": "hello", "confidence": 0.2, "distance": 0.4}]
    m = T.merge(g, t)
    assert [o["text"] for o in m] == ["tired", "animal", "hello"]
    assert m[2]["confidence"] > 0.2 and set(m[0]) == {"label", "text", "confidence"}
