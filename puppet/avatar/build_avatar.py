# Build the reference avatar (puppet/models/signer.glb) with MPFB (MakeHuman for Blender), headless.
#
#   BLENDER_USER_RESOURCES=<dir with MPFB installed> blender --background --python puppet/avatar/build_avatar.py -- \
#       --assets <unzipped makehuman_system_assets_cc0> --out puppet/models/signer.glb
#
# puppet/avatar/build.mjs downloads MPFB and the asset pack and runs this for you.
#
# What it makes: a woman with realistic proportions, MakeHuman "mixamo" rig (3 bones per finger and thumb,
# plus tip bones), skin texture, brown eyes, long hair (darkened in the player), and a black long-sleeve top painted onto the
# body mesh (sleeves end at the wrist, crew neck), so the skin-tone hands stand out against it.
# Licence: the MakeHuman base mesh, targets, rig and the system assets are CC0; MPFB (the tool) is GPL-3.0,
# its output is not covered by the GPL.
import bpy, sys, os, math, argparse, importlib

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--assets", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--hair", default="long01")
ap.add_argument("--tex", type=int, default=1024, help="max texture size")
ap.add_argument("--look", default="default", choices=["default", "bob"],
                help="bob: the assets/avatar/avatar-main.jpg lookalike (chin-length bob, about 35, olive skin, face shape)")
ap.add_argument("--eyebrows", default=None, help="eyebrow asset (default eyebrow001)")
ap.add_argument("--targets", default="", help="extra face/body targets, name=weight,name=weight (MakeHuman target names)")
ap.add_argument("--skin-tint", default=None, help="r,g,b multiplier for the skin texture (1,1,1 = as shipped)")
ap.add_argument("--part-fringe", type=float, default=None,
                help="delete hair cards in front of the face up to this height above the head joint (m); bob look: 0.16")
ap.add_argument("--preview", default=None, help="also write a face close-up PNG (Cycles, CPU) here")
args = ap.parse_args(argv)

importlib.import_module("bl_ext.user_default.mpfb")
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.exportservice import ExportService

A = lambda *p: os.path.join(args.assets, *p)

# The lookalike of assets/avatar/avatar-main.jpg: a woman of about 35 with olive skin, an oval face with defined
# cheekbones and a narrow chin, straight nose, slight closed-mouth smile, and a dark chin-length bob (MakeHuman
# bob01 with its side fringe removed, darkened in the player like the long hair), medium dark brows.
# Weights are MakeHuman modifier values (0..1). Chosen by eye against avatar-closeup.jpg on Modal previews.
LOOK_BOB = {
    "hair": "bob01", "eyebrows": "eyebrow012", "skin_tint": (0.96, 0.86, 0.75),
    "macro": {"age": 0.58, "race": {"asian": 0.05, "caucasian": 0.83, "african": 0.12}},
    "targets": {"head-oval": 0.55, "head-scale-horiz-decr": 0.12, "chin-width-decr": 0.25, "chin-prominent-incr": 0.15,
                "l-cheek-bones-incr": 0.35, "r-cheek-bones-incr": 0.35, "l-cheek-volume-decr": 0.2, "r-cheek-volume-decr": 0.2,
                "nose-scale-vert-incr": 0.2, "nose-point-width-decr": 0.15, "nose-hump-decr": 0.2,
                "mouth-angles-up": 0.35, "mouth-scale-horiz-incr": 0.08, "mouth-upperlip-volume-decr": 0.15,
                "eyebrows-angle-down": 0.15, "l-eye-scale-decr": 0.1, "r-eye-scale-decr": 0.1},
}
if args.look == "bob":
    if args.hair == "long01":
        args.hair = LOOK_BOB["hair"]
    args.eyebrows = args.eyebrows or LOOK_BOB["eyebrows"]
    args.skin_tint = args.skin_tint or ",".join(map(str, LOOK_BOB["skin_tint"]))
brows = args.eyebrows or "eyebrow001"
targets = dict(LOOK_BOB["targets"]) if args.look == "bob" else {}
for kv in filter(None, args.targets.split(",")):
    k, v = kv.split("=")
    targets[k.strip()] = float(v)
print("LOOK", args.look, "hair", args.hair, "brows", brows, "tint", args.skin_tint, "targets", len(targets))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

macro = {"gender": 0.0, "age": 0.55, "muscle": 0.5, "weight": 0.45, "proportions": 0.75, "height": 0.5,
         "cupsize": 0.3, "firmness": 0.5, "race": {"asian": 0.05, "caucasian": 0.9, "african": 0.05}}
if args.look == "bob":
    macro.update({k: v for k, v in LOOK_BOB["macro"].items()})
bm = HumanService.create_human(macro_detail_dict=macro)
# face/body modifiers go on before the rig and the clothes-style assets, so both are fitted to the final shape
for name, w in targets.items():
    try:
        path = TargetService.target_full_path(name)
    except Exception:
        path = None
    if not path or not os.path.exists(path):
        print("WARN no target", name)
        continue
    TargetService.load_target(bm, path, weight=w, name=name)
    print("TARGET", name, w)
rig = HumanService.add_builtin_rig(bm, "mixamo")
HumanService.set_character_skin(A("skins", "young_caucasian_female", "young_caucasian_female.mhmat"), bm, skin_type="GAMEENGINE")

assets = [
    ("Eyes", A("eyes", "low-poly", "low-poly.mhclo")),
    ("Eyebrows", A("eyebrows", brows, f"{brows}.mhclo")),
    ("Eyelashes", A("eyelashes", "eyelashes01", "eyelashes01.mhclo")),
    ("Hair", A("hair", args.hair, f"{args.hair}.mhclo")),
]
objs = {}
for kind, path in assets:
    objs[kind] = HumanService.add_mhclo_asset(path, bm, asset_type=kind, material_type="GAMEENGINE")

# bake the body shape and drop the helper geometry (MakeHuman ships clothes-fitting helpers inside the mesh)
TargetService.bake_targets(bm)
ExportService.bake_modifiers_remove_helpers(bm, bake_masks=True, remove_helpers=True)

# MakeHuman's bobs have a long side fringe over one eye; the target has an open forehead and a side part.
# Delete the hair cards that hang in front of the face (eyes, cheeks, forehead) and keep the sides and back.
if args.part_fringe is None and args.look == "bob":
    args.part_fringe = 0.16
if args.part_fringe:
    import bmesh as _bmesh
    hj = rig.matrix_world @ rig.data.bones["mixamorig:Head"].head_local
    mw = bm.matrix_world
    face = [mw @ v.co for v in bm.data.vertices if hj.z < (mw @ v.co).z < hj.z + 0.15 and abs((mw @ v.co).x - hj.x) < 0.07]
    face_front = min(c.y for c in face)  # nose tip (MakeHuman faces -Y)
    face_back = hj.y + 0.02
    hair = objs["Hair"]
    hb = _bmesh.new()
    hb.from_mesh(hair.data)
    hmw = hair.matrix_world
    kill = []
    for f in hb.faces:
        c = hmw @ f.calc_center_median()
        if hj.z - 0.06 < c.z < hj.z + args.part_fringe and abs(c.x - hj.x) < 0.066 and c.y < face_back:
            kill.append(f)
    _bmesh.ops.delete(hb, geom=kill, context="FACES")
    hb.to_mesh(hair.data)
    hb.free()
    print("PART fringe: deleted", len(kill), "hair faces, front", round(face_front, 3), "head joint", tuple(round(x, 3) for x in hj))


def principled(name, color, rough, tex=None, alpha=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    if tex:
        t = m.node_tree.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(tex)
        m.node_tree.links.new(t.outputs["Color"], p.inputs["Base Color"])
        if alpha:
            m.node_tree.links.new(t.outputs["Alpha"], p.inputs["Alpha"])
            m.surface_render_method = "DITHERED"
    return m


def replace_materials(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


# plain glTF-friendly materials: one base colour texture each (the MPFB game-engine skin stacks several
# textures, of which glTF keeps only the first, which put lip colour on the nose)
replace_materials(objs["Eyes"], principled("eyes", (1, 1, 1), 0.15, A("eyes", "materials", "brown_eye.png")))
replace_materials(objs["Hair"], principled("hair", (1, 1, 1), 0.55, A("hair", args.hair, f"{args.hair}_diffuse.png"), alpha=True))
replace_materials(objs["Eyebrows"], principled("eyebrows", (1, 1, 1), 0.8, A("eyebrows", brows, f"{brows}.png"), alpha=True))
replace_materials(objs["Eyelashes"], principled("eyelashes", (1, 1, 1), 0.8, A("eyelashes", "eyelashes01", "eyelashes01.png"), alpha=True))
skin = principled("skin", (1, 1, 1), 0.55, A("skins", "young_caucasian_female", "young_lightskinned_female_diffuse.png"))
if args.skin_tint:
    # tint the texture pixels themselves (a glTF baseColorFactor would need a multiply node the exporter may drop)
    import numpy as np
    tint = [float(x) for x in args.skin_tint.split(",")]
    img = skin.node_tree.nodes["Image Texture"].image
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    px[:, :3] *= np.array(tint, dtype=np.float32)
    img.pixels.foreach_set(px.ravel())
    img.update()

# the long-sleeve top: faces that belong mostly to the torso and arms get a black fabric material;
# hands, neck and head keep the skin. Only the rig's deform weights count, so the cuff sits at the wrist joint.
top = principled("top", (0.012, 0.012, 0.014), 0.85)
bm.data.materials.clear()
bm.data.materials.append(skin)
bm.data.materials.append(top)
skin_idx, top_idx = 0, 1
deform = {g.index for g in bm.vertex_groups if g.name.startswith("mixamorig:")}
skin_groups = {g.index for g in bm.vertex_groups if g.name.startswith("mixamorig:") and any(k in g.name for k in ("Hand", "Neck", "Head", "Eye"))}
skin_w = [0.0] * len(bm.data.vertices)
for v in bm.data.vertices:
    s = t = 0.0
    for g in v.groups:
        if g.group not in deform:
            continue
        t += g.weight
        if g.group in skin_groups:
            s += g.weight
    skin_w[v.index] = s / t if t > 0 else 0.0
neck = rig.data.bones["mixamorig:Neck"].head_local
neck_z = neck.z
for poly in bm.data.polygons:
    w = sum(skin_w[i] for i in poly.vertices) / len(poly.vertices)
    c = sum((bm.data.vertices[i].co for i in poly.vertices), bm.data.vertices[poly.vertices[0]].co * 0) / len(poly.vertices)
    # crew neck: a round collar about the neck, a little below the neck joint (front lower than back)
    collar_z = neck_z - (0.035 if c.y < neck.y else 0.015)
    is_neck = c.z > collar_z and math.hypot(c.x - neck.x, c.y - neck.y) < 0.075
    poly.material_index = skin_idx if (w > 0.5 or is_neck) else top_idx

# a top hides the nipples: Laplacian-smooth the front of the chest (rest shape, before skinning)
import bmesh
me = bm.data
spine2 = rig.data.bones["mixamorig:Spine2"]
z0, z1 = spine2.head_local.z - 0.14, neck_z - 0.05
band = [v for v in me.vertices if z0 < v.co.z < z1 and abs(v.co.x) < 0.16]
front = min(v.co.y for v in band)  # MakeHuman faces -Y
sel = {v.index for v in band if v.co.y < front + 0.09}
b = bmesh.new()
b.from_mesh(me)
b.verts.ensure_lookup_table()
for _ in range(25):
    new = {}
    for i in sel:
        v = b.verts[i]
        nb = [e.other_vert(v).co for e in v.link_edges]
        if nb:
            new[i] = sum(nb, v.co * 0) / len(nb)
    for i, co in new.items():
        b.verts[i].co = b.verts[i].co.lerp(co, 0.7)
b.to_mesh(me)
b.free()
# stored custom normals would still shade the old shape
bpy.context.view_layer.objects.active = bm
if me.has_custom_normals:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
for p in me.polygons:
    p.use_smooth = True
print("smoothed chest verts", len(sel), "custom normals left", me.has_custom_normals)

# fingertip and head-top bones (no weights), so the player knows where each finger ends
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = rig.data.edit_bones
for side in ("Left", "Right"):
    for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
        d = eb[f"mixamorig:{side}Hand{f}3"]
        tip = eb.new(f"mixamorig:{side}Hand{f}4")
        tip.head = d.tail
        tip.tail = d.tail + (d.tail - d.head) * 0.5
        tip.parent = d
        tip.use_deform = False
h = eb["mixamorig:Head"]
ht = eb.new("mixamorig:HeadTop_End")
ht.head = h.tail
ht.tail = h.tail + (h.tail - h.head) * 0.3
ht.parent = h
ht.use_deform = False
bpy.ops.object.mode_set(mode="OBJECT")

# smaller textures
for img in bpy.data.images:
    if img.size[0] > args.tex:
        img.scale(args.tex, int(img.size[1] * args.tex / img.size[0]))

for o in bpy.data.objects:
    o.select_set(o == rig or o.parent == rig or o == bm or o in objs.values())
os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", use_selection=True, export_yup=True,
                          export_skins=True, export_morph=False, export_animations=False, export_apply=False,
                          export_image_format="JPEG", export_image_quality=88)
print("WROTE", args.out, "verts", len(bm.data.vertices), "bones", len(rig.data.bones))

if args.preview:
    # face close-up for checking the look (Cycles on the CPU; not what the player shows, but the same mesh and textures)
    scn = bpy.context.scene
    head = rig.matrix_world @ rig.data.bones["mixamorig:Head"].head_local
    cam = bpy.data.objects.new("pcam", bpy.data.cameras.new("pcam"))
    scn.collection.objects.link(cam)
    cam.data.lens, cam.data.sensor_fit, cam.data.sensor_height = 85, "VERTICAL", 36
    cam.location = (head.x, head.y - 1.15, head.z + 0.03)  # MakeHuman faces -Y
    cam.rotation_euler = (math.pi / 2, 0, 0)
    scn.camera = cam
    for nm, loc, energy, size in (("key", (-0.9, -1.3, 0.6), 60, 1.2), ("fill", (1.0, -1.0, 0.3), 20, 1.5)):
        L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, "AREA"))
        L.data.energy, L.data.size = energy, size
        L.location = (head.x + loc[0], head.y + loc[1], head.z + loc[2])
        L.rotation_euler = (head - L.location).to_track_quat("-Z", "Y").to_euler()
        scn.collection.objects.link(L)
    scn.world = scn.world or bpy.data.worlds.new("w")
    scn.world.use_nodes = True
    scn.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.05, 0.048, 1)
    scn.render.engine = "CYCLES"
    scn.cycles.device, scn.cycles.samples, scn.cycles.use_denoising = "CPU", 32, True
    scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = 600, 800, 100
    scn.view_settings.view_transform = "Standard"
    scn.render.filepath = args.preview
    bpy.ops.render.render(write_still=True)
    print("PREVIEW", args.preview)
