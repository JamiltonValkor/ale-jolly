# Jolly's body: Mini-Muse 3D design

The printable body of Jolly, the robot in the demo video. It is about 34 cm tall and holds a Raspberry Pi 5, a 3.5″ HDMI touch screen (MPI3508) as the face, a USB microphone, a USB camera in the chest, a 40 mm speaker and two SG90 servos for the arms.

## Print it

The files in [`imprimir/IMPRIMIR_YA/`](imprimir/IMPRIMIR_YA/) are final, already oriented on the bed, and fit a 256 mm printer (Bambu P2S). Open them in Bambu Studio and don't rotate them. `JElly muse.3mf` is the Bambu Studio project.

| File | Part | Material | Approx. weight |
|---|---|---|---|
| `01_P2_cuerpo.stl` | Body with feet | **PETG** (the Pi gets warm) | ~545 g |
| `02_P1_cabeza.stl` | Head | PLA | ~235 g |
| `03_P3_cara.stl` | Face frame that holds the screen | PLA, cream (no fuzzy skin) | ~30 g |
| `04_P4_brazo_derecho.stl` | Right arm | PLA, 3 walls, 100 % infill | ~65 g |
| `05_P5_brazo_izquierdo.stl` | Left arm | PLA, 3 walls, 100 % infill | ~65 g |
| `06_P6_tapones_x2.stl` | Two arm caps | PLA | ~1 g |

Settings: 0.2 mm layers, 0.4 mm nozzle, tree supports from the build plate only, and fuzzy skin (outer walls, 0.3 mm thickness, 0.4 mm point distance) on every part except the face. Don't use "Simplify model": it breaks the mesh. The full print takes about 31 h.

Full print and assembly notes (Spanish): [`imprimir/IMPRIMIR_YA/QUE_IMPRIMIR.md`](imprimir/IMPRIMIR_YA/QUE_IMPRIMIR.md) and [`imprimir/DISENO_FINAL.md`](imprimir/DISENO_FINAL.md). Parts list: [`imprimir/LISTA_COMPRAS.md`](imprimir/LISTA_COMPRAS.md).

## How it was designed

| Folder | What's there |
|---|---|
| `referencia/`, `analisis/` | The reference image and silhouette analysis |
| `concepto/` | First shape studies and renders |
| `modelo_ia/` | AI-generated base mesh and fidelity checks against the reference |
| `piezas/` | Body and arm iterations (v2–v5) and arm animation studies |
| `sim/` | Arm gesture simulation (servo torque, range 0°–150°) |
| `imprimir/_fuente/` | Scripts that generate the final parts (`generar_final.py`) and verify them (`verificar_final.py`: no collisions between parts and components, arms rotate freely), plus the full-resolution STLs in `stl_final/` |
| `imprimir/cara/` | The face image for the screen and its generator |
| `software/` | Early face and arm code. The current robot code is in [`../ale-runtime/robot/`](../ale-runtime/robot/) |

`verificar_final.py` checks against the official Raspberry Pi 5 and Camera Module CAD models, which are not redistributed here; download them from raspberrypi.com to run it.

Fan-made design inspired by Meta's Muse character; not for sale.
