"""Renderiza siluetas ortográficas (alfa) de un conjunto de mallas en las vistas de las referencias.

blender -b -P imprimir/siluetas.py -- salida_prefijo malla1 [malla2 ...]
Vistas: frente (cámara en −y), lado (cámara en +x, cara a la izquierda), espalda (cámara en +y).
"""
import bpy, sys, os, math
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
SAL, MALLAS = args[0], args[1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
for f in MALLAS:
    if f.endswith(".stl"):
        bpy.ops.wm.stl_import(filepath=f)
    else:
        bpy.ops.wm.ply_import(filepath=f)
m = bpy.data.materials.new("m"); m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 0, 1)
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.materials.clear(); o.data.materials.append(m)
bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam
cam.data.type = "ORTHO"
zs = [(o.matrix_world @ Vector(c)).z for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box]
Z0, Z1 = min(zs), max(zs); ZC = (Z0 + Z1) / 2; cam.data.ortho_scale = (Z1 - Z0) * 1.25
sc.render.engine = "BLENDER_EEVEE"; sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 720
for nombre, pos in (("frente", (0, -1, ZC)), ("lado", (1, 0, ZC)), ("espalda", (0, 1, ZC))):
    cam.location = pos
    cam.rotation_euler = (Vector((0, 0, ZC)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = f"{SAL}_{nombre}.png"; bpy.ops.render.render(write_still=True)
print("SILUETAS_OK")
