"""Brazo derecho solo, 4 vistas grandes (como se ve en Bambu)."""
import bpy, os, math
from mathutils import Vector
BASE = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
bpy.ops.wm.stl_import(filepath=os.path.join(BASE, "stl_final", "P4_brazo_derecho.stl")); o = bpy.context.active_object
m = bpy.data.materials.new("m"); m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.75, 0.08, 0.08, 1); o.data.materials.append(m)
bpy.ops.object.shade_smooth()
c = Vector([sum(v[i] for v in o.bound_box) / 8 for i in range(3)]); c = o.matrix_world @ c
w = bpy.data.worlds.new("w"); sc.world = w; w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
for loc, e in (((0.3, -0.4, 0.5), 6), ((-0.3, 0.3, 0.3), 3)):
    bpy.ops.object.light_add(type="AREA", location=loc); l = bpy.context.active_object; l.data.energy = e; l.data.size = 0.5
    l.rotation_euler = (c - l.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam; cam.data.lens = 70
sc.render.engine = "BLENDER_EEVEE"; sc.render.resolution_x = sc.render.resolution_y = 600; sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True
for n, az, el in (("frente", -90, 5), ("afuera", 0, 5), ("adentro", 180, 5), ("tres_cuartos", -45, 20)):
    a = math.radians(az); d = 0.45
    cam.location = c + Vector((d * math.cos(a), d * math.sin(a), d * math.sin(math.radians(el))))
    cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(BASE, f"brazo_{n}.png"); bpy.ops.render.render(write_still=True)
print("OK")
