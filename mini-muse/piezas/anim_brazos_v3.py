"""Mini-Muse con los bracitos separados moviéndose (piel impresa, sin pelo).

blender -b -P piezas/anim_brazos.py   → piezas/anim/####.png
"""
import bpy, os, math, json
from mathutils import Vector

BASE = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(BASE)
J = json.load(open(os.path.join(BASE, "piezas_v3.json")))
CX, CZ, AX, AZ = 0.0, 0.226, 0.059, 0.046

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def importar(n):
    bpy.ops.wm.ply_import(filepath=os.path.join(BASE, n + ".ply"))
    o = bpy.context.active_object; o.name = n
    bpy.ops.object.shade_smooth()
    return o


piel = bpy.data.materials.new("piel"); pb = piel.node_tree.nodes["Principled BSDF"]
pb.inputs["Base Color"].default_value = (0.66, 0.52, 0.34, 1); pb.inputs["Roughness"].default_value = 0.85
cara = bpy.data.materials.new("cara"); nt = cara.node_tree; N = nt.nodes
tc = N.new("ShaderNodeTexCoord"); sep = N.new("ShaderNodeSeparateXYZ"); com = N.new("ShaderNodeCombineXYZ")
mp = N.new("ShaderNodeMapping")
mp.inputs["Scale"].default_value = (1 / (2 * AX), 1 / (2 * AZ), 1)
mp.inputs["Location"].default_value = (0.5 - CX / (2 * AX), 0.5 - CZ / (2 * AZ), 0)
img = N.new("ShaderNodeTexImage"); img.image = bpy.data.images.load(os.path.join(RAIZ, "modelo_ia", "cara_muse.png")); img.extension = "EXTEND"
nt.links.new(tc.outputs["Object"], sep.inputs[0]); nt.links.new(sep.outputs["X"], com.inputs["X"]); nt.links.new(sep.outputs["Z"], com.inputs["Y"])
nt.links.new(com.outputs[0], mp.inputs["Vector"]); nt.links.new(mp.outputs[0], img.inputs["Vector"])
nt.links.new(img.outputs["Color"], N["Principled BSDF"].inputs["Base Color"])
N["Principled BSDF"].inputs["Roughness"].default_value = 0.6

cuerpo = importar("cuerpo_v3")
cuerpo.data.materials.append(piel); cuerpo.data.materials.append(cara)
for poly in cuerpo.data.polygons:
    p = poly.center
    if p.y < -0.035 and ((p.x - CX) / AX) ** 2 + ((p.z - CZ) / AZ) ** 2 < 1:
        poly.material_index = 1

hombros = {}
for n, sx in (("brazo_der", 1), ("brazo_izq", -1)):
    b = importar(n + "_v3"); b.data.materials.append(piel)
    bpy.ops.object.empty_add(location=tuple(J[n]["eje"]))
    e = bpy.context.active_object; e.name = "hombro_" + n
    b.parent = e; b.matrix_parent_inverse = e.matrix_world.inverted()
    hombros[n] = e

# guion: (segundo, grados brazo_der, grados brazo_izq); negativo = hacia adelante
GUION = [(0, 0, 0), (0.8, 0, 0), (1.8, -150, 0), (2.15, -128, 0), (2.5, -158, 0), (2.85, -128, 0),
         (3.2, -158, 0), (3.55, -128, 0), (3.9, -150, 0), (4.9, 0, 0), (5.3, 0, 0),
         (6.2, 0, -80), (7.4, 0, -80), (8.3, 0, 0), (8.8, 0, 0)]
FPS = 24
sc.render.fps = FPS
for t, d, i in GUION:
    f = int(round(t * FPS)) + 1
    for n, a in (("brazo_der", d), ("brazo_izq", i)):
        e = hombros[n]; e.rotation_euler = (math.radians(a), 0, 0)
        e.keyframe_insert("rotation_euler", frame=f)
sc.frame_start, sc.frame_end = 1, int(GUION[-1][0] * FPS) + 1

w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
bpy.ops.mesh.primitive_plane_add(size=4); bpy.context.active_object.is_shadow_catcher = True
pm = bpy.data.materials.new("piso"); pm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.93, 0.93, 0.93, 1)
bpy.context.active_object.data.materials.append(pm)
for loc, e, s in (((-0.5, -0.7, 0.8), 14, 0.9), ((0.7, -0.5, 0.4), 4, 0.9), ((0.2, 0.7, 0.7), 8, 0.6)):
    bpy.ops.object.light_add(type="AREA", location=loc)
    l = bpy.context.active_object; l.data.energy = e; l.data.size = s
    l.rotation_euler = (Vector((0, 0, 0.15)) - l.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam
cam.data.lens = 70
a = math.radians(-62); cam.location = (0.95 * math.cos(a), 0.95 * math.sin(a), 0.24)
cam.rotation_euler = (Vector((0, 0, 0.165)) - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x = sc.render.resolution_y = 720
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True
sc.render.image_settings.color_mode = "RGBA"
sc.render.filepath = os.path.join(BASE, "anim_v3", "")
bpy.ops.render.render(animation=True)
print("ANIM_OK")
