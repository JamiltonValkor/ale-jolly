"""Mini-Muse concepto v0 — render en Blender (headless).

blender -b -P concepto/render_concepto.py -- pelo|interior
"""
import bpy, sys, os, math, json
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view

MODO = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "pelo"
BASE = os.path.dirname(os.path.abspath(__file__))
ROSA = (0.80, 0.50, 0.47, 1)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def mat(nombre, color, rough=0.5, alpha=1.0, emis=None, metal=0.0):
    m = bpy.data.materials.new(nombre)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Alpha"].default_value = alpha
    if emis:
        b.inputs["Emission Color"].default_value = emis
        b.inputs["Emission Strength"].default_value = 1.0
    return m


def importar(nombre, material):
    bpy.ops.wm.ply_import(filepath=os.path.join(BASE, nombre + ".ply"))
    o = bpy.context.active_object
    o.name = "GEO-" + nombre
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    return o


def caja(nombre, dims, loc, material, rot=(0, 0, 0), bevel=0.0008):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = "GEO-" + nombre
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        bv = o.modifiers.new("Bevel", "BEVEL"); bv.width = bevel; bv.segments = 2
    o.data.materials.append(material)
    return o


def cilindro(nombre, r, h, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, rotation=rot, vertices=48)
    o = bpy.context.active_object
    o.name = "GEO-" + nombre
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    return o


# ---------------- forma ----------------
m_piel = mat("piel", ROSA, 0.75)
cuerpo = importar("cuerpo", m_piel)
cabeza = importar("cabeza", m_piel)
b_der = importar("brazo_der", m_piel)
b_izq = importar("brazo_izq", m_piel)

# cara = pantalla con la emoción
bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, location=(0, -0.030, 0.246))
cara = bpy.context.active_object
cara.name = "GEO-cara_pantalla"
cara.scale = (0.052, 0.009, 0.034)
bpy.ops.object.shade_smooth()
mc = bpy.data.materials.new("pantalla"); mc.use_nodes = True
nt = mc.node_tree; N = nt.nodes
tc = N.new("ShaderNodeTexCoord"); sep = N.new("ShaderNodeSeparateXYZ"); com = N.new("ShaderNodeCombineXYZ")
mp = N.new("ShaderNodeMapping"); mp.inputs["Location"].default_value = (0.5, 0.5, 0); mp.inputs["Scale"].default_value = (0.5, 0.5, 1)
img = N.new("ShaderNodeTexImage"); img.image = bpy.data.images.load(os.path.join(BASE, "cara_feliz.png")); img.extension = "EXTEND"
nt.links.new(tc.outputs["Object"], sep.inputs[0]); nt.links.new(sep.outputs["X"], com.inputs["X"]); nt.links.new(sep.outputs["Z"], com.inputs["Y"])
nt.links.new(com.outputs[0], mp.inputs["Vector"]); nt.links.new(mp.outputs[0], img.inputs["Vector"])
bs = N["Principled BSDF"]
bs.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
bs.inputs["Roughness"].default_value = 0.12
nt.links.new(img.outputs["Color"], bs.inputs["Emission Color"])
bs.inputs["Emission Strength"].default_value = 2.6
bs.inputs["Roughness"].default_value = 0.3
cara.data.materials.append(mc)

# lente de la cámara (puntico en la frente)
m_lente = mat("lente", (0.01, 0.01, 0.012, 1), 0.05)
cilindro("lente_camara", 0.0028, 0.004, (0, -0.0505, 0.290), m_lente, rot=(math.radians(90 - 38), 0, 0))

# el brazo derecho y la cabeza en pose "saludo + cabeza ladeada"
for o in (cabeza, cara, bpy.data.objects["GEO-lente_camara"]):
    pass
piv = Vector((0, 0, 0.195))
bpy.ops.object.empty_add(location=piv); cuello = bpy.context.active_object; cuello.name = "CTRL-cuello"
for o in (cabeza, cara, bpy.data.objects["GEO-lente_camara"]):
    o.parent = cuello; o.matrix_parent_inverse = cuello.matrix_world.inverted()
M0INV = cuello.matrix_world.inverted()
CABEZA = {"Pantalla 4\" (cara)", "Cámara Pi v3", "Micrófonos", "SG90 asentir", "SG90 ladear"}

# ---------------- pelo ----------------
def pelo(o, n, largo, excluir=None):
    vg = o.vertex_groups.new(name="pelo")
    idx = []
    for v in o.data.vertices:
        if excluir and excluir(o.matrix_world @ v.co):
            continue
        idx.append(v.index)
    vg.add(idx, 1.0, "REPLACE")
    o.modifiers.new("pelo", "PARTICLE_SYSTEM")
    ps = o.particle_systems[-1]; ps.vertex_group_density = "pelo"
    s = ps.settings
    s.type = "HAIR"; s.count = n; s.hair_length = largo; s.use_advanced_hair = True
    s.child_type = "INTERPOLATED"; s.rendered_child_count = 7; s.child_percent = 7
    s.child_radius = 0.004; s.clump_factor = 0.15
    s.roughness_1 = 0.0012; s.roughness_2 = 0.0016; s.roughness_2_size = 0.6
    s.radius_scale = 0.00022; s.root_radius = 1.0; s.tip_radius = 0.15
    s.render_step = 4; s.display_step = 2
    s.material_slot = o.material_slots[0].name
    return ps


def es_cara(p):
    return p.y < -0.030 and (p.x / 0.056) ** 2 + ((p.z - 0.246) / 0.040) ** 2 < 1 \
        or (p.x ** 2 + (p.z - 0.290) ** 2) < 0.007 ** 2 and p.y < -0.04


if MODO == "pelo":
    pelo(cuerpo, 45000, 0.0075)
    pelo(cabeza, 26000, 0.0065, es_cara)
    pelo(b_der, 5000, 0.0065)
    pelo(b_izq, 5000, 0.0065)

# ---------------- interior (SG90 y electrónica) ----------------
etiquetas = {}
if MODO == "interior":
    # corte en cuarto (frente-derecha) para ver adentro; concha hueca de 2.5 mm
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.15, -0.15 + 0.012, 0.15))
    corte = bpy.context.active_object; corte.name = "CUT-cuarto"; corte.scale = (0.3, 0.3, 0.5)
    corte.hide_render = True
    for o in (cuerpo, cabeza):
        so = o.modifiers.new("concha", "SOLIDIFY"); so.thickness = 0.0025; so.offset = -1
        bo = o.modifiers.new("corte", "BOOLEAN"); bo.operation = "DIFFERENCE"; bo.object = corte; bo.solver = "EXACT"
        m_sg = mat("sg90", (0.05, 0.22, 0.75, 1), 0.4)
    m_horn = mat("horn", (0.95, 0.95, 0.95, 1), 0.4)
    m_pcb = mat("pcb", (0.05, 0.35, 0.12, 1), 0.45)
    m_neg = mat("negro", (0.03, 0.03, 0.03, 1), 0.3)
    m_bat = mat("bateria", (0.85, 0.45, 0.08, 1), 0.4)
    m_disp = mat("display", (0.02, 0.02, 0.05, 1), 0.2)

    def sg90(nombre, loc, eje):
        """eje: dirección del eje de salida ('z','-y','x'...). Cuerpo 22.8×12.2×22.5 mm."""
        rot = {"z": (0, 0, 0), "-y": (math.radians(90), 0, 0), "x": (0, math.radians(90), 0),
               "y": (math.radians(-90), 0, 0)}[eje]
        bpy.ops.object.empty_add(location=loc, rotation=rot); e = bpy.context.active_object; e.name = "CTRL-" + nombre
        partes = [caja(nombre + "_cuerpo", (0.0228, 0.0122, 0.0225), (0, 0, 0), m_sg),
                  caja(nombre + "_orejas", (0.0323, 0.0122, 0.0025), (0, 0, 0.0045), m_sg),
                  cilindro(nombre + "_eje", 0.0024, 0.006, (0.0058, 0, 0.0142), m_horn),
                  caja(nombre + "_horn", (0.026, 0.006, 0.0018), (0.0058, 0, 0.0175), m_horn)]
        for p in partes:
            p.parent = e
        etiquetas[nombre] = loc
        return e

    s_yaw = sg90("SG90 giro cabeza", (0, 0.006, 0.160), "z")
    s_pit = sg90("SG90 asentir", (0, 0.012, 0.192), "x")
    s_rol = sg90("SG90 ladear", (0, 0.020, 0.222), "-y")
    for s in (s_pit, s_rol):
        s.parent = cuello; s.matrix_parent_inverse = cuello.matrix_world.inverted()
    sg90("SG90 brazo der", (0.050, 0.016, 0.176), "-y")
    sg90("SG90 brazo izq", (-0.050, 0.016, 0.176), "-y")

    caja("Raspberry Pi 5", (0.085, 0.056, 0.017), (0, 0.004, 0.032), m_pcb); etiquetas["Raspberry Pi 5"] = (0, 0.004, 0.032)
    caja("PCA9685", (0.062, 0.025, 0.003), (0, 0.050, 0.110), m_pcb, rot=(math.radians(90), 0, 0)); etiquetas["Driver PCA9685"] = (0, 0.050, 0.110)
    caja("Bateria", (0.077, 0.042, 0.021), (0, 0.010, 0.064), m_bat); etiquetas["Batería 2×18650"] = (0, 0.010, 0.064)
    cilindro("Parlante", 0.020, 0.012, (0, -0.060, 0.105), m_neg, rot=(math.radians(90), 0, 0)); etiquetas["Parlante 40 mm"] = (0, -0.060, 0.105)
    d = caja("Pantalla", (0.088, 0.005, 0.055), (0, -0.018, 0.246), m_disp); d.parent = cuello; d.matrix_parent_inverse = cuello.matrix_world.inverted()
    etiquetas["Pantalla 4\" (cara)"] = (0, -0.018, 0.246)
    c = caja("Camara", (0.025, 0.009, 0.024), (0, -0.040, 0.286), m_pcb); c.parent = cuello; c.matrix_parent_inverse = cuello.matrix_world.inverted()
    etiquetas["Cámara Pi v3"] = (0, -0.040, 0.286)
    mi = caja("Microfonos", (0.040, 0.020, 0.003), (0, 0.005, 0.306), m_pcb); mi.parent = cuello; mi.matrix_parent_inverse = cuello.matrix_world.inverted()
    etiquetas["Micrófonos"] = (0, 0.005, 0.306)

# brazo derecho saludando ya está modelado arriba (145°)

cuello.rotation_euler = Euler((math.radians(-4), math.radians(-9), math.radians(6)))
bpy.context.view_layer.update()

# ---------------- estudio ----------------
m_piso = mat("piso", (0.70, 0.64, 0.58, 1), 0.6)
bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0, 0)); piso = bpy.context.active_object; piso.data.materials.append(m_piso)
bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0.6, 1.0), rotation=(math.radians(90), 0, 0)); bpy.context.active_object.data.materials.append(m_piso)

w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.92, 0.88, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.15


def luz(nombre, loc, energia, tam, color=(1, 1, 1)):
    bpy.ops.object.light_add(type="AREA", location=loc)
    l = bpy.context.active_object; l.name = nombre
    l.data.energy = energia; l.data.size = tam; l.data.color = color
    d = Vector((0, 0, 0.17)) - l.location
    l.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


luz("clave", (-0.45, -0.55, 0.65), 26, 0.5, (1, 0.96, 0.9))
luz("relleno", (0.6, -0.4, 0.3), 8, 0.6, (0.92, 0.95, 1))
luz("contra", (0.25, 0.55, 0.6), 22, 0.4)

bpy.ops.object.camera_add(location=(0.34, -0.72, 0.27))
cam = bpy.context.active_object; sc.camera = cam
cam.data.lens = 70
cam.rotation_euler = (Vector((0, 0, 0.160)) - cam.location).to_track_quat("-Z", "Y").to_euler()

sc.render.engine = "CYCLES"
try:
    pr = bpy.context.preferences.addons["cycles"].preferences
    raise RuntimeError("cpu")
    for dv in pr.devices:
        dv.use = True
    sc.cycles.device = "GPU"
except Exception as ex:
    print("sin GPU", ex)
sc.cycles.samples = {"pelo": 96, "interior": 48}.get(MODO, 12)
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1000, 1150
sc.view_settings.view_transform = "AgX"
sc.render.film_transparent = False
out = os.path.join(BASE, f"concepto_{MODO}.png")
sc.render.filepath = out
bpy.ops.render.render(write_still=True)

if etiquetas:
    bpy.context.view_layer.update()
    res = {}
    for k, p in etiquetas.items():
        wp = Vector(p)
        if k in CABEZA:
            wp = cuello.matrix_world @ M0INV @ wp
        uv = world_to_camera_view(sc, cam, wp)
        res[k] = (uv.x, 1 - uv.y)
    json.dump(res, open(os.path.join(BASE, "etiquetas.json"), "w"), ensure_ascii=False, indent=1)
print("RENDER_OK", out)
