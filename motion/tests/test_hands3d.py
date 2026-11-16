"""Anatomical hand skeleton, IK fit and the v2 builder, on synthetic hands (no video, no models)."""
import hand_model as hm
import numpy as np
import pytest
from scipy.spatial.transform import Rotation

import hands3d
from redetect import hand_box
from synth import frame, motion

LO, HI = hm.limits_vector()


def _random_hands(n, seed=0):
    rng = np.random.default_rng(seed)
    th = rng.uniform(LO, HI, (n, hm.N_PARAMS))
    R = Rotation.random(n, random_state=seed).as_matrix()
    return R, th


def test_rest_pose_is_zero_and_possible():
    a = hm.raw_angles(hm.REST_MP)
    for f in ("index", "middle", "ring", "pinky"):
        assert np.allclose(a[f]["flex"], 0, atol=1e-6) and np.allclose(a[f]["side"], 0, atol=1e-6)
    assert hm.impossible_joints(hm.REST_MP) == []
    assert np.linalg.norm(hm.REST_MP[12]) == pytest.approx(0.179, abs=0.003)  # wrist -> middle tip


def test_fk_batch_matches_reference_and_rot_contract():
    R, th = _random_hands(8)
    pts, _ = hm.fk_batch(th)
    for k in range(8):
        ref, _ = hm.fk_local(th[k])
        assert np.allclose(pts[k], ref, atol=1e-12)
        # what a v2 reader does: FK from `rot` (MANO order) and the rest skeleton gives `joints`
        q = hm.theta_to_rot(R[k], th[k])
        assert q.shape == (16, 4)
        assert np.allclose(hm.fk_from_rot(q, hm.REST), hm.fk(R[k], th[k])[hm.MANO_TO_MP], atol=1e-9)


def test_fit_recovers_angles_from_noisy_points():
    R, th = _random_hands(30, seed=1)
    rng = np.random.default_rng(2)
    P = np.stack([hm.fk(R[k], th[k]) for k in range(30)]) * 0.7 + rng.normal(0, 0.0004, (30, 21, 3))
    R0, fit, mm = hm.fit_hands_batch(P, temporal=False)
    err = np.degrees(np.abs(fit - th))
    assert err.mean() < 4.0 and np.median(err) < 2.5
    assert np.all(fit >= LO - 1e-9) and np.all(fit <= HI + 1e-9)


def test_impossible_input_gives_a_possible_hand():
    p = hm.fk(np.eye(3), np.zeros(hm.N_PARAMS))
    # bend the index finger backwards 80 deg at the PIP joint (about the hinge axis)
    piv = p[6]
    Rb = Rotation.from_rotvec(np.radians(-80) * hm.ANAT["index"][:, 2]).as_matrix()
    p[7:9] = (p[7:9] - piv) @ Rb.T + piv
    assert ("index", "hyperextended hinge") in hm.impossible_joints(p)
    R0, th, mm = hm.fit_hand(p)
    assert np.all(th >= LO - 1e-9) and np.all(th <= HI + 1e-9)
    assert hm.impossible_joints(hm.fk(R0, th)) == []


def test_valid_poses_are_rarely_called_impossible():
    _, th = _random_hands(300, seed=3)
    pts, _ = hm.fk_batch(th)
    bad = sum(bool(hm.impossible_joints(p)) for p in pts)
    assert bad <= 6  # ~1%: extreme corners of the limits; the checker is for clear errors only


def test_mirror_quat_is_reflection():
    q = Rotation.random(5, random_state=4).as_quat()
    S = np.diag([-1.0, 1.0, 1.0])
    for a, b in zip(q, hm.mirror_quat(q)):
        assert np.allclose(Rotation.from_quat(b).as_matrix(), S @ Rotation.from_quat(a).as_matrix() @ S)


# ---------------------------------------------------------------- the v2 builder

def _hand_motion(T=20, gap=(8, 11), side="right"):
    """A synthetic clip whose hand world points come from the skeleton (curling index finger)."""
    frames = []
    for i in range(T):
        f = frame(i, fps=25, rw=(0.45, 0.5), lw=(0.55, 0.5))
        th = np.zeros(hm.N_PARAMS)
        th[6] = th[8] = np.radians(60) * i / T  # index MCP + PIP flex
        J = hm.fk(Rotation.from_euler("z", 20, degrees=True).as_matrix(), th) * 0.6
        if side == "left":
            J = J @ np.diag([-1.0, 1.0, 1.0])
        world = (J + [0.1, -0.2, -0.3]).tolist()
        img = (J[:, :2] * 2 + 0.5).tolist()
        f[f"{side}HandWorld"] = world
        f[f"{side}Hand"] = [p + [0.0] for p in img]
        other = "left" if side == "right" else "right"
        f[f"{other}Hand"] = f[f"{other}HandWorld"] = None
        if gap[0] <= i < gap[1]:
            f[f"{side}Hand"] = f[f"{side}HandWorld"] = None
        frames.append(f)
    m = motion(frames, fps=25)
    clean = dict(m, cleaned=True, cleanup={"trim": [0, T - 1], "filled_frames": {}})
    return m, clean


@pytest.mark.parametrize("side", ["right", "left"])
def test_build_v2_fills_gap_in_angle_space(side):
    raw, clean = _hand_motion(side=side)
    v2, st = hands3d.build_v2(raw, clean, redetect=False)
    assert v2["version"] == 2 and "hands3d_meta" in v2
    hs = [f["hands3d"][side] for f in v2["frames"]]
    assert all(h is not None for h in hs)
    assert [h["src"] for h in hs[8:11]] == ["filled"] * 3
    for h in hs:
        J = np.array(h["joints"])
        assert J.shape == (21, 3) and np.allclose(J[0], 0)
        assert len(h["rot"]) == 16 and 0 <= h["conf"] <= 1
        right = J @ np.diag([-1.0, 1.0, 1.0]) if side == "left" else J
        assert hm.impossible_joints(right) == []
    # v1 fields are kept, and the gap frames now have v1 hand points too
    assert all(f[f"{side}Hand"] is not None for f in v2["frames"])
    assert v2["frames"][0]["pose"] == raw["frames"][0]["pose"]
    # the index finger curls over the clip (MCP flex up to ~60 deg)
    a0 = hm.raw_angles(np.array(hs[1]["joints"]) * ([-1, 1, 1] if side == "left" else 1))["index"]["flex"][0]
    a1 = hm.raw_angles(np.array(hs[-1]["joints"]) * ([-1, 1, 1] if side == "left" else 1))["index"]["flex"][0]
    assert a1 - a0 > 35


def test_rot_reproduces_joints_for_left_hand():
    raw, clean = _hand_motion(side="left", gap=(0, 0))
    v2, _ = hands3d.build_v2(raw, clean, redetect=False)
    h = v2["frames"][5]["hands3d"]["left"]
    rest_left = hm.REST @ np.diag([-1.0, 1.0, 1.0])
    J = hm.fk_from_rot(np.array(h["rot"]), rest_left)
    assert np.allclose(J, np.array(h["joints"])[hm.MANO_TO_MP], atol=2e-3)


def test_smoothing_keeps_a_fast_step():
    """A handshape change over 2 frames is followed within 2 frames (90%), and limits hold."""
    T = 30
    th = np.zeros((T, hm.N_PARAMS))
    th[15:, 8] = np.radians(90)  # index PIP 0 -> 90 deg
    th[14, 8] = np.radians(45)
    R0s = [np.eye(3)] * T
    thetas = [t.copy() for t in th]
    hands3d.smooth_sequence(R0s, thetas, 25.0)
    out = np.degrees(np.array([t[8] for t in thetas]))
    assert out[16] >= 0.9 * 90 - 1e-6
    assert np.all(np.array(thetas) >= LO - 1e-9) and np.all(np.array(thetas) <= HI + 1e-9)


def test_hand_box_from_pose_when_hand_missing():
    f = frame(0, rw=(0.4, 0.5), right=False)
    box = hand_box(f, "right", 540, 720)
    assert box is not None
    cx, cy, s = box
    assert s > 0 and abs(cx - 0.4 * 540) < 200 and cy < 0.5 * 720  # past the knuckles, upward here
