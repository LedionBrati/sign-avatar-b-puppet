"""Articulated hand skeleton with joint limits, and an IK fit of it to 21 tracked points.

The skeleton is MANO-shaped: 16 joints (wrist + 3 per finger) plus 5 tips, in MANO joint order.
Each finger joint has only the degrees of freedom a real finger has:

    MCP (knuckle):  flexion + side-to-side spread       2 DoF
    PIP, DIP:       flexion only (hinges)               1 DoF each
    thumb CMC:      flexion + abduction + axial roll     3 DoF
    thumb MCP:      flexion + a little abduction         2 DoF
    thumb IP:       flexion only                         1 DoF

and each DoF has a range (JOINT_LIMITS, degrees). Bone lengths are fixed (REST, a standard adult
hand, 17.9 cm wrist to middle tip). So whatever the tracker says, the fitted hand cannot bend a
finger backwards, sideways at a hinge, or change length.

Frames (all right-handed):
- Canonical hand frame (right hand, rest pose = flat hand): +x wrist -> fingers, +y out of the
  palm (palmar side), +z toward the thumb (radial side).
- A left hand is fitted as a mirrored right hand (x -> -x in camera space) and mirrored back, so the
  left rest pose is REST with x negated in camera space and left quaternions are (qx, -qy, -qz, qw)
  of the mirrored right solution (see mirror_quat).
- Camera axes (input and output joints): x right in the image, y down, z away from the camera.
  These are the axes of MediaPipe's poseWorld / handWorld.

Rotations (`rot` in FORMAT.md v2) follow the MANO convention: 16 local rotations, joint j relative
to its parent, about axes aligned with the canonical frame in rest (rest = identity everywhere).
rot[0] maps the canonical frame to camera axes. FK: world[0] = rot[0]; world[j] = world[parent] @ rot[j];
p[child] = p[j] + world[j] @ (REST[child] - REST[j]).
"""
from __future__ import annotations

import math
import os

# Everything here is thousands of tiny matrix ops. A multi-threaded BLAS spins up threads for each
# one and was ~30x slower on the 12-thread laptop. Must be set before numpy loads.
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np  # noqa: E402
from scipy.spatial.transform import Rotation

# ---------------------------------------------------------------- joint orders

# MANO joint order: 0 wrist, 1-3 index, 4-6 middle, 7-9 pinky, 10-12 ring, 13-15 thumb.
# We add the 5 tips as 16-20 (thumb, index, middle, ring, pinky tip), as MANO-based models do.
MANO_NAMES = ["wrist", "index1", "index2", "index3", "middle1", "middle2", "middle3",
              "pinky1", "pinky2", "pinky3", "ring1", "ring2", "ring3", "thumb1", "thumb2", "thumb3",
              "thumb_tip", "index_tip", "middle_tip", "ring_tip", "pinky_tip"]
MANO_PARENT = [-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 0, 10, 11, 0, 13, 14, 15, 3, 6, 12, 9]
# MediaPipe hand index of each MANO joint (0-15) and tip (16-20).
MANO_TO_MP = [0, 5, 6, 7, 9, 10, 11, 17, 18, 19, 13, 14, 15, 1, 2, 3, 4, 8, 12, 16, 20]
MP_TO_MANO = [MANO_TO_MP.index(k) for k in range(21)]

# Fingers as chains of MediaPipe indices (root on the palm -> tip).
FINGERS = {
    "thumb": [1, 2, 3, 4],
    "index": [5, 6, 7, 8],
    "middle": [9, 10, 11, 12],
    "ring": [13, 14, 15, 16],
    "pinky": [17, 18, 19, 20],
}
PALM = [0, 5, 9, 13, 17]  # wrist + 4 knuckles: the near-rigid part used for the global orientation

# ---------------------------------------------------------------- rest skeleton (right hand)

# Knuckle (MCP) positions in the canonical frame, metres, and phalanx lengths (proximal, middle, distal).
# Proportions from adult hand anthropometry; total wrist -> middle tip 0.179 m.
_MCP = {"index": (0.083, 0.0, 0.025), "middle": (0.085, 0.0, 0.005),
        "ring": (0.080, 0.002, -0.014), "pinky": (0.072, 0.004, -0.031)}
_PHAL = {"index": (0.040, 0.023, 0.020), "middle": (0.045, 0.027, 0.022),
         "ring": (0.042, 0.026, 0.022), "pinky": (0.033, 0.019, 0.019)}
# Natural fan of the fingers in the flat rest pose: rotation about +y, degrees (+ = toward the thumb).
_SPLAY = {"index": 6.0, "middle": 0.0, "ring": -5.0, "pinky": -12.0}
# Oblique flexion axes, degrees of roll about the finger: the ring and little fingers' joint axes are
# tilted, so a curling finger also moves toward the thumb (a fist converges toward the base of the
# thumb). Without this a fist reads as "bent sideways" and the fitted fist looks splayed.
_ROLL = {"index": 0.0, "middle": 5.0, "ring": 10.0, "pinky": 15.0}
# Thumb: CMC position, bone lengths (metacarpal, proximal, distal), rest direction, and the
# direction the tip moves when the thumb flexes (toward the palm and the fingers).
_THUMB_CMC = (0.025, 0.010, 0.020)
_THUMB_LEN = (0.040, 0.032, 0.026)
_THUMB_DIR = (0.70, 0.20, 0.68)
_THUMB_FLEX_TOWARD = (0.0, 0.7, -0.7)


def _unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def _rot_y(deg):
    return Rotation.from_euler("y", deg, degrees=True).as_matrix()


def _rot_x(deg):
    return Rotation.from_euler("x", deg, degrees=True).as_matrix()


def _anat_frame(x_dir, flex_toward):
    """Rotation whose columns are (bone direction, flexion direction, flexion axis)."""
    x = _unit(x_dir)
    y = _unit(np.asarray(flex_toward, float) - np.dot(flex_toward, x) * x)
    z = np.cross(x, y)
    return np.stack([x, y, z], axis=1)


def _build_rest():
    rest = np.zeros((21, 3))  # MediaPipe order
    frames = {}
    for f, ch in FINGERS.items():
        if f == "thumb":
            B = _anat_frame(_THUMB_DIR, _THUMB_FLEX_TOWARD)
            root, lens = np.array(_THUMB_CMC), _THUMB_LEN
        else:
            # columns: splayed finger direction, flexion direction (palmar, a little toward the thumb), axis
            B = _rot_y(-_SPLAY[f]) @ _rot_x(_ROLL[f])
            root, lens = np.array(_MCP[f]), _PHAL[f]
        frames[f] = B
        rest[ch[0]] = root
        p = root
        for k, L in enumerate(lens):
            p = p + L * B[:, 0]
            rest[ch[k + 1]] = p
    return rest, frames


REST_MP, ANAT = _build_rest()  # REST_MP: 21 x 3 in MediaPipe order; ANAT[finger]: 3x3 joint frame in rest
REST = REST_MP[MANO_TO_MP]  # MANO order (16 joints + 5 tips)

# ---------------------------------------------------------------- joint limits

# Degrees. Each finger's parameters: [mcp_flex, mcp_spread, pip_flex, dip_flex] (spread + = toward thumb).
# Thumb: [cmc_flex, cmc_abd, cmc_roll, mcp_flex, mcp_abd, ip_flex].
# Active ranges of motion from the hand-therapy literature, with ~5-10 deg slack for tracker noise
# and individual variation. Spread is measured from the natural fan (_SPLAY).
JOINT_LIMITS = {
    "index": [(-25, 95), (-15, 25), (-8, 110), (-15, 90)],
    "middle": [(-25, 95), (-20, 20), (-8, 110), (-15, 90)],
    "ring": [(-25, 95), (-20, 15), (-8, 110), (-15, 90)],
    "pinky": [(-30, 95), (-35, 15), (-8, 110), (-15, 90)],
    "thumb": [(-25, 55), (-30, 45), (-20, 45), (-15, 70), (-15, 15), (-25, 90)],
}
PARAM_NAMES = {
    "index": ["mcp_flex", "mcp_spread", "pip_flex", "dip_flex"],
    "thumb": ["cmc_flex", "cmc_abd", "cmc_roll", "mcp_flex", "mcp_abd", "ip_flex"],
}
for _f in ("middle", "ring", "pinky"):
    PARAM_NAMES[_f] = PARAM_NAMES["index"]
FINGER_ORDER = ["thumb", "index", "middle", "ring", "pinky"]
N_PARAMS = sum(len(JOINT_LIMITS[f]) for f in FINGER_ORDER)  # 22


def _bounds_rad(f):
    lo = np.radians([a for a, _ in JOINT_LIMITS[f]])
    hi = np.radians([b for _, b in JOINT_LIMITS[f]])
    return lo, hi


def limits_vector():
    """(lo, hi) radians for the full 22-parameter vector in FINGER_ORDER."""
    lo, hi = zip(*(_bounds_rad(f) for f in FINGER_ORDER))
    return np.concatenate(lo), np.concatenate(hi)


def split_params(theta):
    out, k = {}, 0
    for f in FINGER_ORDER:
        n = len(JOINT_LIMITS[f])
        out[f] = np.asarray(theta[k:k + n], dtype=float)
        k += n
    return out


# ---------------------------------------------------------------- forward kinematics

def _Rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _Ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _Rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def finger_local_rots(f, p):
    """Local rotations (canonical-frame axes) of the 3 joints of finger f from its parameters."""
    B = ANAT[f]
    if f == "thumb":
        cmc_flex, cmc_abd, cmc_roll, mcp_flex, mcp_abd, ip_flex = p
        anat = [_Ry(-cmc_abd) @ _Rz(cmc_flex) @ _Rx(cmc_roll), _Ry(-mcp_abd) @ _Rz(mcp_flex), _Rz(ip_flex)]
    else:
        mcp_flex, spread, pip, dip = p
        # spread about the palm normal, then flexion about the (spread) knuckle axis.
        # In the anatomical frame +y is palmar, so a rotation about -y moves the finger toward +z (thumb).
        anat = [_Ry(-spread) @ _Rz(mcp_flex), _Rz(pip), _Rz(dip)]
    return [B @ A @ B.T for A in anat]


def fk_local(theta):
    """Joint positions (21 x 3, MediaPipe order) in the canonical frame and the 15 local rotations
    in MANO order (index 1..15), for a 22-parameter vector."""
    P = split_params(theta)
    pts = REST_MP.copy()
    local = [np.eye(3)] * 16
    for f in FINGER_ORDER:
        ch = FINGERS[f]
        rots = finger_local_rots(f, P[f])
        W = np.eye(3)
        for k in range(3):
            W = W @ rots[k]
            pts[ch[k + 1]] = pts[ch[k]] + W @ (REST_MP[ch[k + 1]] - REST_MP[ch[k]])
            local[MP_TO_MANO[ch[k]]] = rots[k]
    return pts, local


def fk(R0, theta):
    """Camera-space joints (21 x 3, MediaPipe order, wrist at the origin) for global rotation R0."""
    pts, _ = fk_local(theta)
    return pts @ R0.T


def fk_from_rot(rot_quats, rest=REST):
    """FK from 16 MANO-order quaternions [qx,qy,qz,qw] and a rest skeleton (21 x 3 MANO order incl.
    tips). Returns 21 x 3 joints in MANO order. This is what a v2 reader does with `rot`."""
    R = Rotation.from_quat(np.asarray(rot_quats, float)).as_matrix()
    world = [None] * 21
    pos = np.zeros((21, 3))
    world[0] = R[0]
    for j in range(1, 21):
        par = MANO_PARENT[j]
        pos[j] = pos[par] + world[par] @ (rest[j] - rest[par])
        if j < 16:
            world[j] = world[par] @ R[j]
    return pos


def mirror_quat(q):
    """Quaternion of S R S for the reflection S = diag(-1, 1, 1): (qx, -qy, -qz, qw)."""
    q = np.asarray(q, float)
    return np.stack([q[..., 0], -q[..., 1], -q[..., 2], q[..., 3]], axis=-1)


# ---------------------------------------------------------------- measuring raw angles

def palm_frame(pts):
    """Canonical-frame axes (3x3, columns x,y,z) of a right hand from its points (MediaPipe order).

    x: wrist -> middle knuckle; z: toward the index knuckle side, orthogonal to x; y = z cross x
    (out of the palm for a right hand)."""
    pts = np.asarray(pts, float)
    x = _unit(pts[9] - pts[0])
    t = pts[5] - pts[17]
    z = _unit(t - np.dot(t, x) * x)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


def kabsch(A, B):
    """Rotation R minimising sum |R a_i - b_i|^2 for centred point sets (n x 3)."""
    A = A - A.mean(0)
    B = B - B.mean(0)
    U, _, Vt = np.linalg.svd(A.T @ B)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    return Vt.T @ D @ U.T


def global_rotation(pts):
    """Rotation from the canonical frame to camera axes, from the palm points (scale-free)."""
    pts = np.asarray(pts, float)
    obs = pts[PALM] - pts[0]
    s = np.linalg.norm(obs[2])  # wrist -> middle knuckle
    ref = REST_MP[PALM]
    if s < 1e-9:
        return np.eye(3)
    obs = obs * (np.linalg.norm(ref[2]) / s)
    # Kabsch alone is pulled around by the knuckle arch; seed it with the palm frame and keep
    # whichever explains the palm better.
    Rk = kabsch(ref, obs)
    Rp = palm_frame(pts)
    def err(R):
        return np.sum((ref @ R.T - obs) ** 2)
    return Rk if err(Rk) <= err(Rp) else Rp


def _bend(u, v):
    return math.degrees(math.acos(float(np.clip(np.dot(_unit(u), _unit(v)), -1.0, 1.0))))


def raw_angles(pts):
    """Unconstrained joint angles (degrees) measured straight from 21 points (right hand, camera
    axes), for counting impossible poses.

    Fingers 2-5: knuckle flexion and spread (decomposed like the model: spread about the palm
    normal, then flexion), then for PIP and DIP the signed flexion (+ = toward the palm) and the
    sideways bend out of the finger's flexion plane (a hinge should give ~0).

    The hinge axis comes from the palm (the knuckle axis turned by the spread) while the knuckle is
    flexed less than ~70 deg. Past that, the spread and so the axis cannot be read from the palm (a
    curled finger also converges toward the thumb base), so the PIP's own bend plane is used and the
    check becomes "are the three phalanges in one plane", which two parallel hinges require. PIP
    sideways is then not measured (0).
    Thumb: unsigned bend at MCP and IP (its roll makes signed angles ambiguous)."""
    pts = np.asarray(pts, float)
    R = global_rotation(pts)
    q = (pts - pts[0]) @ R  # into the canonical frame
    out = {}
    for f in ("index", "middle", "ring", "pinky"):
        ch = FINGERS[f]
        B = ANAT[f]
        bones = [_unit(q[ch[k + 1]] - q[ch[k]]) for k in range(3)]
        vb = B.T @ bones[0]
        observable = math.hypot(vb[0], vb[2]) > 0.35  # knuckle flexed less than ~70 deg
        spread = math.degrees(math.atan2(vb[2], abs(vb[0]))) if observable else 0.0
        mflex = math.degrees(math.atan2(vb[1], math.hypot(vb[0], vb[2])))
        if vb[0] < 0:  # flexed past 90 deg (or bent back past 90)
            mflex = math.copysign(180.0, vb[1]) - mflex
        axis = B @ _Ry(-math.radians(spread)) @ np.array([0.0, 0.0, 1.0])  # hinge axis from the palm
        if not observable:
            n = np.cross(bones[0], bones[1])
            if np.linalg.norm(n) > math.sin(math.radians(15)):  # the PIP is bent: use its plane
                axis = _unit(n) * (1.0 if np.dot(n, axis) >= 0 else -1.0)
        flex, side = [mflex], [spread]
        for k in (1, 2):
            u, v = bones[k - 1], bones[k]
            zv = _unit(axis - np.dot(axis, u) * u)
            yv = np.cross(zv, u)
            flex.append(math.degrees(math.atan2(np.dot(v, yv), np.dot(v, u))))
            sd = math.degrees(math.asin(np.clip(np.dot(v, zv), -1.0, 1.0)))
            side.append(0.0 if (k == 1 and not observable) else sd)
        out[f] = {"flex": flex, "side": side}
    ch = FINGERS["thumb"]
    out["thumb"] = {"bend": [_bend(q[ch[1]] - q[ch[0]], q[ch[2]] - q[ch[1]]),
                             _bend(q[ch[2]] - q[ch[1]], q[ch[3]] - q[ch[2]])]}
    return out


# Thresholds for an anatomically impossible pose in RAW points, degrees: well past JOINT_LIMITS,
# so only clear errors count, not borderline poses.
IMPOSSIBLE = {
    "hyperext": -35.0,  # PIP or DIP bent backwards more than this
    "hinge_side": 30.0,  # PIP or DIP bent sideways more than this (a hinge cannot)
    "mcp_flex": (-50.0, 115.0),  # knuckle flexion outside this
    "mcp_spread": 45.0,  # knuckle spread past this
    "thumb_bend": 110.0,  # thumb MCP or IP bent more than this
}


def impossible_joints(pts):
    """List of (finger, reason) where 21 raw points imply a pose a human hand cannot make."""
    a = raw_angles(pts)
    bad = []
    for f in ("index", "middle", "ring", "pinky"):
        fl, sd = a[f]["flex"], a[f]["side"]
        if min(fl[1], fl[2]) < IMPOSSIBLE["hyperext"]:
            bad.append((f, "hyperextended hinge"))
        if max(abs(sd[1]), abs(sd[2])) > IMPOSSIBLE["hinge_side"]:
            bad.append((f, "hinge bent sideways"))
        lo, hi = IMPOSSIBLE["mcp_flex"]
        if not lo <= fl[0] <= hi:
            bad.append((f, "knuckle out of range"))
        if abs(sd[0]) > IMPOSSIBLE["mcp_spread"]:
            bad.append((f, "spread out of range"))
    if max(a["thumb"]["bend"]) > IMPOSSIBLE["thumb_bend"]:
        bad.append(("thumb", "thumb joint out of range"))
    return bad



# ---------------------------------------------------------------- IK fit (all frames of a run at once)
#
# Per finger, the residuals compare unit bone directions (and the root -> tip direction) of the
# model with the observation, in the finger's anatomical frame. Fingers are independent given the
# wrist rotation, so the four long fingers are solved together as rows of one array. The solver
# is a projected Levenberg-Marquardt, vectorised over rows: limits are enforced by clipping after
# every step. (scipy's bounded least_squares per frame gave the same angles but was ~50x slower.)

W_BONE = 1.0  # unit bone direction mismatch, per bone
W_TIP = 0.5  # direction root -> tip, stabilises the whole finger
W_PREV = 0.15  # pull toward the neighbours' median angles (radians) in the second pass
W_COUPLE = 0.15  # soft DIP ~= 2/3 PIP coupling (tendons couple them in real fingers)
LONG = ["index", "middle", "ring", "pinky"]


def _bRz(a):
    c, s = np.cos(a), np.sin(a)
    o, z = np.ones_like(a), np.zeros_like(a)
    return np.stack([np.stack([c, -s, z], -1), np.stack([s, c, z], -1), np.stack([z, z, o], -1)], -2)


def _bRy(a):
    c, s = np.cos(a), np.sin(a)
    o, z = np.ones_like(a), np.zeros_like(a)
    return np.stack([np.stack([c, z, s], -1), np.stack([z, o, z], -1), np.stack([-s, z, c], -1)], -2)


def _bRx(a):
    c, s = np.cos(a), np.sin(a)
    o, z = np.ones_like(a), np.zeros_like(a)
    return np.stack([np.stack([o, z, z], -1), np.stack([z, c, -s], -1), np.stack([z, s, c], -1)], -2)


def _bunit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def _long_dirs(p):
    """(N,4) [mcp_flex, spread, pip, dip] -> bone directions (N,3,3) in the anatomical frame."""
    phi = np.cumsum(p[:, [0, 2, 3]], axis=1)
    cs, ss = np.cos(p[:, 1])[:, None], np.sin(p[:, 1])[:, None]
    return np.stack([np.cos(phi) * cs, np.sin(phi), np.cos(phi) * ss], -1)


def _thumb_mats(p):
    """(N,6) thumb parameters -> cumulative anatomical rotations of its 3 bones and the locals."""
    A1 = _bRy(-p[:, 1]) @ _bRz(p[:, 0]) @ _bRx(p[:, 2])
    L2 = _bRy(-p[:, 4]) @ _bRz(p[:, 3])
    L3 = _bRz(p[:, 5])
    C2 = A1 @ L2
    return (A1, C2, C2 @ L3), (A1, L2, L3)


def _thumb_dirs(p):
    C = _thumb_mats(p)[0]
    return np.stack([C[0][..., 0], C[1][..., 0], C[2][..., 0]], 1)


def _residuals(dirs_fn, p, lens, ob, ot, prior, couple):
    d = dirs_fn(p)
    tip = _bunit(np.einsum("nk,nkc->nc", lens, d))
    r = [W_BONE * (d - ob).reshape(len(p), -1), W_TIP * (tip - ot)]
    if prior is not None:
        r.append(W_PREV * (p - prior))
    if couple:
        r.append(W_COUPLE * (p[:, 3] - 0.67 * p[:, 2])[:, None])
    return np.concatenate(r, axis=1)


def _lm(dirs_fn, lens, ob, ot, p0, lo, hi, prior=None, couple=False, iters=20):
    """Projected LM over rows. lo/hi: (N, n) limits."""
    p = np.clip(p0, lo, hi)
    n = p.shape[1]
    lam = np.full(len(p), 1e-2)
    r = _residuals(dirs_fn, p, lens, ob, ot, prior, couple)
    cost = np.einsum("nm,nm->n", r, r)
    eps = 1e-5
    E = np.eye(n)
    for _ in range(iters):
        J = np.stack([(_residuals(dirs_fn, p + eps * E[k], lens, ob, ot, prior, couple) - r) / eps
                      for k in range(n)], -1)
        JtJ = np.einsum("nmi,nmj->nij", J, J)
        g = np.einsum("nmi,nm->ni", J, r)
        A = JtJ + lam[:, None, None] * (E + E * np.einsum("nii->ni", JtJ)[:, :, None])
        step = np.linalg.solve(A, -g[..., None])[..., 0]
        pn = np.clip(p + step, lo, hi)
        rn = _residuals(dirs_fn, pn, lens, ob, ot, prior, couple)
        cn = np.einsum("nm,nm->n", rn, rn)
        ok = cn < cost
        p = np.where(ok[:, None], pn, p)
        r = np.where(ok[:, None], rn, r)
        cost = np.where(ok, cn, cost)
        lam = np.where(ok, lam * 0.3, lam * 10.0)
        if np.abs(step).max() < 1e-4:
            break
    return p


def _init_long(ob):
    """Analytic start: knuckle spread/flexion from the first bone, hinge flexion from the next."""
    d0 = ob[:, 0]
    s = np.arctan2(d0[:, 2], np.maximum(d0[:, 0], 1e-3))
    f1 = np.arctan2(d0[:, 1], np.hypot(d0[:, 0], d0[:, 2]))
    ax = np.stack([-np.sin(s), np.zeros_like(s), np.cos(s)], -1)  # the hinge axis, Ry(-s) e_z

    def rel(a, b):  # signed flexion of bone b relative to bone a about the hinge axis
        y = np.cross(ax, a)
        return np.arctan2(np.einsum("nc,nc->n", b, y), np.einsum("nc,nc->n", b, a))

    return np.stack([f1, s, rel(ob[:, 0], ob[:, 1]), rel(ob[:, 1], ob[:, 2])], -1)


def _observe(Q, f):
    """Observed unit bone directions (T,3,3) and root->tip direction (T,3), anatomical frame."""
    ch = FINGERS[f]
    qa = Q @ ANAT[f]  # points are rows: q @ B is B^T q, the anatomical frame
    ob = _bunit(np.stack([qa[:, ch[k + 1]] - qa[:, ch[k]] for k in range(3)], 1))
    return ob, _bunit(qa[:, ch[3]] - qa[:, ch[0]])


def _median3(p):
    pad = np.concatenate([p[:1], p, p[-1:]])
    return np.median(np.stack([pad[:-2], pad[1:-1], pad[2:]]), axis=0)


def fit_hands_batch(P, temporal=True):
    """Fit the skeleton to (T, 21, 3) RIGHT-hand points (MediaPipe order, camera axes, any scale).

    Returns R0 (T,3,3) wrist rotation (canonical -> camera), theta (T,22) joint angles in radians
    (FINGER_ORDER, inside JOINT_LIMITS), fit_mm (T,) mean joint distance between the fit and the
    observation scaled to the rest hand size. With `temporal` (pass one continuous run of frames),
    a second pass pulls each frame toward its neighbours' median angles (W_PREV): it steadies
    single blurred frames without flattening real handshape changes."""
    P = np.asarray(P, float)
    P = P - P[:, :1]
    T = len(P)
    R0 = np.stack([global_rotation(p) for p in P])
    s = np.linalg.norm(REST_MP[9]) / np.maximum(np.linalg.norm(P[:, 9], axis=1), 1e-9)
    Q = np.einsum("tjc,tcd->tjd", P * s[:, None, None], R0)  # canonical frame, rest scale

    obs = [_observe(Q, f) for f in LONG]
    ob = np.concatenate([o[0] for o in obs])
    ot = np.concatenate([o[1] for o in obs])
    lens_l = np.repeat(np.array([_PHAL[f] for f in LONG]), T, axis=0)
    lo_l = np.repeat(np.stack([_bounds_rad(f)[0] for f in LONG]), T, axis=0)
    hi_l = np.repeat(np.stack([_bounds_rad(f)[1] for f in LONG]), T, axis=0)
    pl = _lm(_long_dirs, lens_l, ob, ot, _init_long(ob), lo_l, hi_l, couple=True)

    obt, ott = _observe(Q, "thumb")
    lens_t = np.repeat(np.array([_THUMB_LEN]), T, axis=0)
    lo_t, hi_t = (np.repeat(b[None], T, axis=0) for b in _bounds_rad("thumb"))
    pt = _lm(_thumb_dirs, lens_t, obt, ott, np.zeros((T, 6)), lo_t, hi_t)

    if temporal and T >= 3:
        prior_l = np.concatenate([_median3(pl[k * T:(k + 1) * T]) for k in range(4)])
        pl = _lm(_long_dirs, lens_l, ob, ot, pl, lo_l, hi_l, prior=prior_l, couple=True, iters=8)
        pt = _lm(_thumb_dirs, lens_t, obt, ott, pt, lo_t, hi_t, prior=_median3(pt), iters=8)

    theta = np.concatenate([pt] + [pl[k * T:(k + 1) * T] for k in range(4)], axis=1)
    model, _ = fk_batch(theta)
    fit_mm = np.mean(np.linalg.norm(model - Q, axis=2), axis=1) * 1000.0
    return R0, theta, fit_mm


def fk_batch(theta):
    """Vectorised fk_local: canonical joints (T,21,3) MediaPipe order, local rotations (T,16,3,3)
    MANO order (index 0 = identity; put the wrist rotation there yourself)."""
    theta = np.atleast_2d(theta)
    T = len(theta)
    P = split_params(theta.T)
    pts = np.repeat(REST_MP[None], T, axis=0).copy()
    local = np.repeat(np.eye(3)[None, None], T, axis=0).repeat(16, axis=1).copy()
    for f in FINGER_ORDER:
        B = ANAT[f]
        p = P[f].T
        if f == "thumb":
            C, L = _thumb_mats(p)
            d = np.stack([C[0][..., 0], C[1][..., 0], C[2][..., 0]], 1)
            lens = _THUMB_LEN
        else:
            d = _long_dirs(p)
            L = (_bRy(-p[:, 1]) @ _bRz(p[:, 0]), _bRz(p[:, 2]), _bRz(p[:, 3]))
            lens = _PHAL[f]
        ch = FINGERS[f]
        bones = np.einsum("k,tkc->tkc", np.array(lens), d) @ B.T  # back to the canonical frame
        pts[:, ch[1:]] = REST_MP[ch[0]] + np.cumsum(bones, axis=1)
        for k in range(3):
            local[:, MP_TO_MANO[ch[k]]] = B @ L[k] @ B.T
    return pts, local


def fit_hand(pts):
    """Single-frame convenience wrapper around fit_hands_batch: (R0, theta, fit_mm)."""
    R0, th, mm = fit_hands_batch(np.asarray(pts, float)[None], temporal=False)
    return R0[0], th[0], float(mm[0])


def theta_to_rot(R0, theta):
    """16 MANO-order quaternions [qx,qy,qz,qw]: rot[0] = R0, rot[1..15] = local joint rotations.
    Batched: R0 (T,3,3), theta (T,22) -> (T,16,4); or single frame (3,3), (22,) -> (16,4)."""
    single = np.ndim(theta) == 1
    R0 = np.asarray(R0, float).reshape(-1, 3, 3)
    _, local = fk_batch(theta)
    local[:, 0] = R0
    q = Rotation.from_matrix(local.reshape(-1, 3, 3)).as_quat().reshape(len(R0), 16, 4)
    return q[0] if single else q
