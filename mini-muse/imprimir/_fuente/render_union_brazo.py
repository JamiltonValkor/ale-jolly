"""Corte del brazo derecho por el eje: pared hueca + eje macizo pasante + tarugo con filete."""
import bpy, os, json, math
from mathutils import Vector
BASE = os.path.dirname(os.path.abspath(__file__)); R = json.load(open(os.path.join(BASE, "reporte_final.json")))["_param"]
EY, EZ = R["EJE"][1], R["EJE"][2]
bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
bpy.ops.wm.stl_import(filepath=os.path.join(BASE, "stl_final", "P4_brazo_derecho.stl")); o = bpy.context.active_object
m = bpy.data.materials.new("m"); m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.42, 0.28, 1); o.data.materials.append(m); m.use_backface_culling = False
bpy.context.view_layer.objects.active = o; bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.bisect(plane_co=(0, EY, 0), plane_no=(0, -1, 0), clear_outer=True, use_fill=False); bpy.ops.object.mode_set(mode="OBJECT")
w = bpy.data.worlds.new("w"); sc.world = w; w.node_tree.nodes["Background"].inputs[1].default_value = 0.5
for loc, e in (((0.1, -0.5, 0.4), 4), ((0.4, -0.3, 0.1), 1.5)):
    bpy.ops.object.light_add(type="AREA", location=loc); l = bpy.context.active_object; l.data.energy = e; l.data.size = 0.5
    l.rotation_euler = (Vector((0.1, EY, 0.14)) - l.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add(location=(0.13, -0.42, 0.16)); cam = bpy.context.active_object; sc.camera = cam; cam.data.lens = 85
cam.rotation_euler = (Vector((0.11, EY, 0.14)) - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.render.engine = "BLENDER_EEVEE"; sc.render.resolution_x, sc.render.resolution_y = 800, 900; sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True; sc.render.filepath = os.path.join(BASE, "union_brazo_corte.png"); bpy.ops.render.render(write_still=True); print("OK")
