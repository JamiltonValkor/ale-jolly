"""Reemite una sesión grabada respetando los tiempos (para probar la cara sin red ni voz).

.venv/bin/python -m cuerpo.reproducir sesion.jsonl [--temas cuerpo/ voz/] [--velocidad 1.0]
Las horas `t` se trasladan al presente: t_nuevo = t - t0_grabado + ahora + 0.5 s.
"""
import argparse, json, time

from cuerpo import bus


def cargar(ruta, temas):
    msgs = [json.loads(l) for l in open(ruta, encoding="utf-8") if l.strip()]
    msgs = [m for m in msgs if not m["tema"].startswith("cara/") and (not temas or m["tema"].startswith(tuple(temas)))]
    return sorted(msgs, key=lambda m: m["t_pub"])


def reproducir(msgs, velocidad=1.0, margen=0.5):
    if not msgs:
        return
    t0, ahora = msgs[0]["t_pub"], time.monotonic() + margen
    mover = lambda x: ahora + (x - t0) / velocidad
    for m in msgs:
        espera = mover(m["t_pub"]) - time.monotonic()
        if espera > 0:
            time.sleep(espera)
        datos = {k: v for k, v in m.items() if k not in ("tema", "t", "t_pub", "seq", "t_rec")}
        if "t0" in datos:
            datos["t0"] = mover(datos["t0"])
        if "abierta_hasta" in datos:
            datos["abierta_hasta"] = mover(datos["abierta_hasta"])
        bus.publicar(m["tema"], t=mover(m["t"]), **datos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ruta"); ap.add_argument("--temas", nargs="*"); ap.add_argument("--velocidad", type=float, default=1.0)
    a = ap.parse_args()
    msgs = cargar(a.ruta, a.temas)
    bus.publicar("_arranque")          # abre el socket; da tiempo a los SUB de conectarse (slow-joiner)
    time.sleep(0.6)
    print(f"▶️  {len(msgs)} mensajes", flush=True)
    reproducir(msgs, a.velocidad)
    time.sleep(0.3)


if __name__ == "__main__":
    main()
