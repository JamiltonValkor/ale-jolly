"""Render fiel de Mini-Muse (malla de Hunyuan3D-2mv) con pelo y cara-pantalla.

blender -b -P modelo_ia/render_fiel.py -- [rapido]
"""
import bpy, sys, os, math
from mathutils import Vector

BASE = os.path.dirname(os.path.abspath(__file__))
RAPIDO = "rapido" in sys.argv
# cara: elipse medida en la foto de frente (30 cm de alto)
CX, CZ, AX, AZ = 0.0, 0.226, 0.059, 0.046

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.wm.ply_import(filepath=os.path.join(BASE, "muse_30cm.ply"))
o = bpy.context.active_object; o.name = "GEO-muse"
bpy.ops.object.shade_smooth()


def en_cara(p):
    return p.y < -0.035 and ((p.x - CX) / AX) ** 2 + ((p.z - CZ) / AZ) ** 2 < 1.0


# materiales
piel = bpy.data.materials.new("pelo"); pb = piel.node_tree.nodes["Principled BSDF"]
pb.inputs["Base Color"].default_value = (0.97, 0.87, 0.70, 1); pb.inputs["Roughness"].default_value = 0.8
cara = bpy.data.materials.new("cara"); nt = cara.node_tree; N = nt.nodes
tc = N.new("ShaderNodeTexCoord"); sep = N.new("ShaderNodeSeparateXYZ"); com = N.new("ShaderNodeCombineXYZ")
mp = N.new("ShaderNodeMapping")
mp.inputs["Scale"].default_value = (1 / (2 * AX), 1 / (2 * AZ), 1)
mp.inputs["Location"].default_value = (0.5 - CX / (2 * AX), 0.5 - CZ / (2 * AZ), 0)
img = N.new("ShaderNodeTexImage"); img.image = bpy.data.images.load(os.path.join(BASE, "cara_muse.png")); img.extension = "EXTEND"
nt.links.new(tc.outputs["Object"], sep.inputs[0]); nt.links.new(sep.outputs["X"], com.inputs["X"]); nt.links.new(sep.outputs["Z"], com.inputs["Y"])
nt.links.new(com.outputs[0], mp.inputs["Vector"]); nt.links.new(mp.outputs[0], img.inputs["Vector"])
cb = N["Principled BSDF"]
nt.links.new(img.outputs["Color"], cb.inputs["Base Color"])
nt.links.new(img.outputs["Color"], cb.inputs["Emission Color"]); cb.inputs["Emission Strength"].default_value = 0.0
cb.inputs["Roughness"].default_value = 0.75
o.data.materials.append(piel); o.data.materials.append(cara)
mw = o.matrix_world
for poly in o.data.polygons:
    if en_cara(mw @ poly.center):
        poly.material_index = 1

# pelo (fuera de la cara)
vg = o.vertex_groups.new(name="pelo")
vg.add([v.index for v in o.data.vertices if not en_cara(mw @ v.co)], 1.0, "REPLACE")
if not RAPIDO:
    o.modifiers.new("pelo", "PARTICLE_SYSTEM")
    ps = o.particle_systems[-1]; ps.vertex_group_density = "pelo"; s = ps.settings
    s.type = "HAIR"; s.count = 90000; s.hair_length = 0.009; s.use_advanced_hair = True
    s.child_type = "INTERPOLATED"; s.rendered_child_count = 8; s.child_percent = 6; s.child_radius = 0.004
    s.clump_factor = 0.1; s.roughness_1 = 0.0015; s.roughness_2 = 0.002; s.roughness_2_size = 0.6
    s.radius_scale = 0.00025; s.root_radius = 1.0; s.tip_radius = 0.1; s.render_step = 4
    s.material_slot = "pelo"

# estudio blanco como las referencias
w = bpy.data.worlds.new("w"); sc.world = w
w.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.30
bpy.ops.mesh.primitive_plane_add(size=4); piso = bpy.context.active_object
pm = bpy.data.materials.new("piso"); pm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.85, 0.85, 1)
piso.data.materials.append(pm); piso.is_shadow_catcher = True
for loc, e, t in (((-0.5, -0.7, 0.8), 16, 0.9), ((0.7, -0.5, 0.4), 6, 0.9), ((0.2, 0.7, 0.7), 10, 0.6)):
    bpy.ops.object.light_add(type="AREA", location=loc)
    l = bpy.context.active_object; l.data.energy = e; l.data.size = t
    l.rotation_euler = (Vector((0, 0, 0.15)) - l.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add(); cam = bpy.context.active_object; sc.camera = cam
cam.data.lens = 85
sc.render.engine = "CYCLES"; sc.cycles.samples = 16 if RAPIDO else 64; sc.cycles.use_denoising = True
sc.render.resolution_x = sc.render.resolution_y = 900
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = True
sufijo = "_rapido" if RAPIDO else ""
for nombre, az in (("frente", -90), ("tres_cuartos", -62)):
    a = math.radians(az); dist = 0.92
    cam.location = (dist * math.cos(a), dist * math.sin(a), 0.17)
    cam.rotation_euler = (Vector((0, 0, 0.152)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(BASE, f"fiel_{nombre}{sufijo}.png")
    bpy.ops.render.render(write_still=True)
print("RENDER_FIEL_OK")
