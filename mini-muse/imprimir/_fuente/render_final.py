"""Render del diseño FINAL tal como sale impreso: piezas reales (con el pelo modelado) + la cara en la pantalla.

blender -b -P imprimir/render_final.py
"""
import bpy, os, math, json
from mathutils import Vector

BASE = os.path.dirname(os.path.abspath(__file__))
STL = os.path.join(BASE, "stl_final")
R = json.load(open(os.path.join(BASE, "reporte_final.json")))["_param"]
_, EY, EZ = R["EJE"]; C = R["CARA"]; PA = R["PANT"]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def mat(n, c, r=0.6):
    m = bpy.data.materials.new(n); b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*c, 1); b.inputs["Roughness"].default_value = r; return m


def stl(f, m):
    bpy.ops.wm.stl_import(filepath=os.path.join(STL, f + ".stl")); o = bpy.context.active_object
    o.data.materials.append(m); bpy.ops.object.shade_smooth(); return o


PLA = mat("pla_beige", (0.66, 0.53, 0.37), 0.85)
CREMA = mat("pla_crema", (0.855, 0.730, 0.552), 0.6)
for f in ("P1_cabeza", "P2_cuerpo"):
    stl(f, PLA)
stl("P3_cara", CREMA)
brazos = {}
for f in ("P4_brazo_derecho", "P5_brazo_izquierdo"):
    o = stl(f, PLA)
    bpy.ops.object.empty_add(location=(0, EY, EZ)); e = bpy.context.active_object
    o.parent = e; o.matrix_parent_inverse = e.matrix_world.inverted(); brazos[f] = e

# pantalla: plano con la imagen de la cara, a ras detrás de la ventana
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, R["Y_FRENTE"] + 0.0013, C["cz"]), rotation=(math.radians(90), 0, 0))
pan = bpy.context.active_object; pan.scale = (PA["act_w"] + 0.002, PA["act_h"] + 0.002, 1)
pm = bpy.data.materials.new("pantalla"); nt = pm.node_tree; N = nt.nodes
img = N.new("ShaderNodeTexImage"); img.image = bpy.data.images.load(os.path.join(BASE, "cara", "cara_neutra_480x320.png"))
bs = N["Principled BSDF"]; nt.links.new(img.outputs["Color"], bs.inputs["Base Color"])
nt.links.new(img.outputs["Color"], bs.inputs["Emission Color"]); bs.inputs["Emission Strength"].default_value = 0.08
bs.inputs["Roughness"].default_value = 0.15
pan.data.materials.append(pm)
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.uv.unwrap(); bpy.ops.object.mode_set(mode="OBJECT")
uv = pan.data.uv_layers.active.data
for i, l in enumerate(pan.data.loops):                      # UV del plano en orden: imagen derecha
    co = pan.data.vertices[l.vertex_index].co
    uv[i].uv = (co.x + 0.5, co.y + 0.5)

w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 0.30
for loc, e, s in (((-0.55, -0.75, 0.9), 11, 0.7), ((0.75, -0.5, 0.45), 3.5, 0.9), ((0.25, 0.75, 0.8), 7, 0.6)):
    bpy.ops.object.light_add(type="AREA", location=loc); l = bpy.context.active_object; l.data.energy = e; l.data.size = s
    l.rotation_euler = (Vector((0, 0, 0.17)) - l.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam
sc.render.engine = "CYCLES"; sc.cycles.samples = 48; sc.cycles.use_denoising = True
sc.render.resolution_x = sc.render.resolution_y = 1000
sc.view_settings.view_transform = "Standard"; sc.render.film_transparent = True
for nombre, az, der, lente, dist, mira_z in (("frente", -90, 0, 70, 1.10, 0.175), ("tres_cuartos", -62, 0, 70, 1.10, 0.175),
                                            ("saludo", -66, -140, 70, 1.10, 0.18), ("lado", 0, 0, 70, 1.10, 0.175),
                                            ("detalle_pelo", -70, 0, 140, 0.45, 0.20)):
    brazos["P4_brazo_derecho"].rotation_euler = (math.radians(der), 0, 0)
    cam.data.lens = lente; a = math.radians(az)
    cam.location = (dist * math.cos(a), dist * math.sin(a), mira_z + 0.03)
    cam.rotation_euler = (Vector((0, 0, mira_z)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(BASE, f"final_{nombre}.png"); bpy.ops.render.render(write_still=True)
print("RENDER_FINAL_OK")
