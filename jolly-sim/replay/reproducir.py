"""Reproduce un fragmento de traza del robot real en los puertos del bus, sin backend ni micrófono.

  python reproducir.py traza-2026-11-02-p2.jsonl [--bucle] [--velocidad 1.0] [--sin-voz]

- `ojo/*` sale por su puerto (ALE_BUS_OJO, 5562) y el resto por el de la voz (ALE_BUS, 5560), como en el robot. La
  cara (`cara_replay.py`) los oye igual que en vivo. `cara/*` no se reproduce: es la salida de la propia cara.
- Los tiempos del fragmento empiezan en 0 y se trasladan al presente (`t`, `t_pub`, `t0`, `expira`, `abierta_hasta`).
- `voz/frase` se lee con la voz local (say en macOS, espeak o spd-say en Linux) a la hora en que sonó en el robot.
  El audio original nunca se grabó: solo el texto y el volumen (`voz/volumen`, que mueve la boca).
- `ruta_pantalla` es un archivo junto al fragmento (la pantalla de `ojo` que se vio en el robot).
"""
import argparse, json, os, sys, threading, time
from pathlib import Path

import zmq

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent / "robot" / "voz-hermes"))
BUS = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
BUS_OJO = os.environ.get("ALE_BUS_OJO", "tcp://127.0.0.1:5562")
TIEMPOS = ("t", "t0", "expira", "abierta_hasta")
MARGEN_S = 1.5                       # da tiempo a los SUB de conectarse (slow joiner)


def cargar(ruta: Path) -> tuple[dict, list[dict]]:
    lineas = [json.loads(l) for l in ruta.read_text(encoding="utf-8").splitlines() if l.strip()]
    meta = lineas[0] if lineas and lineas[0].get("tema") == "_meta" else {}
    msgs = [m for m in lineas if not m["tema"].startswith(("_", "cara/"))]
    for m in msgs:
        if m.get("ruta_pantalla") and not os.path.isabs(m["ruta_pantalla"]):
            m["ruta_pantalla"] = str(ruta.parent / m["ruta_pantalla"])
    return meta, sorted(msgs, key=lambda m: m["t_pub"])


MESES = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")


def etiqueta(meta: dict) -> str:
    try:
        a, m, d = (int(x) for x in meta["fecha"].split("-"))
        fecha = f"{d}-{MESES[m - 1]}-{a}"
    except (KeyError, ValueError, IndexError):
        fecha = meta.get("fecha", "?")
    return f"REPLAY · traza real del {fecha}"


def locutor_local():
    """say en macOS; espeak o spd-say en Linux y Windows. Sin ninguno, la repetición sigue muda (None)."""
    if sys.platform == "darwin":
        from voz_salida import Locutor
        return Locutor("Paulina")
    from voz_salida import LocutorEspeak
    locutor = LocutorEspeak()
    return locutor if locutor.motor else None


class Bus:
    def __init__(self):
        ctx = zmq.Context.instance()
        self.voz, self.ojo = ctx.socket(zmq.PUB), ctx.socket(zmq.PUB)
        for s, d in ((self.voz, BUS), (self.ojo, BUS_OJO)):
            s.setsockopt(zmq.LINGER, 0)
            try:
                s.bind(d)
            except zmq.ZMQError as e:
                sys.exit(f"❌ No pude abrir {d} ({e}). ¿Hay otro Jolly corriendo? Ciérralo antes de la repetición.")
        self.seq = 0

    def publicar(self, m: dict):
        self.seq += 1
        m = {**m, "seq": self.seq}
        sock = self.ojo if m["tema"].startswith("ojo/") else self.voz
        sock.send_multipart([m["tema"].encode(), json.dumps(m, ensure_ascii=False).encode()])


def reproducir(bus: Bus, msgs: list[dict], velocidad: float = 1.0, locutor=None):
    base = time.monotonic() + MARGEN_S
    mover = lambda x: base + x / velocidad
    for m in msgs:
        espera = mover(m["t_pub"]) - time.monotonic()
        if espera > 0:
            time.sleep(espera)
        nuevo = {k: (mover(v) if k in TIEMPOS and isinstance(v, (int, float)) else v) for k, v in m.items()}
        nuevo["t_pub"] = time.monotonic()
        bus.publicar(nuevo)
        if m["tema"] == "voz/frase":
            print(f"🗣️  {m.get('texto', '')}", flush=True)
            if locutor:
                threading.Timer(max(0.0, nuevo["t"] - time.monotonic()), locutor.decir, (m.get("texto", ""),)).start()
        elif m["tema"] == "ojo/orden":
            print(f"📷 orden de foto: {m.get('concepto')} ({m.get('etiqueta')})", flush=True)
    if locutor:
        locutor.esperar()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("traza", nargs="?", default=str(AQUI / "traza-2026-11-02-p2.jsonl"))
    ap.add_argument("--bucle", action="store_true", help="repite el fragmento hasta Ctrl+C")
    ap.add_argument("--velocidad", type=float, default=1.0)
    ap.add_argument("--sin-voz", action="store_true", help="no leer voz/frase en voz alta")
    ap.add_argument("--etiqueta", action="store_true", help="solo imprime la etiqueta de la traza y sale")
    a = ap.parse_args()
    meta, msgs = cargar(Path(a.traza))
    if a.etiqueta:
        print(etiqueta(meta)); return
    bus = Bus()
    locutor = None if a.sin_voz else locutor_local()
    print(f"▶️  {etiqueta(meta)} · {len(msgs)} mensajes, {meta.get('duracion_s', '?')} s", flush=True)
    if meta.get("descripcion"):
        print(f"   {meta['descripcion']}", flush=True)
    try:
        while True:
            reproducir(bus, msgs, a.velocidad, locutor)
            if not a.bucle:
                break
            print("🔁 otra vez en 5 s", flush=True)
            time.sleep(5)
    except KeyboardInterrupt:
        print("\n👋 Listo.")


if __name__ == "__main__":
    main()
