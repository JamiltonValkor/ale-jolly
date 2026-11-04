"""Mini-Muse — gemelo MuJoCo simple (v1).

Pesos de docs/tasks/aterrizaje-fisico-v1/evidencia/presupuesto_masas.py.
5 servos con la fuerza ÚTIL (la mitad de la nominal):
  cuello: giro, asentir (eje DENTRO de la cabeza), ladear → MG90S ≈ 1.0 kg·cm
  brazos: SG90 ≈ 0.9 kg·cm
Base: suela ±45 mm + lastre 300 g.
"""
import os, sys
import numpy as np, trimesh

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
sys.path.insert(0, os.path.join(RAIZ, "concepto"))

KGCM = 0.0980665                    # N·m por kg·cm
TAU_MG90S = 1.0 * KGCM
TAU_SG90 = 0.9 * KGCM
W0 = 10.5                           # rad/s sin carga (0.1 s / 60°)
# curva par-velocidad: la fuerza útil cae a cero a W0 → amortiguamiento = tau/W0

P_GIRO = np.array([0, 0.006, 0.170])
P_CABEZA = np.array([0, 0.004, 0.235])   # asentir y ladear (cerca del COM de la cabeza)
P_HOMBRO = {+1: np.array([0.066, 0, 0.176]), -1: np.array([-0.066, 0, 0.176])}


def preparar_mallas():
    """Pasa las mallas del concepto al marco local de cada cuerpo (MuJoCo no las mueve)."""
    import forma_sdf as F
    os.makedirs(os.path.join(AQUI, "mallas"), exist_ok=True)
    def guardar(m, nombre, origen):
        m = m.copy(); m.apply_translation(-origen)
        m.export(os.path.join(AQUI, "mallas", nombre + ".stl"))
    cwd = os.getcwd(); os.chdir(RAIZ)
    try:
        for sx, n in ((+1, "brazo_der_0"), (-1, "brazo_izq_0")):
            f, lo, hi = F.brazo(sx, 0); F.malla(f, lo, hi, n)
            guardar(trimesh.load(f"concepto/{n}.ply"), n, P_HOMBRO[sx])
        guardar(trimesh.load("concepto/cuerpo.ply"), "cuerpo", np.zeros(3))
        guardar(trimesh.load("concepto/cabeza.ply"), "cabeza", P_CABEZA)
    finally:
        os.chdir(cwd)


def v(a):
    return " ".join(f"{x:.4f}" for x in a)


def xml(suela=0.045, lastre=0.300):
    m_cuerpo = 0.584 + lastre
    z_com = (0.584 * 0.098 + lastre * 0.008) / m_cuerpo
    return f"""
<mujoco model="mini_muse">
  <compiler angle="degree" meshdir="{os.path.join(AQUI, 'mallas')}" inertiafromgeom="false"/>
  <option timestep="0.001" integrator="implicitfast"/>
  <visual><global offwidth="1280" offheight="960"/><quality shadowsize="4096"/><headlight ambient=".45 .45 .45" diffuse=".35 .35 .35"/></visual>
  <asset>
    <mesh name="cuerpo" file="cuerpo.stl"/><mesh name="cabeza" file="cabeza.stl"/>
    <mesh name="bder" file="brazo_der_0.stl"/><mesh name="bizq" file="brazo_izq_0.stl"/>
    <texture type="skybox" builtin="gradient" rgb1="1 .97 .95" rgb2=".86 .82 .80" width="256" height="256"/>
    <texture name="piso" type="2d" builtin="checker" rgb1=".86 .82 .78" rgb2=".80 .76 .72" width="512" height="512"/>
    <material name="piso" texture="piso" texrepeat="8 8"/>
    <material name="rosa" rgba=".93 .70 .70 1" specular=".1"/>
    <material name="cara" rgba="1 .93 .90 1" emission=".5"/>
    <material name="negro" rgba=".05 .05 .06 1"/>
  </asset>
  <default>
    <geom contype="0" conaffinity="0"/>
    <joint armature="0.0006"/>
  </default>
  <worldbody>
    <light pos="0 -0.6 1.0" dir="0 0.5 -1" diffuse=".9 .9 .9"/>
    <geom name="piso" type="plane" size="2 2 .1" material="piso" contype="1" conaffinity="1" friction="0.8"/>
    <body name="cuerpo" pos="0 0 0">
      <freejoint name="base"/>
      <inertial pos="0 0 {z_com:.4f}" mass="{m_cuerpo:.3f}" diaginertia="0.0046 0.0052 0.0039"/>
      <geom type="mesh" mesh="cuerpo" material="rosa"/>
      <geom name="suela" type="box" size="0.055 {suela:.3f} 0.003" pos="0 -0.004 0.003" rgba=".6 .5 .5 1"
            contype="1" conaffinity="1" friction="0.8"/>
      <site name="pecho" pos="0 0.07 0.15" size="0.004"/>
      <body name="giro" pos="{v(P_GIRO)}">
        <joint name="giro" damping="{TAU_MG90S/W0:.4f}" type="hinge" axis="0 0 1" range="-60 60"/>
        <inertial pos="0 0 0.02" mass="0.020" diaginertia="2e-6 2e-6 2e-6"/>
        <body name="asentir" pos="{v(P_CABEZA - P_GIRO)}">
          <joint name="asentir" damping="{TAU_MG90S/W0:.4f}" type="hinge" axis="-1 0 0" range="-15 25"/>
          <inertial pos="0 0 0" mass="0.0134" diaginertia="2e-6 2e-6 2e-6"/>
          <body name="cabeza" pos="0 0 0">
            <joint name="ladear" damping="{TAU_MG90S/W0:.4f}" type="hinge" axis="0 -1 0" range="-20 20"/>
            <inertial pos="{v(np.array([0, -0.002, 0.243]) - P_CABEZA)}" mass="0.248" diaginertia="0.0005 0.0005 0.0005"/>
            <geom type="mesh" mesh="cabeza" material="rosa"/>
            <geom type="ellipsoid" size="0.047 0.006 0.030" pos="{v(np.array([0, -0.036, 0.246]) - P_CABEZA)}" material="cara"/>
            <geom type="sphere" size="0.0055" pos="{v(np.array([-0.016, -0.041, 0.250]) - P_CABEZA)}" material="negro"/>
            <geom type="sphere" size="0.0055" pos="{v(np.array([0.016, -0.041, 0.250]) - P_CABEZA)}" material="negro"/>
            <geom type="capsule" size="0.0015" fromto="{v(np.array([-0.006, -0.041, 0.238]) - P_CABEZA)} {v(np.array([0.006, -0.041, 0.238]) - P_CABEZA)}" material="negro"/>
          </body>
        </body>
      </body>
      <body name="brazo_der" pos="{v(P_HOMBRO[1])}">
        <joint name="brazo_der" damping="{TAU_SG90/W0:.4f}" type="hinge" axis="0 -1 0" range="0 150"/>
        <inertial pos="0 0 -0.040" mass="0.075" diaginertia="5e-5 5e-5 1.5e-5"/>
        <geom type="mesh" mesh="bder" material="rosa"/>
      </body>
      <body name="brazo_izq" pos="{v(P_HOMBRO[-1])}">
        <joint name="brazo_izq" damping="{TAU_SG90/W0:.4f}" type="hinge" axis="0 1 0" range="0 150"/>
        <inertial pos="0 0 -0.040" mass="0.075" diaginertia="5e-5 5e-5 1.5e-5"/>
        <geom type="mesh" mesh="bizq" material="rosa"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="giro"      joint="giro"      kp="1.5" forcelimited="true" forcerange="-{TAU_MG90S:.4f} {TAU_MG90S:.4f}"/>
    <position name="asentir"   joint="asentir"   kp="1.5" forcelimited="true" forcerange="-{TAU_MG90S:.4f} {TAU_MG90S:.4f}"/>
    <position name="ladear"    joint="ladear"    kp="1.5" forcelimited="true" forcerange="-{TAU_MG90S:.4f} {TAU_MG90S:.4f}"/>
    <position name="brazo_der" joint="brazo_der" kp="1.0" forcelimited="true" forcerange="-{TAU_SG90:.4f} {TAU_SG90:.4f}"/>
    <position name="brazo_izq" joint="brazo_izq" kp="1.0" forcelimited="true" forcerange="-{TAU_SG90:.4f} {TAU_SG90:.4f}"/>
  </actuator>
</mujoco>
"""


if __name__ == "__main__":
    preparar_mallas()
    import mujoco
    m = mujoco.MjModel.from_xml_string(xml())
    print("ok, masa total", round(sum(m.body_mass), 3), "kg; actuadores", m.nu)
