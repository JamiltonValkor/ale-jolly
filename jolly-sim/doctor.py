"""Revisa lo que Jolly necesita en este equipo antes de arrancar: ./start.sh doctor

Python y dependencias, PortAudio y micrófono, ffmpeg y cámara, la llave de Meta (un saludo a Muse Voice Transcribe,
sin audio), la voz de salida, los puertos del bus y ale-runtime. Sale con 1 si falta algo imprescindible.
Nunca imprime la llave.
"""
import argparse, asyncio, json, os, platform, shutil, socket, sys, urllib.request, uuid
from pathlib import Path

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
for _flujo in (sys.stdout, sys.stderr):   # consola de Windows (cp1252): que los emojis no tumben el doctor
    try:
        _flujo.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
AQUI = Path(__file__).resolve().parent
ROBOT = AQUI / "robot"
sys.path.insert(0, str(ROBOT / "ojo"))
PUERTOS = (5560, 5561, 5562)
ASR = "wss://api.meta.ai/v1/asr/realtime"
fallos: list[str] = []


def ok(t): print(f"✅ {t}", flush=True)
def aviso(t): print(f"⚠️  {t}", flush=True)
def mal(t, arreglo=""):
    fallos.append(t)
    print(f"❌ {t}" + (f"\n   → {arreglo}" if arreglo else ""), flush=True)


def instalar(paquete_mac: str, paquete_linux: str) -> str:
    if sys.platform == "win32":
        return f"instala {paquete_linux} para Windows y deja su carpeta en el PATH"
    return f"brew install {paquete_mac}" if sys.platform == "darwin" else f"sudo apt install {paquete_linux}"


def python_y_paquetes():
    v = sys.version_info
    (ok if (v.major, v.minor) == (3, 12) else aviso)(f"Python {platform.python_version()} (se fija 3.12)")
    faltan = []
    for m in ("numpy", "pygame", "zmq", "websockets", "PIL", "yaml", "segno", "dotenv"):
        try:
            __import__(m)
        except ImportError:
            faltan.append(m)
    if faltan:
        mal(f"faltan paquetes: {', '.join(faltan)}", "./start.sh los instala")
    else:
        ok("paquetes de Python")


def audio(escuchar: bool):
    try:
        import sounddevice as sd
    except OSError:
        mal("PortAudio no está instalado", instalar("portaudio", "libportaudio2"))
        return
    ok(f"PortAudio ({sd.get_portaudio_version()[1]})")
    try:
        entrada = sd.query_devices(kind="input")
        ok(f"micrófono: {entrada['name']}")
    except Exception as e:
        mal(f"no hay micrófono ({type(e).__name__})", "conecta uno o elige la entrada por defecto del sistema")
        return
    if escuchar:
        import numpy as np
        try:
            datos = sd.rec(int(0.6 * 24000), samplerate=24000, channels=1, dtype="int16", blocking=True)
        except Exception as e:
            mal(f"no pude grabar ({type(e).__name__})")
            return
        if not np.abs(datos).any():
            aviso("el micrófono entrega silencio puro: en macOS dale permiso de micrófono a la terminal "
                  "(Ajustes del Sistema → Privacidad y seguridad → Micrófono)")
        else:
            ok("el micrófono entrega audio")


def camara(probar: bool):
    spec = os.environ.get("ALE_CAMARA", "")
    tipo = spec.partition(":")[0]
    if tipo in ("avfoundation", "v4l2") or not spec:
        if shutil.which("ffmpeg"):
            ok("ffmpeg")
        else:
            mal("falta ffmpeg (la cámara lo usa)", instalar("ffmpeg", "ffmpeg"))
            return
    elif shutil.which("ffmpeg"):
        ok("ffmpeg")
    else:
        aviso("sin ffmpeg: basta para las fotos de ejemplo, no para una cámara real")
    if not spec:
        return
    import camara as fuentes
    try:
        cam = fuentes.abrir(spec)
    except SystemExit as e:
        mal(str(e).removeprefix("❌ "))
        return
    if not probar:
        ok(f"cámara configurada: {spec}")
        return
    try:
        cap = cam.capturar()
        ok(f"cámara {spec}: {len(cap.datos) // 1024} KB, fuente {cap.fuente}")
    except fuentes.ErrorCamara as e:
        arreglo = ("en macOS dale permiso de cámara a la terminal; ffmpeg -f avfoundation -list_devices true -i \"\" "
                   "lista las cámaras" if tipo == "avfoundation" else "")
        mal(f"la cámara {spec} no entregó foto ({e})", arreglo)


async def _saludo(clave: str) -> dict:
    import websockets
    saludo = {"authorization": {"accessToken": f"Bearer {clave}"}, "audioEncoding": "PCM_24KHZ",
              "model": "muse-voice-transcribe-1.0", "mode": "ENDPOINTING", "partialMode": "CUMULATIVE"}
    async with websockets.connect(f"{ASR}?sessionId=doctor-{uuid.uuid4()}", max_size=None, open_timeout=10) as ws:
        await ws.send(json.dumps(saludo))
        ack = json.loads(await asyncio.wait_for(ws.recv(), 10))
        await ws.send(json.dumps({"type": "endStream"}))
        return ack


def llave(probar: bool):
    clave = os.environ.get("META_API_KEY", "")
    if not clave:
        mal("falta META_API_KEY", "export META_API_KEY=… antes de ./start.sh (la repetición no la necesita)")
        return
    if not probar:
        ok("META_API_KEY presente")
        return
    try:
        ack = asyncio.run(_saludo(clave))
    except Exception as e:
        mal(f"no pude hablar con api.meta.ai ({type(e).__name__})", "revisa la conexión a internet")
        return
    if "sessionId" in ack:
        ok("META_API_KEY aceptada por Muse Voice Transcribe")
    else:
        mal("Meta rechazó META_API_KEY", "revisa la llave en https://dev.meta.ai")


def voz(obligatoria: bool = True):
    if os.environ.get("CARTESIA_API_KEY"):
        ok("voz: Cartesia (CARTESIA_API_KEY)")
    elif sys.platform == "darwin" and shutil.which("say"):
        ok("voz: say de macOS (sin CARTESIA_API_KEY)")
    elif sys.platform == "win32" and (shutil.which("powershell") or shutil.which("pwsh")):
        ok("voz: la de Windows (sin CARTESIA_API_KEY)")
    elif any(shutil.which(m) for m in ("espeak-ng", "espeak", "spd-say")):
        ok("voz: espeak/spd-say (sin CARTESIA_API_KEY)")
    elif not obligatoria:
        aviso("sin voz local: la repetición se ve completa pero sin leer las frases en voz alta")
    else:
        aviso("sin voz de salida: Jolly arranca y responde en la cara, sin sonido. " + instalar("espeak-ng", "espeak-ng"))


def puertos():
    ocupados = []
    for p in PUERTOS:
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                ocupados.append(p)
    if ocupados:
        mal(f"puertos del bus ocupados: {ocupados}", "cierra el otro Jolly (o la repetición) antes de arrancar")
    else:
        ok("puertos del bus libres (5560, 5561, 5562)")


def backend():
    url = os.environ.get("ALE_RUNTIME_URL", "http://localhost:8060").rstrip("/")
    try:
        with urllib.request.urlopen(url + "/health", timeout=4) as r:
            ok(f"ale-runtime responde en {url} (HTTP {r.status})")
    except urllib.error.HTTPError as e:
        ok(f"ale-runtime responde en {url} (HTTP {e.code})")
    except OSError:
        mal(f"ale-runtime no responde en {url}",
                                    "levanta el backend con ./local/demo.sh up, o usa ./start.sh --replay")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rapido", action="store_true", help="sin red, sin grabar y sin foto (lo usa start.sh al arrancar)")
    ap.add_argument("--replay", action="store_true", help="solo lo que necesita la repetición")
    a = ap.parse_args()
    print(f"🩺 Jolly · {platform.system()} {platform.machine()}", flush=True)
    python_y_paquetes()
    puertos()
    voz(obligatoria=not a.replay)
    if not a.replay:
        audio(escuchar=not a.rapido)
        camara(probar=not a.rapido)
        llave(probar=not a.rapido)
        if not a.rapido:
            backend()
    if fallos:
        print(f"\n{len(fallos)} problema(s) por resolver.", flush=True)
        sys.exit(1)
    print("\nTodo listo.", flush=True)


if __name__ == "__main__":
    main()
