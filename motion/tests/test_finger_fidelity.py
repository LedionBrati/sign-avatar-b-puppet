import numpy as np

from finger_fidelity import CHAINS, align, best_shift, code, compare, finger_states, joint_angles


def _hand(curled=()):
    """21 points: straight fingers fanned upward; fingers in `curled` fold 90 degrees at each joint."""
    p = np.zeros((21, 3))
    for f, chain in enumerate(CHAINS):
        d = np.array([(f - 2) * 0.02, 0.06, 0.0])
        d /= np.linalg.norm(d)  # every bone of a straight finger points the same way as its palm bone
        pos = np.zeros(3)
        for k, j in enumerate(chain[1:]):
            if f in curled and k >= 1:
                d = _rot(d)
            pos = pos + 0.03 * d
            p[j] = pos
    return p


def _rot(d):
    # rotate 90 degrees about the x axis: y -> -z, z -> y
    return np.array([d[0], d[2], -d[1]])


def _video(hands_per_frame, fps=24.0):
    n = len(hands_per_frame)
    x = np.full((n, 543, 3), np.nan, np.float32)
    w = np.full((n, 2, 21, 3), np.nan, np.float32)
    for i, h in enumerate(hands_per_frame):
        if h is not None:
            w[i, 1] = h
            x[i, 522:543] = h * 0.1 + 0.5
    return {"x543": x, "world": w, "fps": fps, "w": 540, "h": 720}


def test_straight_hand_has_no_flexion_and_is_extended():
    flex, spread = joint_angles(_hand())
    assert flex.shape == (15,) and spread.shape == (4,)
    assert np.allclose(flex, 0, atol=1e-6)
    assert code(finger_states(flex)) == "EEEEE"


def test_curled_index_is_c_and_counts_as_a_flip():
    flex, _ = joint_angles(_hand(curled=(1,)))
    assert code(finger_states(flex))[1] == "C"
    ref = _video([_hand()] * 10)
    gen = _video([_hand(curled=(1,))] * 10)
    a = compare(ref, gen, np.ones(10, bool))["all"]
    assert a["handshape_change_pct"] == 100.0 and a["finger_flip_pct"]["index"] == 100.0
    assert a["mean_joint_err_deg"] > 10


def test_identical_videos_score_zero_and_lost_hands_count_as_drops():
    hands = [_hand()] * 8 + [None] * 2
    ref = _video([_hand()] * 10)
    a = compare(ref, _video(hands), np.ones(10, bool))["all"]
    assert a["mean_joint_err_deg"] == 0.0 and a["handshape_change_pct"] == 0.0
    assert a["drop_pct"] == 20.0


def test_align_by_time_and_shift():
    assert list(align(4, 24, 5, 30)) == [0, 1, 2, 4]
    assert list(align(3, 24, 3, 24, shift=1)) == [1, 2, -1]
    seq = [_hand(curled=(1,) if i in (4, 11, 19, 22) else ()) for i in range(30)]
    ref = _video(seq)
    gen = _video([_hand()] * 3 + seq[:-3])  # generated starts 3 frames late
    assert best_shift(ref, gen, np.ones(30, bool), 6) == 3
