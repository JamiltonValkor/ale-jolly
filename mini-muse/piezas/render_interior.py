"""Mini-Muse por dentro: concha real cortada + componentes a medida real (de empaque.json).

blender -b -P piezas/render_interior.py
"""
import bpy, os, math, json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

BASE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(BASE, "empaque.json")))
J = json.load(open(os.path.join(BASE, "piezas_v3.json")))
CORTE_Z = 0.195          # unión cabeza / cuerpo
CX, CZ, AX, AZ = 0.0, 0.226, 0.059, 0.046

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def mat(n, c, r=0.6, a=1.0, t=0.0):
    m = bpy.data.materials.new(n); b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*c, 1); b.inputs["Roughness"].default_value = r
    b.inputs["Alpha"].default_value = a; b.inputs["Transmission Weight"].default_value = t
    return m


COL = {"Raspberry": (0.05, 0.40, 0.15), "Parlante": (0.06, 0.06, 0.07), "Pantalla": (0.02, 0.02, 0.06),
       "Cámara": (0.10, 0.55, 0.20), "Micrófonos": (0.10, 0.10, 0.12), "SG90": (0.05, 0.22, 0.75),
       "Lastre": (0.55, 0.55, 0.60), "Bornera": (0.85, 0.30, 0.10)}
M_PIEL = mat("piel", (0.66, 0.52, 0.34), 0.85)
M_CARA = mat("cara", (0.95, 0.90, 0.82), 0.4, a=0.35)


def importar(path, m, nombre):
    if path.endswith(".stl"):
        bpy.ops.wm.stl_import(filepath=path)
    else:
        bpy.ops.wm.ply_import(filepath=path)
    o = bpy.context.active_object; o.name = nombre; bpy.ops.object.shade_smooth(); o.data.materials.append(m); return o


def cortar(o, centro, tam, espesor=0.0024):
    so = o.modifiers.new("concha", "SOLIDIFY"); so.thickness = espesor; so.offset = -1
    bpy.ops.mesh.primitive_cube_add(size=1, location=centro); c = bpy.context.active_object
    c.scale = tam; c.hide_render = True; c.hide_viewport = True
    bo = o.modifiers.new("corte", "BOOLEAN"); bo.object = c; bo.operation = "DIFFERENCE"; bo.solver = "EXACT"


# cuerpo partido en cabeza y cuerpo (se ve la línea de unión)
for nombre, z0, z1 in (("cabeza", CORTE_Z + 0.0005, 0.4), ("cuerpo", -0.1, CORTE_Z - 0.0005)):
    o = importar(os.path.join(BASE, "cuerpo_v3.ply"), M_PIEL, nombre)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.bisect(plane_co=(0, 0, z0 if nombre == "cabeza" else z1), plane_no=(0, 0, 1),
                        clear_inner=(nombre == "cabeza"), clear_outer=(nombre == "cuerpo"), use_fill=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # mitad derecha (x>0) fuera para ver adentro, excepto la cara
    cortar(o, (0.15, 0.0, 0.15), (0.3, 0.5, 0.6))

# placa de la cara (traslúcida) — solo la mitad izquierda para ver la pantalla detrás
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, location=(0, -0.050, CZ))
cara = bpy.context.active_object; cara.scale = (AX, 0.006, AZ); cara.data.materials.append(M_CARA)
bpy.ops.object.shade_smooth()

for b in ("brazo_izq",):
    importar(os.path.join(BASE, b + "_v4.stl"), M_PIEL, b)

etiquetas = {}
for c in E["componentes"]:
    n = c["nombre"]; tam = [v / 1000 for v in c["mm"]]
    bpy.ops.mesh.primitive_cube_add(size=1, location=c["centro"]); o = bpy.context.active_object
    o.scale = tam; o.name = n
    bv = o.modifiers.new("b", "BEVEL"); bv.width = 0.0008; bv.segments = 2
    clave = next(k for k in COL if n.startswith(k))
    o.data.materials.append(mat(n, COL[clave], 0.45))
    etiquetas[n] = c["centro"]

w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
for loc, e, s in (((0.6, -0.6, 0.7), 16, 0.9), ((0.6, 0.3, 0.3), 6, 0.9), ((-0.3, -0.6, 0.4), 6, 0.6)):
    bpy.ops.object.light_add(type="AREA", location=loc); l = bpy.context.active_object; l.data.energy = e; l.data.size = s
    l.rotation_euler = (Vector((0, 0, 0.15)) - l.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam; cam.data.lens = 55
sc.render.engine = "BLENDER_EEVEE"; sc.render.resolution_x, sc.render.resolution_y = 1000, 1150
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True
res = {}
for vista, loc in (("lado", (0.56, -0.20, 0.22)), ("frente", (0.30, -0.55, 0.20))):
    cam.location = loc
    cam.rotation_euler = (Vector((0, 0, 0.155)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(BASE, f"interior_{vista}.png")
    bpy.ops.render.render(write_still=True)
    res[vista] = {n: list(world_to_camera_view(sc, cam, Vector(p)))[:2] for n, p in etiquetas.items()}
json.dump(res, open(os.path.join(BASE, "interior_etiquetas.json"), "w"), ensure_ascii=False)
print("INTERIOR_OK")
