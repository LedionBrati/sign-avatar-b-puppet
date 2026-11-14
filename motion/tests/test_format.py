import math
from types import SimpleNamespace as NS

from common import mirror_frame, mirror_label, motion_id_from_gloss, rnd, round_points
from extract import _blendshapes, _pts
from synth import frame


def test_rnd():
    assert rnd(0.123456) == 0.1235
    assert rnd(-0.00001) == 0.0 and math.copysign(1, rnd(-0.00001)) == 1.0  # never -0.0
    assert rnd(float("nan")) is None
    assert rnd(float("inf")) is None
    assert rnd(None) is None


def test_round_points_none_and_values():
    assert round_points(None) is None
    assert round_points([[0.11111, 2.22229, 3]]) == [[0.1111, 2.2223, 3.0]]


def test_missing_part_is_null_not_zeros():
    assert _pts([]) is None
    assert _pts(None) is None
    lm = [NS(x=0.1, y=0.2, z=0.3, visibility=0.9)]
    assert _pts(lm, with_visibility=True) == [[0.1, 0.2, 0.3, 0.9]]
    assert _pts(lm) == [[0.1, 0.2, 0.3]]


def test_blendshapes_drop_neutral():
    cats = [NS(category_name="_neutral", score=0.5), NS(category_name="browInnerUp", score=0.123456)]
    assert _blendshapes(cats) == {"browInnerUp": 0.1235}
    assert _blendshapes([]) is None


def test_mirror_label():
    assert mirror_label("leftHand") == "rightHand"
    assert mirror_label("rightHandWorld") == "leftHandWorld"
    assert mirror_label("pose") == "pose"


def test_mirror_frame_swaps_labels_and_flips_x():
    f = frame(0, lw=(0.7, 0.5), rw=(0.3, 0.6), right=False)
    f["poseWorld"][15] = [0.2, -0.1, 0.0]
    f["leftHandWorld"] = [[0.01, 0.02, 0.03]] * 21
    f["faceBlendshapes"] = {"eyeBlinkLeft": 0.9, "eyeBlinkRight": 0.1, "jawOpen": 0.3}
    m = mirror_frame(f)
    # the old left hand (image x 0.7) becomes the subject's RIGHT hand at x 0.3
    assert m["leftHand"] is None
    assert abs(m["rightHand"][0][0] - (1 - f["leftHand"][0][0])) < 1e-4
    assert m["rightHand"][0][1] == f["leftHand"][0][1]
    assert m["rightHandWorld"][0] == [-0.01, 0.02, 0.03]
    # pose wrists swap index and flip
    assert m["pose"][16][:2] == [0.3, 0.5]
    assert m["pose"][15][:2] == [0.7, 0.6]
    assert m["poseWorld"][16] == [-0.2, -0.1, 0.0]
    assert m["faceBlendshapes"] == {"eyeBlinkRight": 0.9, "eyeBlinkLeft": 0.1, "jawOpen": 0.3}
    assert m["face"] is None


def test_mirror_twice_is_identity_for_body_and_hands():
    f = frame(3, lw=(0.7, 0.5), rw=(0.31, 0.6))
    mm = mirror_frame(mirror_frame(f))
    for k in ("pose", "leftHand", "rightHand"):
        assert mm[k] == round_points(f[k])


def test_motion_id_from_gloss():
    assert motion_id_from_gloss("hello") == "HELLO"
    assert motion_id_from_gloss("thank you") == "THANK_YOU"
    assert motion_id_from_gloss("a  lot") == "A_LOT"
    assert motion_id_from_gloss("t-shirt") == "T_SHIRT"
    assert motion_id_from_gloss("don't") == "DONT"
    assert motion_id_from_gloss("100") == "100"
    assert motion_id_from_gloss(None) is None
    assert motion_id_from_gloss("") is None
