import numpy as np

from clean import ONE_EURO_PARAMS, one_euro

HAND = ONE_EURO_PARAMS["rightHand"]


def test_constant_signal_unchanged():
    x = np.full((50, 3), 0.42)
    assert np.allclose(one_euro(x, 24, **HAND), 0.42)


def test_reduces_noise_on_still_signal():
    rng = np.random.default_rng(0)
    x = 0.5 + rng.normal(0, 0.005, size=(200, 1))
    y = one_euro(x, 24, **HAND)
    assert np.std(np.diff(y[20:, 0])) < 0.6 * np.std(np.diff(x[20:, 0]))


def test_fast_step_is_followed_quickly():
    # a fast handshape change: fingertip jumps 0.1 (about half a hand-length) in one frame
    x = np.concatenate([np.zeros(20), np.full(20, 0.1)])[:, None]
    y = one_euro(x, 24, **HAND)[:, 0]
    assert y[20] > 0.08  # >80% of the step on the very first frame
    assert y[21] > 0.095  # essentially there on the second


def test_high_beta_lags_less_than_low_beta():
    t = np.arange(48) / 24
    x = (0.1 * np.sin(2 * np.pi * 3 * t))[:, None]  # 3 Hz movement
    lag_hi = np.abs(one_euro(x, 24, **HAND)[:, 0] - x[:, 0]).mean()
    lag_lo = np.abs(one_euro(x, 24, HAND["min_cutoff"], 0.0, HAND["d_cutoff"])[:, 0] - x[:, 0]).mean()
    assert lag_hi < 0.5 * lag_lo


def test_empty_and_shape():
    assert one_euro(np.zeros((0, 21, 3)), 24, **HAND).shape == (0, 21, 3)
    assert one_euro(np.zeros((5, 21, 3)), 24, **HAND).shape == (5, 21, 3)
