"""Vista en corte y despiece del hombro derecho: cómo el SG90 mueve el bracito suelto.

blender -b -P piezas/render_hombro.py
"""
import bpy, os, math, json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

BASE = os.path.dirname(os.path.abspath(__file__))
J = json.load(open(os.path.join(BASE, "piezas_v3.json")))
EX, EY, EZ = J["brazo_der"]["eje"]
DESPIECE = 0.034          # cuánto se separa el brazo para ver la unión

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def mat(n, c, r=0.6, a=1.0):
    m = bpy.data.materials.new(n); b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*c, 1); b.inputs["Roughness"].default_value = r; b.inputs["Alpha"].default_value = a
    return m


M_PIEL = mat("piel", (0.66, 0.52, 0.34), 0.85)
M_CORTE = mat("corte", (0.45, 0.33, 0.20), 0.9)
M_SG = mat("sg90", (0.05, 0.22, 0.75), 0.4)
M_BLANCO = mat("blanco", (0.92, 0.92, 0.92), 0.4)
M_ACOPLE = mat("acople", (0.95, 0.45, 0.15), 0.5)
M_IMAN = mat("iman", (0.6, 0.6, 0.65), 0.2)
M_SOPORTE = mat("soporte", (0.35, 0.35, 0.38), 0.6)


def importar(n, m):
    bpy.ops.wm.ply_import(filepath=os.path.join(BASE, n + ".ply"))
    o = bpy.context.active_object; o.name = n; bpy.ops.object.shade_smooth(); o.data.materials.append(m); return o


def caja(n, dims, loc, m):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc); o = bpy.context.active_object; o.name = n
    o.scale = dims; bpy.ops.object.transform_apply(scale=True)
    bv = o.modifiers.new("b", "BEVEL"); bv.width = 0.0008; bv.segments = 2
    o.data.materials.append(m); return o


def cil(n, r, largo, x0, m, y=EY, z=EZ, vert=48):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=largo, vertices=vert, location=(x0 + largo / 2, y, z),
                                        rotation=(0, math.radians(90), 0))
    o = bpy.context.active_object; o.name = n; bpy.ops.object.shade_smooth(); o.data.materials.append(m); return o


cuerpo = importar("cuerpo_v3", M_PIEL)
brazo = importar("brazo_der_v3", M_PIEL)
brazo.location.x += DESPIECE

# concha hueca de 2 mm y corte para ver adentro (solo la zona del hombro)
so = cuerpo.modifiers.new("concha", "SOLIDIFY"); so.thickness = 0.002; so.offset = -1; so.material_offset = 0
bpy.ops.mesh.primitive_cube_add(size=1, location=(EX - 0.02 + 0.06, EY - 0.1, EZ)); cut = bpy.context.active_object
cut.scale = (0.12, 0.2, 0.09); cut.hide_render = True
bo = cuerpo.modifiers.new("corte", "BOOLEAN"); bo.object = cut; bo.operation = "DIFFERENCE"; bo.solver = "EXACT"
so2 = brazo.modifiers.new("concha", "SOLIDIFY"); so2.thickness = 0.0016; so2.offset = -1
bpy.ops.mesh.primitive_cube_add(size=1, location=(EX + 0.05, EY - 0.1, EZ)); cut2 = bpy.context.active_object
cut2.scale = (0.2, 0.2, 0.2); cut2.hide_render = True
bo2 = brazo.modifiers.new("corte", "BOOLEAN"); bo2.object = cut2; bo2.operation = "DIFFERENCE"; bo2.solver = "EXACT"

# SG90: eje de salida apuntando +x, justo dentro de la pared
pared_in = EX - 0.0042 - 0.002          # superficie interior del costado
x_horn = pared_in - 0.003
x_top = x_horn - 0.004                  # cara superior del servo
caja("SG90", (0.0225, 0.0122, 0.0228), (x_top - 0.01125, EY, EZ - 0.0058), M_SG)
caja("SG90 orejas", (0.0025, 0.0122, 0.0323), (x_top - 0.0045, EY, EZ - 0.0058), M_SG)
cil("eje SG90", 0.0024, 0.004, x_top, M_BLANCO)
caja("horn", (0.0018, 0.006, 0.026), (x_horn - 0.0009, EY, EZ), M_BLANCO)
# soporte impreso (cuna) atornillado a la pared interior
caja("cuna", (0.026, 0.022, 0.004), (x_top - 0.013, EY, EZ - 0.0058 - 0.0134), M_SOPORTE)
caja("cuna2", (0.026, 0.022, 0.004), (x_top - 0.013, EY, EZ - 0.0058 + 0.0134), M_SOPORTE)
# acople: atornillado al horn, cruza la pared por un buje y entra 5 mm en el brazo (llave hexagonal + imán)
cil("buje", 0.0085, 0.004, pared_in - 0.0005, M_SOPORTE)
cil("acople", 0.0055, 0.0042 + 0.002 + 0.003 + 0.0042, x_horn, M_ACOPLE)
cil("llave hex", 0.0046, 0.005, EX + 0.0021 + DESPIECE * 0.45, M_ACOPLE, vert=6)
cil("iman acople", 0.003, 0.003, EX + 0.0071 + DESPIECE * 0.45, M_IMAN)
cil("casquillo brazo", 0.0075, 0.011, EX + 0.0021 + DESPIECE, M_CORTE)
cil("iman brazo", 0.003, 0.0031, EX + 0.0021 + DESPIECE - 0.0001, M_IMAN)

w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
for loc, e, s in (((-0.3, -0.6, 0.6), 14, 0.8), ((0.6, -0.4, 0.3), 6, 0.8), ((0.3, 0.5, 0.5), 6, 0.6)):
    bpy.ops.object.light_add(type="AREA", location=loc); l = bpy.context.active_object; l.data.energy = e; l.data.size = s
    l.rotation_euler = (Vector((EX, EY, EZ)) - l.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam; cam.data.lens = 60
cam.location = (EX + 0.22, EY - 0.42, EZ + 0.10)
cam.rotation_euler = (Vector((EX + 0.012, EY, EZ - 0.005)) - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.render.engine = "BLENDER_EEVEE"; sc.render.resolution_x, sc.render.resolution_y = 1100, 900
sc.view_settings.view_transform = "Standard"
sc.render.filepath = os.path.join(BASE, "hombro_corte.png")
bpy.ops.render.render(write_still=True)

rot = {}
for n in ("SG90", "horn", "cuna", "buje", "acople", "llave hex", "casquillo brazo"):
    o = bpy.data.objects[n]; p = o.matrix_world @ (sum((Vector(c) for c in o.bound_box), Vector()) / 8)
    uv = world_to_camera_view(sc, cam, p); rot[n] = (uv.x, 1 - uv.y)
json.dump(rot, open(os.path.join(BASE, "hombro_etiquetas.json"), "w"))
print("HOMBRO_OK")
