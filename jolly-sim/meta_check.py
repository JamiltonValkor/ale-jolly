"""Una llamada real a cada modelo de Meta que usa el producto, con la llave del evaluador: ./start.sh meta-check

Muse Spark (Ale y su equipo), Muse Spark con búsqueda web (el investigador), Muse Voice Transcribe (el oído de Jolly),
Muse Image (las fotos de ejemplo de la repisa) y SAM 3.1 (el conteo). Imprime ✅ o ❌ por modelo con su tiempo.
Nunca imprime la llave. Sale con 1 si algún modelo falla.
"""
import asyncio, json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

for _flujo in (sys.stdout, sys.stderr):   # consola de Windows (cp1252)
    try:
        _flujo.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI / "robot" / "ojo"))
sys.path.insert(0, str(AQUI))

import sam                                             # noqa: E402

BASE = "https://api.meta.ai/v1"
SPARK = "muse-spark-1.3-contributor"                   # el mismo de ale-runtime/src/ai/meta-model.ts
UA = sam.UA
FOTO = AQUI / "fotos-ejemplo" / "S2-a.jpg"             # 22 frascos, generada con Muse Image


def _post(ruta: str, cuerpo: dict, clave: str, tiempo_s: float = 90, sse: bool = False) -> str:
    req = urllib.request.Request(BASE + ruta, data=json.dumps(cuerpo).encode(), method="POST", headers={
        "Authorization": f"Bearer {clave}", "Content-Type": "application/json", "User-Agent": UA,
        "Accept": "text/event-stream" if sse else "application/json"})
    with urllib.request.urlopen(req, timeout=tiempo_s) as r:
        return r.read().decode("utf-8", "replace")


def spark(clave: str) -> str:
    r = json.loads(_post("/responses", {"model": SPARK, "input": "Responde solo con la palabra: listo", "max_output_tokens": 2000}, clave))
    texto = "".join(c.get("text", "") for item in r.get("output", []) if item.get("type") == "message" for c in item.get("content", []))
    if not texto.strip():
        raise RuntimeError("respuesta sin texto")
    return f"respondió «{texto.strip()[:40]}»"


def busqueda_web(clave: str) -> str:
    crudo = _post("/responses", {"model": SPARK, "stream": True, "max_output_tokens": 2000,
                                  "tools": [{"type": "web_search", "search_context_size": "low"}],
                                  "input": "Busca en la web una tendencia actual de cuidado capilar y cítala en una frase."},
                  clave, tiempo_s=120, sse=True)
    if "web_search_call" not in crudo:
        raise RuntimeError("no hizo ninguna búsqueda")
    return f"{crudo.count('url_citation')} cita(s)" if "url_citation" in crudo else "buscó (sin citas en esta respuesta)"


def transcribe(clave: str) -> str:
    import doctor
    ack = asyncio.run(doctor._saludo(clave))
    if "sessionId" not in ack:
        raise RuntimeError("Meta rechazó la sesión")
    return "abrió sesión de transcripción en tiempo real"


def imagen(clave: str) -> str:
    r = json.loads(_post("/images/generations", {"model": "muse-image-1.0", "n": 1, "size": "1024x1024", "output_format": "jpeg",
                                                  "prompt": "A white cosmetic jar with a green lid on a white shelf, product photo."}, clave, tiempo_s=120))
    datos = r["data"][0].get("b64_json", "")
    if not datos:
        raise RuntimeError("sin imagen")
    return f"generó una imagen ({len(datos) * 3 // 4 // 1024} KB)"


def conteo(clave: str) -> str:
    r = sam.contar(FOTO.read_bytes(), "jar", clave, tiempo_s=60)
    return f"contó {len(r['objetos'])} frascos en la foto de ejemplo (a ojo: 22)"


MODELOS = (
    ("Muse Spark (Ale y su equipo)", spark),
    ("Muse Spark + búsqueda web (investigador)", busqueda_web),
    ("Muse Voice Transcribe (oído de Jolly)", transcribe),
    ("Muse Image (fotos de la repisa)", imagen),
    ("SAM 3.1 (conteo)", conteo),
)


def main() -> int:
    clave = os.environ.get("META_API_KEY", "")
    if not clave:
        print("❌ falta META_API_KEY (ponla en local/.env o en el entorno)", flush=True)
        return 1
    print("🔑 Probando la llave de Meta con cada modelo del producto…", flush=True)
    fallos = 0
    for nombre, prueba in MODELOS:
        t0 = time.monotonic()
        try:
            detalle = prueba(clave)
            print(f"✅ {nombre}: {detalle} · {time.monotonic() - t0:.1f} s", flush=True)
        except urllib.error.HTTPError as e:
            fallos += 1
            print(f"❌ {nombre}: HTTP {e.code}" + (" (llave sin acceso a este modelo)" if e.code in (401, 403) else ""), flush=True)
        except Exception as e:                           # noqa: BLE001 — se reporta el tipo, nunca el cuerpo
            fallos += 1
            print(f"❌ {nombre}: {type(e).__name__} {str(e)[:80]}", flush=True)
    print("\nTodo listo: la llave sirve para los cinco modelos." if not fallos else f"\n{fallos} modelo(s) con problema.", flush=True)
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
