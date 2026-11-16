# Build the reference avatar (puppet/models/signer.glb) with MPFB (MakeHuman for Blender), headless.
#
#   BLENDER_USER_RESOURCES=<dir with MPFB installed> blender --background --python puppet/avatar/build_avatar.py -- \
#       --assets <unzipped makehuman_system_assets_cc0> --out puppet/models/signer.glb
#
# puppet/avatar/build.mjs downloads MPFB and the asset pack and runs this for you.
#
# What it makes: a woman with realistic proportions, MakeHuman "mixamo" rig (3 bones per finger and thumb,
# plus tip bones), skin texture, brown eyes, short dark bob, and a black long-sleeve top painted onto the
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
args = ap.parse_args(argv)

importlib.import_module("bl_ext.user_default.mpfb")
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.exportservice import ExportService

A = lambda *p: os.path.join(args.assets, *p)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

macro = {"gender": 0.0, "age": 0.55, "muscle": 0.5, "weight": 0.45, "proportions": 0.75, "height": 0.5,
         "cupsize": 0.3, "firmness": 0.5, "race": {"asian": 0.05, "caucasian": 0.9, "african": 0.05}}
bm = HumanService.create_human(macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(bm, "mixamo")
HumanService.set_character_skin(A("skins", "young_caucasian_female", "young_caucasian_female.mhmat"), bm, skin_type="GAMEENGINE")

assets = [
    ("Eyes", A("eyes", "low-poly", "low-poly.mhclo")),
    ("Eyebrows", A("eyebrows", "eyebrow001", "eyebrow001.mhclo")),
    ("Eyelashes", A("eyelashes", "eyelashes01", "eyelashes01.mhclo")),
    ("Hair", A("hair", args.hair, f"{args.hair}.mhclo")),
]
objs = {}
for kind, path in assets:
    objs[kind] = HumanService.add_mhclo_asset(path, bm, asset_type=kind, material_type="GAMEENGINE")

# bake the body shape and drop the helper geometry (MakeHuman ships clothes-fitting helpers inside the mesh)
TargetService.bake_targets(bm)
ExportService.bake_modifiers_remove_helpers(bm, bake_masks=True, remove_helpers=True)


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
replace_materials(objs["Eyebrows"], principled("eyebrows", (1, 1, 1), 0.8, A("eyebrows", "eyebrow001", "eyebrow001.png"), alpha=True))
replace_materials(objs["Eyelashes"], principled("eyelashes", (1, 1, 1), 0.8, A("eyelashes", "eyelashes01", "eyelashes01.png"), alpha=True))
skin = principled("skin", (1, 1, 1), 0.55, A("skins", "young_caucasian_female", "young_lightskinned_female_diffuse.png"))

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
