"""Genera la malla de Mini-Muse con Hunyuan3D-2mv (Space gratis de Hugging Face) a partir de 3 vistas."""
import sys, shutil, json
from gradio_client import Client, handle_file
semilla = int(sys.argv[1]) if len(sys.argv) > 1 else 1234
c = Client("tencent/Hunyuan3D-2mv")
r = c.predict(None, None,
              handle_file("modelo_ia/frente.png"), handle_file("modelo_ia/espalda.png"),
              handle_file("modelo_ia/lado.png"), None,
              30, 5.0, semilla, 380, True, 8000, False, api_name="/shape_generation")
print(r[2], r[3])
f0 = r[0]["value"] if isinstance(r[0], dict) else r[0]
shutil.copy(f0, f"modelo_ia/muse_hunyuan_s{semilla}.glb")
print("GUARDADO", f"modelo_ia/muse_hunyuan_s{semilla}.glb")
