"""Mini-Muse hace sus gestos de tienda en MuJoCo → video + reporte de esfuerzo de cada servo.

.venv/bin/python sim/gestos.py          (video en sim/gestos.mp4)
"""
import os, sys
import numpy as np, mujoco, imageio
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modelo import xml, AQUI

SERVOS = ["giro", "asentir", "ladear", "brazo_der", "brazo_izq"]

# (segundo, {servo: grados}) — poses clave; entre ellas se interpola suave
GESTOS = [
    ("reposo",          [(0.0, {}), (1.0, {})]),
    ("saludar",         [(0.9, {"brazo_der": 125})] + [(0.3, {"brazo_der": a}) for a in (110, 140) * 3]
                        + [(0.3, {"brazo_der": 125}), (0.9, {"brazo_der": 0})]),
    ("mirar a los lados", [(0.6, {"giro": 60}), (0.5, {}), (1.0, {"giro": -60}), (0.5, {}), (0.6, {"giro": 0})]),
    ("mirar al cliente (arriba)", [(0.6, {"asentir": 25}), (0.6, {})]),
    ("asentir",         [(0.25, {"asentir": a}) for a in (10, -10) * 4] + [(0.3, {"asentir": 0})]),
    ("mirar el mostrador (abajo)", [(0.6, {"asentir": -15}), (0.6, {}), (0.5, {"asentir": 0})]),
    ("ladear: ¿no entendí?", [(0.5, {"ladear": 20}), (0.8, {}), (0.6, {"ladear": -20}), (0.8, {}), (0.5, {"ladear": 0})]),
    ("señalar por allá", [(0.9, {"brazo_izq": 90, "giro": -40}), (1.0, {}), (0.9, {"brazo_izq": 0, "giro": 0})]),
    ("asentir mirando arriba (el más duro)", [(0.5, {"asentir": 25, "ladear": 12})]
                        + [(0.25, {"asentir": a}) for a in (15, 25) * 4] + [(0.6, {"asentir": 0, "ladear": 0})]),
]


def trayectoria():
    """Lista de (t, nombre_gesto, objetivo[5] en rad) a 1 kHz con interpolación coseno."""
    pose = {s: 0.0 for s in SERVOS}
    claves = []
    t = 0.0
    for nombre, pasos in GESTOS:
        for dur, cambios in pasos:
            ini = dict(pose); pose.update(cambios)
            claves.append((t, t + dur, ini, dict(pose), nombre))
            t += dur
    return claves, t + 0.5


def objetivo(claves, t):
    for t0, t1, a, b, nombre in claves:
        if t <= t1:
            s = 0.5 - 0.5 * np.cos(np.pi * np.clip((t - t0) / max(t1 - t0, 1e-6), 0, 1))
            return nombre, np.radians([a[k] + (b[k] - a[k]) * s for k in SERVOS])
    t0, t1, a, b, nombre = claves[-1]
    return "reposo", np.radians([b[k] for k in SERVOS])


def main(video=True):
    m = mujoco.MjModel.from_xml_string(xml())
    d = mujoco.MjData(m)
    claves, T = trayectoria()
    lim = m.actuator_forcerange[:, 1]
    jid = [m.joint(s).qposadr[0] for s in SERVOS]

    r = mujoco.Renderer(m, 560, 640) if video else None
    cam = mujoco.MjvCamera(); cam.lookat[:] = (0, 0, 0.16); cam.distance = 0.75; cam.elevation = -6; cam.azimuth = 105
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
        fb = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 24)
    except OSError:
        f = fb = ImageFont.load_default()

    frames, pico, error_max, incl_max = [], {s: 0.0 for s in SERVOS}, {s: 0.0 for s in SERVOS}, 0.0
    pico_gesto = {s: "" for s in SERVOS}
    paso_video = int(1 / 30 / m.opt.timestep)
    for i in range(int(T / m.opt.timestep)):
        t = i * m.opt.timestep
        nombre, q = objetivo(claves, t)
        d.ctrl[:] = q
        mujoco.mj_step(m, d)
        if t < 0.3:
            continue
        uso = np.abs(d.actuator_force) / lim
        for k, s in enumerate(SERVOS):
            if uso[k] > pico[s]:
                pico[s], pico_gesto[s] = uso[k], nombre
            error_max[s] = max(error_max[s], abs(np.degrees(d.qpos[jid[k]] - q[k])))
        z = d.body("cuerpo").xmat.reshape(3, 3)[:, 2]
        incl_max = max(incl_max, np.degrees(np.arccos(np.clip(z[2], -1, 1))))
        if video and i % paso_video == 0:
            r.update_scene(d, cam)
            im = Image.new("RGB", (640, 730), (250, 247, 243)); im.paste(Image.fromarray(r.render()), (0, 0)); dr = ImageDraw.Draw(im)
            dr.text((16, 12), nombre, font=fb, fill=(40, 30, 40))
            for k, s in enumerate(SERVOS):
                y = 572 + k * 30
                dr.text((16, y), s, font=f, fill=(40, 30, 40))
                w = int(220 * min(uso[k], 1))
                col = (70, 170, 90) if uso[k] < 0.6 else (230, 160, 40) if uso[k] < 0.9 else (220, 50, 50)
                dr.rectangle([130, y + 4, 350, y + 22], outline=(120, 110, 110))
                dr.rectangle([130, y + 4, 130 + w, y + 22], fill=col)
                dr.text((360, y), f"{uso[k]*100:3.0f}% de su fuerza", font=f, fill=(40, 30, 40))
            frames.append(np.asarray(im))
    if video:
        imageio.mimsave(os.path.join(AQUI, "gestos.mp4"), frames, fps=30, quality=8)
        for nombre_png, seg in (("cuadro_saludo.png", 2.0), ("cuadro_mirar.png", 4.4), ("cuadro_ladear.png", 11.0)):
            Image.fromarray(frames[int(seg * 30)]).save(os.path.join(AQUI, nombre_png))
    print(f"duración {T:.1f} s, inclinación máxima del cuerpo {incl_max:.1f}°")
    print(f"{'servo':10s} {'esfuerzo pico':>14s} {'se atrasó':>10s}  en el gesto")
    for s in SERVOS:
        print(f"{s:10s} {pico[s]*100:12.0f} % {error_max[s]:8.1f}°   {pico_gesto[s]}")
    return pico, error_max, incl_max


if __name__ == "__main__":
    main(video="--sin-video" not in sys.argv)
