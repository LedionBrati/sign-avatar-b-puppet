import json

from clean import (
    anchor_hand_world,
    clean_motion,
    detect_dominant_hand,
    fill_gaps,
    hand_world_is_anchored,
    present_runs,
    trim_rest_range,
)
from synth import frame, motion, signing_clip


def _hand_frames(present):
    return [{"i": i, "h": ([[float(i), 0.0, 0.0]] * 21 if p else None)} for i, p in enumerate(present)]


def test_present_runs():
    assert present_runs([0, 1, 1, 0, 1]) == [(1, 3), (4, 5)]
    assert present_runs([]) == []


def test_fill_short_interior_gap_linear():
    fr = _hand_frames([1, 1, 0, 0, 0, 1, 1])
    filled = fill_gaps(fr, "h", max_gap=4)
    assert filled == [2, 3, 4]
    assert [f["h"][0][0] for f in fr] == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]


def test_long_gap_stays_null():
    fr = _hand_frames([1, 0, 0, 0, 0, 0, 1])
    assert fill_gaps(fr, "h", max_gap=4) == []
    assert all(f["h"] is None for f in fr[1:6])


def test_edge_gaps_not_filled():
    fr = _hand_frames([0, 0, 1, 1, 0])
    assert fill_gaps(fr, "h", max_gap=4) == []
    assert fr[0]["h"] is None and fr[4]["h"] is None


def test_dominant_right_and_left():
    assert detect_dominant_hand(signing_clip("right"))["hand"] == "right"
    assert detect_dominant_hand(signing_clip("left"))["hand"] == "left"


def test_dominant_none_when_still():
    m = motion([frame(i) for i in range(30)])
    assert detect_dominant_hand(m)["hand"] is None


def test_trim_rest_keeps_sign_plus_pad():
    m = signing_clip("right", rest=10, sign=20)
    first, last = trim_rest_range(m, pad=2)
    # the sign occupies frames 10..29; the jump out of / back to rest counts as motion
    assert 6 <= first <= 9
    assert 30 <= last <= 33


def test_trim_rest_all_rest_keeps_everything():
    m = motion([frame(i) for i in range(15)])
    assert trim_rest_range(m) == (0, 14)


def test_clean_motion_end_to_end():
    m = signing_clip("right", rest=10, sign=20)
    for i in (15, 16):  # short dropout while signing -> filled
        m["frames"][i]["rightHand"] = None
    for i in range(20, 26):  # long dropout -> stays null
        m["frames"][i]["rightHand"] = None
    c = clean_motion(m, trim_rest=True)
    first = c["cleanup"]["trim"][0]
    assert c["cleaned"] is True and m["cleaned"] is False  # raw untouched
    assert m["frames"][15]["rightHand"] is None
    assert c["dominant_hand"] == "right"
    assert c["frames"][0]["i"] == 0 and c["frames"][0]["t"] == 0.0
    assert c["cleanup"]["filled_frames"]["rightHand"] == [15 - first, 16 - first]
    assert all(c["frames"][i - first]["rightHand"] is None for i in range(20, 26))
    assert len(c["frames"]) == c["cleanup"]["trim"][1] - first + 1
    assert abs(c["source"]["start_s"] - first / 24) < 1e-3
    json.dumps(c, allow_nan=False)  # no NaN sneaks in


def test_clean_rounds_to_4_decimals():
    c = clean_motion(signing_clip("right"))
    for f in c["frames"]:
        for p in f["rightHand"]:
            for v in p:
                assert v == round(v, 4)


def test_hand_world_anchor():
    m = signing_clip("right", rest=2, sign=6)
    for f in m["frames"]:
        f["poseWorld"][16] = [0.1, -0.3, -0.2]
        f["rightHandWorld"] = [[0.1 + 0.01 * k, -0.3, -0.2] for k in range(21)]
    assert hand_world_is_anchored(m["frames"])
    f = m["frames"][0]
    f["poseWorld"][16] = [0.2, -0.3, -0.2]
    anchor_hand_world(m["frames"])
    assert f["rightHandWorld"][0] == [0.2, -0.3, -0.2]
    assert abs(f["rightHandWorld"][1][0] - 0.21) < 1e-4  # shape kept, only shifted
    m2 = signing_clip("right")
    m2["frames"][0]["poseWorld"][16] = [0.1, -0.3, -0.2]
    m2["frames"][0]["rightHandWorld"] = [[0.0, 0.0, 0.0]] * 21  # hand-centred world coords: not anchored
    assert not hand_world_is_anchored(m2["frames"])
