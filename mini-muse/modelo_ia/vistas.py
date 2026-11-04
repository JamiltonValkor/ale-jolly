"""Renderiza una malla (z arriba, -y frente) en 4 vistas como las de referencia.

blender -b -P modelo_ia/vistas.py -- malla.ply salida_prefijo [color r,g,b]
"""
import bpy, sys, os, math
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
MALLA, SALIDA = args[0], args[1]
COLOR = tuple(float(x) for x in args[2].split(",")) if len(args) > 2 else (0.80, 0.70, 0.55)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.wm.ply_import(filepath=MALLA)
o = bpy.context.active_object
bpy.ops.object.shade_smooth()
# normalizar: base en z=0, centrado en x,y
mn = Vector([min(v.co[i] for v in o.data.vertices) for i in range(3)])
mx = Vector([max(v.co[i] for v in o.data.vertices) for i in range(3)])
H = mx.z - mn.z
o.location = (-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)
mat = bpy.data.materials.new("m")
b = mat.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (*COLOR, 1); b.inputs["Roughness"].default_value = 0.7
o.data.materials.append(mat)

w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
for loc, e in (((-2, -3, 3), 400), ((3, -1, 1), 150), ((0, 3, 2), 200)):
    bpy.ops.object.light_add(type="AREA", location=[c * H for c in loc])
    l = bpy.context.active_object; l.data.energy = e * H * H; l.data.size = H
    l.rotation_euler = (Vector((0, 0, H / 2)) - l.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = H * 1.15
sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys() else "BLENDER_EEVEE_NEXT"
sc.render.resolution_x = sc.render.resolution_y = 700
sc.view_settings.view_transform = "Standard"
# frente (-y), 3/4, espalda (+y), lado (cara mirando a la izquierda de la imagen)
for nombre, az in (("frente", -90), ("tres_cuartos", -60), ("espalda", 90), ("lado", 0)):
    a = math.radians(az)
    cam.location = (3 * H * math.cos(a), 3 * H * math.sin(a), H * 0.5)
    cam.rotation_euler = (Vector((0, 0, H * 0.5)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = f"{SALIDA}_{nombre}.png"
    bpy.ops.render.render(write_still=True)
print("VISTAS_OK")
