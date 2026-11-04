"""Prueba real de la subida en la Pi, sin tocar el negocio. Corre `Ojo.atender` completo (cámara `carpeta:`, SAM,
numerar y `Nube.subir` con sus reintentos y tiempos) pero la firma apunta a un sumidero público y `photo_done` no sale:
no nace ninguna foto ni propuesta en Stock. Para no mandar imágenes a un tercero, el PUT lleva bytes al azar del mismo
tamaño que la imagen real. La ida y vuelta de `photo_url` se imita con un GET sin credencial al servidor de dev.

  cd ~/ale/ojo && ALE_CAMARA=carpeta:$HOME/ale/ojo/banco/manifiesto.json \\
    .venv/bin/python prueba_subida_real.py --n 10 --escenas S2-a,S5-a,S8-b,S1-recibo --sam real

`--sam grabado` usa `banco/fixtures/sam-jar.sse` (cero llamadas). `--estres S` sube en paralelo, durante S segundos,
un flujo continuo al sumidero: imita al Mac del simulador compartiendo el hotspot. Imprime una línea JSON por foto y un
resumen al final. Sale con 1 si alguna foto no subió.
"""
import argparse, json, os, tempfile, threading, time, urllib.error, urllib.request
from pathlib import Path

import camara as fuentes
import ojo as modulo
import sam as cliente_sam

AQUI = Path(__file__).resolve().parent
SUMIDERO = "https://speed.cloudflare.com/__up"


class BusLista:
    def __init__(self):
        self.mensajes = []

    def publicar(self, tema, **d):
        self.mensajes.append((tema, d))

    def estados(self, s):
        return [d for t, d in self.mensajes if t == "ojo/estado" and d.get("solicitud_id") == s]


class NubeSumidero(modulo.Nube):
    """Mismos reintentos, tiempos y PUT que `Nube`; solo cambia a dónde firma y que el cierre queda en local."""

    def __init__(self, env: Path):
        super().__init__(env)
        self.intentos, self.cierres = 0, []

    def _op1(self, cuerpo: dict) -> dict:
        if cuerpo["op"] == "photo_url":
            self.intentos += 1
            req = urllib.request.Request(self._valor("ALE_RUNTIME_URL").rstrip("/") + "/", headers={"User-Agent": modulo.UA})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    r.read()
            except urllib.error.HTTPError as e:
                if e.code >= 500:
                    raise                                  # dev caído o redesplegando: se reintenta como en la real
            return {"url": SUMIDERO, "content_type": cuerpo["content_type"]}
        self.cierres.append(cuerpo["op"])
        return {}

    def _subir1(self, rol, solicitud, datos):
        super()._subir1(rol, solicitud, os.urandom(len(datos)))


def sam_grabado(*_):
    texto = cliente_sam.leer_stream((AQUI.parent / "banco" / "fixtures" / "sam-jar.sse").read_bytes().splitlines(True))
    return {"objetos": cliente_sam.parsear(texto), "ms": 0}


def estres(segundos: float, parar: threading.Event):
    bloque = os.urandom(4_000_000)
    fin = time.monotonic() + segundos
    while time.monotonic() < fin and not parar.is_set():
        try:
            req = urllib.request.Request(SUMIDERO, data=bloque, method="POST", headers={"User-Agent": "estres"})
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
        except Exception:
            time.sleep(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--escenas", default="S2-a,S5-a,S8-b,S1-recibo")
    ap.add_argument("--concepto", default="jar")
    ap.add_argument("--sam", choices=("real", "grabado"), default="grabado")
    ap.add_argument("--estres", type=float, default=0, help="segundos de subida en paralelo desde la foto --estres-desde")
    ap.add_argument("--estres-desde", type=int, default=6)
    ap.add_argument("--env", default=str(AQUI.parent / "voz-hermes" / ".env"))
    a = ap.parse_args()
    nube = NubeSumidero(Path(a.env))
    camara = fuentes.abrir(clave=nube.clave_meta)
    contar = cliente_sam.contar if a.sam == "real" else sam_grabado
    escenas = a.escenas.split(",")
    resultados, parar = [], threading.Event()
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(a.n):
            if a.estres and i + 1 == a.estres_desde:
                threading.Thread(target=estres, args=(a.estres, parar), daemon=True).start()
            os.environ["ALE_ESCENA"] = escenas[i % len(escenas)]
            bus, sid = BusLista(), f"prueba-subida-{int(time.time())}-{i + 1}"
            antes, t0 = nube.intentos, time.monotonic()
            ojo = modulo.Ojo(bus, nube, camara, Path(tmp), contar=contar)
            ojo.atender({"solicitud_id": sid, "concepto": a.concepto, "etiqueta": "frascos", "foto_id": None})
            fin = bus.estados(sid)[-1]
            fila = {"n": i + 1, "escena": os.environ["ALE_ESCENA"], "ok": fin["estado"] == "subida", "s": round(time.monotonic() - t0, 1),
                    "intentos_firma": nube.intentos - antes, "tiempos": fin.get("tiempos"), "motivo": fin.get("motivo"),
                    "estres": bool(a.estres) and i + 1 >= a.estres_desde}
            resultados.append(fila)
            print(json.dumps(fila, ensure_ascii=False), flush=True)
    parar.set()
    ok = sum(r["ok"] for r in resultados)
    print(json.dumps({"subidas": f"{ok} de {len(resultados)}", "sam": a.sam, "cierres_locales": len(nube.cierres)}, ensure_ascii=False), flush=True)
    raise SystemExit(0 if ok == len(resultados) else 1)


if __name__ == "__main__":
    main()
