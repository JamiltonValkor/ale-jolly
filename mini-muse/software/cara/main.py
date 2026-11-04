"""Cara de Ale en vivo (480×320, 60 fps).

.venv/bin/python main.py                 cara viva en reposo (parpadea, mira, respira, micro-gestos)
.venv/bin/python main.py --galeria       recorre todas las variantes del catálogo con su nombre
.venv/bin/python main.py --bus           obedece al director por el bus (CV-013)
Opciones: --escala 2 (ventana más grande en el Mac) · --pantalla-completa (Pi) · --grabar carpeta (PNG por cuadro)
Teclas: F muestra fps · Esc/Q sale · 1–7 momentos de prueba · E emoción al azar · ESPACIO habla de prueba
"""
import argparse, math, os, sys, time

import pygame

from controlador import Controlador
from render import H, W, Render

MOMENTOS = ["reposo", "escucha", "pensando", "pensando_largo", "trabajando", "hablando", "problema"]


def galeria(ctl: Controlador):
    """Lista (titulo, accion) para recorrer todo el catálogo."""
    pasos = []
    for m, lista in ctl.sel.cat["momentos"].items():
        for v in lista:
            pasos.append((f"momento {m} · {v['nombre']}", lambda t, m=m, n=v["nombre"]: ctl.momento(m, t, pista=n)))
    for e, lista in ctl.sel.cat["emociones"].items():
        for v in lista:
            def f(t, e=e, n=v["nombre"]):
                ctl.momento("hablando", t)
                ctl.sel.ultima.pop(f"e/{e}", None)
                ctl.sel.usada.clear()
                lst = ctl.sel.cat["emociones"][e]
                ctl.sel.cat["emociones"][e] = [x for x in lst if x["nombre"] == n]
                ctl.emocion(e, t)
                ctl.sel.cat["emociones"][e] = lst
            pasos.append((f"emoción {e} · {v['nombre']}", f))
    for g in ctl.sel.cat["micro_gestos"]:
        def f(t, g=g):
            ctl.momento("reposo", t, pista="tranquila")
            if g.get("parpadeo_doble"):
                ctl.anim.parpadear(t + 0.3, doble=True)
            else:
                ctl.anim.gesto(g["gesto"], t + 0.3)
        pasos.append((f"micro-gesto · {g['nombre']}", f))
    return pasos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--galeria", action="store_true")
    ap.add_argument("--bus", action="store_true")
    ap.add_argument("--escala", type=float, default=2.0)
    ap.add_argument("--pantalla-completa", action="store_true")
    ap.add_argument("--grabar", help="carpeta donde guardar cada cuadro (PNG) para hacer video")
    ap.add_argument("--duracion", type=float, default=0, help="segundos y salir (0 = sin fin)")
    ap.add_argument("--semilla", type=int)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--video", help="graba en tiempo real a un .mp4 (30 fps) con ffmpeg")
    ap.add_argument("--registro", help="JSONL con el estado de cada cuadro (pruebas de negocio)")
    a = ap.parse_args()

    pygame.init()
    if a.pantalla_completa:
        ventana = pygame.display.set_mode((W, H), pygame.FULLSCREEN)
        pygame.mouse.set_visible(False)
    else:
        ventana = pygame.display.set_mode((int(W * a.escala), int(H * a.escala)))
    pygame.display.set_caption("Ale")
    reloj = pygame.time.Clock()
    # Se dibuja a la resolución real de la ventana: estirar 480×320 en una pantalla grande se ve borroso.
    tam = ventana.get_size()
    render, ctl = Render(ss=max(2, math.ceil(tam[0] / W)), salida=tam), Controlador(a.semilla)
    fuente = pygame.font.SysFont("Helvetica", 15)
    oyente = None
    if a.bus:
        from oyente import Oyente
        oyente = Oyente(ctl, registro=a.registro)
    pasos = galeria(ctl) if a.galeria else []
    i_paso, t_paso, titulo = -1, 0.0, ""
    ver_fps, n = False, 0
    t_inicio = time.monotonic()
    if a.grabar:
        os.makedirs(a.grabar, exist_ok=True)
    video = None
    if a.video:
        import subprocess
        video = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                  "-s", f"{tam[0]}x{tam[1]}", "-r", "30", "-i", "-", "-vf", "scale=960:640:flags=lanczos",
                                  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", a.video], stdin=subprocess.PIPE)
        a.fps = 30
    corriendo = True
    while corriendo:
        t = time.monotonic() if not a.grabar else t_inicio + n / a.fps     # grabando: tiempo fijo por cuadro
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT or (ev.type == pygame.KEYDOWN and ev.key in (pygame.K_ESCAPE, pygame.K_q)):
                corriendo = False
            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_f:
                    ver_fps = not ver_fps
                elif pygame.K_1 <= ev.key <= pygame.K_7:
                    ctl.momento(MOMENTOS[ev.key - pygame.K_1], t)
                elif ev.key == pygame.K_e:
                    ctl.momento("hablando", t); ctl.emocion(ctl.rnd.choice(list(ctl.sel.cat["emociones"])), t)
                elif ev.key == pygame.K_SPACE:
                    ctl.momento("hablando", t)
        if pasos and t - t_paso > 2.6:
            i_paso = (i_paso + 1) % len(pasos)
            titulo, accion = pasos[i_paso]
            accion(t); t_paso = t
            if a.grabar and i_paso == 0 and n > 0:
                corriendo = False
        if oyente:
            oyente.atender(t)
        if ctl.nombre_momento == "hablando" and not oyente:     # boca de prueba sin voz real
            ctl.anim.boca_extra = max(0.0, 0.55 * math.sin(t * 13) * math.sin(t * 2.3)) if not pasos else \
                max(0.0, 0.45 * math.sin(t * 12) * math.sin(t * 2.1))
        else:
            ctl.anim.boca_extra = ctl.anim.boca_extra if oyente else 0.0
        cara = ctl.cuadro(t)
        sup = render.dibujar(cara, ctl.burb, t)
        if ctl.empareja.activa:                          # robot sin vincular: código + QR en vez de la cara
            ctl.empareja.dibujar(sup, t)
        if titulo:
            sup = sup.copy(); sup.blit(fuente.render(titulo, True, (90, 70, 60)), (10, 296))
        if ver_fps:
            sup = sup.copy(); sup.blit(fuente.render(f"{reloj.get_fps():.0f} fps", True, (90, 70, 60)), (420, 6))
        ventana.blit(sup, (0, 0))
        pygame.display.flip()
        if oyente:
            oyente.publicar_estado(t, cara)
        if a.grabar:
            pygame.image.save(sup, os.path.join(a.grabar, f"{n:05d}.png"))
        if video:
            video.stdin.write(pygame.image.tobytes(sup, "RGB"))
        n += 1
        if a.duracion and (t - t_inicio) >= a.duracion:
            corriendo = False
        reloj.tick(a.fps if not a.grabar else 0)
    if video:
        video.stdin.close(); video.wait()
    pygame.quit()


if __name__ == "__main__":
    sys.exit(main())
