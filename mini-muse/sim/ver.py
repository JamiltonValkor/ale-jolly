"""Abre Mini-Muse en el visor de MuJoCo. En el panel derecho (Control) mueves cada servo con su barra."""
import os, sys, mujoco, mujoco.viewer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modelo import xml
m = mujoco.MjModel.from_xml_string(xml())
mujoco.viewer.launch(m, mujoco.MjData(m))
