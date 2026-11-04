"""Voz → instrucciones para Ale/Hermes con respuesta hablada en tiempo real (MVP).

Escucha el micrófono (o un archivo WAV), lo transcribe en tiempo real con Meta Muse Voice Transcribe
y, cuando terminas una frase que empieza con la palabra de activación ("Hermes, ..."), entrega la
instrucción: la muestra en consola, la guarda en grabaciones/instrucciones.jsonl y, si se indica,
la envía por POST a un webhook (etapa 2: Hermes en la VPS).

Uso:
  .venv/bin/python voz_hermes.py                      # micrófono
  .venv/bin/python voz_hermes.py --archivo prueba.wav # archivo WAV (para pruebas)
  .venv/bin/python voz_hermes.py --sin-palabra        # acepta cualquier frase
  .venv/bin/python voz_hermes.py --webhook https://...  # además la envía por POST

Protocolo (wss://api.meta.ai/v1/asr/realtime): 1) handshake JSON con la clave → ack con sessionId;
2) audio PCM16 mono en binario (24 kHz); 3) eventos JSON: speechStart, transcript (parcial
acumulado), speechEnd, speechComplete (texto final); 4) {"type": "endStream"} para cerrar.
"""
import argparse, asyncio, json, os, re, sys, threading, time, unicodedata, uuid, wave
from datetime import datetime
from pathlib import Path

import numpy as np
import websockets
from dotenv import load_dotenv

from avisos import Avisos, CandadoTurno, Conversacion
from cuerpo import bus
from cuerpo.sueno import Sueno

URL = "wss://api.meta.ai/v1/asr/realtime"
MODELO = "muse-voice-transcribe-1.0"
TASA = 24000                      # tasa nativa de Muse (también acepta 16000)
BLOQUE_S = 0.08                   # 80 ms por envío
AQUI = Path(__file__).parent
CRON = {"t0": None, "activo": False}


def cron(evento: str):
    """Cronómetro: imprime ms desde que terminaste de hablar (fin de voz detectado por Muse)."""
    if CRON["activo"] and CRON["t0"] is not None:
        print(f"\n   ⏱️ {1000 * (time.monotonic() - CRON['t0']):6.0f} ms  {evento}", end="", flush=True)
SALIDA = AQUI / "grabaciones" / "instrucciones.jsonl"


def normalizar(t: str) -> str:
    t = unicodedata.normalize("NFD", t.lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


MULETILLAS = ("oye", "hola", "hey", "ey", "oiga", "bueno", "hi", "hello", "ok", "okay")

# Nombre del robot: Jolly (el personaje de Meta Muse, también "Jollybot"). Formas en que se pronuncia y en que Muse
# STT lo escribe, en español e inglés ("yóli", "jóli", "jolly", "yoly"…). Se comparan como PALABRA COMPLETA al inicio
# de la frase, así "Yolanda" o "Jolie Pitt" no cuentan si no son la primera palabra exacta. Para agregar una forma
# nueva que veas en la terminal, súmala aquí.
NOMBRE_ROBOT = ["jolly", "jollybot", "joly", "jolli", "joli", "jolie", "jolley", "yoli", "yoly", "yolly", "yolli",
                "yoley", "choli", "cholly", "iolli", "ioli",
                "jelly", "jely", "jeli", "jelli", "yelly", "yeli", "yely", "chelly", "dolly", "holly"]


def extraer_instruccion(texto: str, palabras: list[str] | None) -> str | None:
    """Devuelve la instrucción si la frase empieza (tras "oye/hola…" opcional) con la palabra de
    activación como palabra completa ("Ale, …", "Oye Muse …"); si no, None."""
    if not palabras:
        return texto.strip()
    original = texto.strip().lstrip(" ¡¿\"'")
    n = normalizar(original)
    quitada = True                             # quitar "oye", "hola,"… aunque vengan varias ("Hey, hola Jolly")
    while quitada:                             # (misma longitud en n y en original)
        quitada = False
        for m in MULETILLAS:
            if n.startswith(m) and len(n) > len(m) and not n[len(m)].isalnum():
                n, original = n[len(m):].lstrip(" ,.!¡"), original[len(m):].lstrip(" ,.!¡")
                quitada = True
    for p in palabras:
        if n.startswith(p) and (len(n) == len(p) or not n[len(p)].isalnum()):
            return original[len(p):].lstrip(" ,.:;!¡?¿-").strip() or None
    return None


def empieza_con_palabra(texto: str, palabras: list[str] | None) -> bool:
    """¿El texto (aunque sea un parcial: "Ale", "Oye Ale,") empieza con la palabra de activación como palabra
    completa? Misma normalización y muletillas que extraer_instruccion, pero sin exigir instrucción detrás."""
    if not palabras:
        return False
    n = normalizar(texto.strip().lstrip(" ¡¿\"'"))
    quitada = True
    while quitada:
        quitada = False
        for m in MULETILLAS:
            if n.startswith(m) and len(n) > len(m) and not n[len(m)].isalnum():
                n = n[len(m):].lstrip(" ,.!¡")
                quitada = True
    return any(n.startswith(p) and (len(n) == len(p) or not n[len(p)].isalnum()) for p in palabras)


# Formas del nombre que también son palabras comunes: valen al inicio de la frase, no en medio ("I love jelly").
SOLO_AL_INICIO = {"jelly", "jely", "jeli", "jelli", "dolly", "holly", "jolie"}
ESPERA_NOMBRE_S = 8.0           # solo "Hey Jolly": la siguiente frase pasa sin repetir el nombre durante este tiempo


def nombre_en_frase(texto: str, palabras: list[str] | None) -> tuple[int, int] | None:
    """Posición (inicio, fin) en `texto` de la primera mención del nombre como palabra completa, esté donde esté
    ("Traje mercancía, Jolly"); en medio de la frase no cuentan las formas de SOLO_AL_INICIO."""
    if not palabras:
        return None
    primera = True
    for w in re.finditer(r"\w+", texto):
        n = normalizar(w.group())
        if n in palabras and (primera or n not in SOLO_AL_INICIO):
            return w.start(), w.end()
        primera = primera and n in MULETILLAS
    return None


def instruccion_con_nombre(texto: str, palabras: list[str] | None) -> str | None:
    """Como extraer_instruccion, pero el nombre puede ir en cualquier parte: "Hola Jolly, traje…", "Oye, Jolly…",
    "Traje mercancía, Jolly". Quita el nombre (y la muletilla pegada antes) y devuelve el resto, o None."""
    instr = extraer_instruccion(texto, palabras)
    if instr or not palabras:
        return instr
    pos = nombre_en_frase(texto, palabras)
    if not pos:
        return None
    antes, despues = texto[:pos[0]], texto[pos[1]:]
    previa = re.search(r"(\w+)[\s,.!¡]*$", antes)
    if previa and normalizar(previa.group(1)) in MULETILLAS:
        antes = antes[:previa.start()]
    antes = antes.rstrip(" ,.:;!¡¿-")
    despues = despues.lstrip(" ,.:;!¡?¿-")
    resto = f"{antes} {despues}".strip() if antes and despues else (antes or despues).strip()
    if not any(c.isalnum() for c in resto):
        return None
    sueltas = resto.split()
    if len(sueltas) == 1 and len(normalizar(sueltas[0]).strip(" ,.:;!¡?¿-")) <= 2 \
            and normalizar(sueltas[0]).strip(" ,.:;!¡?¿-") not in RESPUESTAS_CORTAS:
        return None                                  # "la hey Jolly": ruido + nombre = solo el nombre
    return resto


RESPUESTAS_CORTAS = {"si", "no", "ok", "ya"}


def es_eco(texto: str, dicho: list) -> bool:
    """¿La frase es casi toda palabras que el robot dijo en los últimos 30 s?"""
    pal = [w for w in "".join(c if c.isalnum() else " " for c in normalizar(texto)).split() if len(w) > 2]
    ahora = time.monotonic()
    reciente = set()
    for t, frase in dicho:
        if ahora - t < 30:
            reciente |= set("".join(c if c.isalnum() else " " for c in normalizar(frase)).split())
    return bool(pal) and sum(w in reciente for w in pal) / len(pal) >= 0.7


async def fuente_microfono(cola: asyncio.Queue):
    import sounddevice as sd
    loop = asyncio.get_running_loop()
    n = int(TASA * BLOQUE_S)

    def cb(indata, frames, t, status):
        loop.call_soon_threadsafe(cola.put_nowait, bytes(indata))

    with sd.RawInputStream(samplerate=TASA, channels=1, dtype="int16", blocksize=n, callback=cb):
        print("🎙️  Escuchando… (Ctrl+C para salir)", flush=True)
        await asyncio.Event().wait()


def leer_wav(ruta: str) -> np.ndarray:
    with wave.open(ruta, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "El WAV debe ser mono de 16 bits"
        datos = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        tasa = w.getframerate()
    if tasa != TASA:                                    # remuestreo lineal simple
        x = np.linspace(0, len(datos) - 1, int(len(datos) * TASA / tasa))
        datos = np.interp(x, np.arange(len(datos)), datos).astype(np.int16)
    return datos


async def fuente_archivo(cola: asyncio.Queue, ruta: str):
    datos = leer_wav(ruta)
    datos = np.concatenate([datos, np.zeros(int(TASA * 2.5), np.int16)])  # silencio final para que cierre la frase
    n = int(TASA * BLOQUE_S)
    print(f"📼 Archivo {ruta}: {len(datos) / TASA:.1f} s", flush=True)
    for i in range(0, len(datos), n):
        await cola.put(datos[i:i + n].tobytes())
        await asyncio.sleep(BLOQUE_S)                   # ritmo de tiempo real (Muse lo exige)
    await cola.put(None)


def carpeta_inyectada() -> str | None:
    """Voz de prueba por archivos: solo con ALE_AVISOS=1 y nunca en producción."""
    if os.getenv("ALE_AVISOS") != "1" or os.getenv("ALE_ENTORNO") == "produccion":
        return None
    return os.getenv("ALE_VOZ_CARPETA") or None


async def fuente_carpeta(cola: asyncio.Queue, carpeta: str):
    """Reemplaza al micrófono para provocar colisiones: silencio continuo, y cada WAV nuevo entra a ritmo de tiempo real."""
    n, vistos = int(TASA * BLOQUE_S), set()
    print(f"📂 Voz inyectada desde {carpeta}", flush=True)
    while True:
        nuevos = sorted(p for p in Path(carpeta).glob("*.wav") if p not in vistos)
        if nuevos:
            vistos.add(nuevos[0])
            datos = leer_wav(str(nuevos[0]))
            for i in range(0, len(datos), n):
                await cola.put(datos[i:i + n].tobytes())
                await asyncio.sleep(BLOQUE_S)
        else:
            await cola.put(bytes(2 * n))
            await asyncio.sleep(BLOQUE_S)


class AleHermes:
    """Cliente del backend de SaleADS (sa-meta-assistant-service), el mismo camino que usa el front:
    POST /assistants/me/sessions → {session_id};  POST /assistants/me/sessions/{id}/stream {"text"} → SSE
    con eventos token{text}, tool_start{name}, tool_end{name,ok}, message_end, provider_error{reason}, error,
    mcp_unavailable, assistant_restarting. Auth: token web de Keycloak (Bearer)."""

    KEYCLOAK = os.getenv("ALE_LOGIN_TOKEN_URL", "")           # solo modo desarrollo con login web

    def __init__(self, base: str, token: str, refresh: str | None = None):
        self.base, self.token, self.refresh, self.sesion = base.rstrip("/"), token, refresh, None

    def renovar(self) -> bool:
        """Pide un token nuevo con el refresh token (cliente público 'front')."""
        import urllib.parse, urllib.request
        if not self.refresh or not self.KEYCLOAK:
            return False
        datos = urllib.parse.urlencode({"client_id": "front", "grant_type": "refresh_token",
                                        "refresh_token": self.refresh}).encode()
        try:
            with urllib.request.urlopen(urllib.request.Request(self.KEYCLOAK, data=datos, headers={"User-Agent": "Mozilla/5.0 (Macintosh) voz-hermes/1.0"}), timeout=20) as r:
                t = json.loads(r.read())
            self.token, self.refresh = t["access_token"], t.get("refresh_token", self.refresh)
            print("   ↳ token renovado", flush=True)
            return True
        except Exception:
            return False

    def _req(self, ruta, cuerpo=None):
        import urllib.request
        datos = json.dumps(cuerpo).encode() if cuerpo is not None else b""
        return urllib.request.Request(self.base + ruta, data=datos, method="POST", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": "voz-hermes/1.0",
            "Accept": "text/event-stream"})

    def _abrir_sesion(self):
        import urllib.request
        with urllib.request.urlopen(self._req("/assistants/me/sessions", {}), timeout=30) as r:
            self.sesion = json.loads(r.read())["session_id"]

    def _ruta_stream(self) -> str:
        return f"/assistants/me/sessions/{self.sesion}/stream"

    def preparar(self):
        """Abre la sesión de chat ANTES de escuchar (ahorra ~2 s en la primera pregunta)."""
        import urllib.request, urllib.error
        try:
            with urllib.request.urlopen(self._req("/assistants/me/sessions", {}), timeout=30) as r:
                self.sesion = json.loads(r.read())["session_id"]
            print(f"🤝 Sesión con Ale lista: {self.sesion}", flush=True)
        except urllib.error.HTTPError as e:
            if e.code == 401 and self.renovar():
                return self.preparar()
            print(f"⚠️ No pude abrir la sesión con Ale ({e.code}); se intentará al preguntar", flush=True)
        except Exception as e:
            print(f"⚠️ No pude abrir la sesión con Ale: {e}", flush=True)

    # modo voz del backend (feat/meta-voice-stream): razonamiento corto + eventos commentary/thinking.
    # Si el backend aún no lo tiene (400 por campo desconocido), se apaga solo y se sigue sin él.
    modo_voz = True

    def preguntar(self, texto: str, reintento: bool = True, al_token=None, al_comentario=None, turno=None) -> str:
        """Pregunta a Ale. Publica ale/evento pregunta una sola vez (aunque haya reintentos) y fin siempre."""
        bus.publicar("ale/evento", tipo="pregunta", texto=texto, turno=turno)
        try:
            return self._preguntar(texto, reintento, al_token, al_comentario, turno)
        finally:
            bus.publicar("ale/evento", tipo="fin", turno=turno)

    def _preguntar(self, texto: str, reintento: bool = True, al_token=None, al_comentario=None, turno=None) -> str:
        import urllib.request, urllib.error
        try:
            if not self.sesion:
                self._abrir_sesion()
                print(f"   ↳ sesión de chat con Hermes: {self.sesion}", flush=True)
            respuesta, t0 = [], time.monotonic(); cron("📤 pregunta enviada a Ale")
            with urllib.request.urlopen(self._req(self._ruta_stream(),
                                                  {"text": texto, "voice": True} if self.modo_voz else {"text": texto}), timeout=660) as r:
                print("🤖 ", end="", flush=True)
                evento = None                     # SSE: "event: <tipo>" y luego "data: {...}"
                for linea in r:
                    linea = linea.decode("utf-8").rstrip("\r\n")
                    if linea.startswith("event:"):
                        evento = linea[6:].strip(); continue
                    if not linea.startswith("data:"):
                        continue
                    e = json.loads(linea[5:].strip() or "{}"); tipo = e.get("type") or evento
                    if tipo == "token":
                        cron(f"📥 llega texto de Ale ({len(e['text'])} letras)")
                        if not respuesta:
                            bus.publicar("ale/evento", tipo="primer_token", turno=turno)
                            print(f"[1er token {time.monotonic() - t0:.1f} s] ", end="", flush=True)
                        respuesta.append(e["text"]); print(e["text"], end="", flush=True)
                        if al_token:
                            al_token(e["text"])
                    elif tipo == "thinking":
                        cron("🤔 Ale está pensando")   # aquí la cara del robot pasa a "pensando"
                    elif tipo == "commentary":
                        bus.publicar("ale/evento", tipo="comentario", texto=e["text"], turno=turno)
                        cron(f"💬 comentario de Ale ({len(e['text'])} letras)")
                        print(f"\n   💬 {e['text']}", flush=True)
                        if al_comentario:
                            al_comentario(e["text"])
                    elif tipo == "tool_start":
                        bus.publicar("ale/evento", tipo="herramienta_inicio", nombre=e.get("name", ""), turno=turno)
                        print(f"\n   🔧 usando {e['name']}…", flush=True)
                    elif tipo == "tool_end":
                        bus.publicar("ale/evento", tipo="herramienta_fin", nombre=e.get("name", ""), ok=bool(e.get("ok")),
                                     turno=turno)
                        print(f"   🔧 {e['name']} {'✓' if e.get('ok') else '✗'}", flush=True)
                    elif tipo in ("provider_error", "error", "mcp_unavailable", "assistant_restarting"):
                        bus.publicar("ale/evento", tipo="error", origen="sse", motivo=f"{tipo} {e.get('reason', '')}".strip(),
                                     turno=turno)
                        print(f"\n   ⚠️ {tipo} {e.get('reason', '')}", flush=True)
                    elif tipo == "message_end":
                        cron("🏁 Ale terminó de responder"); break
            print(f"\n   ⏱️ respuesta en {time.monotonic() - t0:.1f} s", flush=True)
            return "".join(respuesta)
        except urllib.error.HTTPError as e:
            cuerpo = e.read().decode(errors="ignore")[:200]
            if e.code == 400 and self.modo_voz:
                print("   ↳ el backend aún no tiene modo voz; sigo sin él", flush=True)
                self.modo_voz = False
                return self._preguntar(texto, reintento=reintento, al_token=al_token, al_comentario=al_comentario, turno=turno)
            if e.code == 401 and reintento and self.renovar():
                return self._preguntar(texto, reintento=False, al_token=al_token, al_comentario=al_comentario, turno=turno)
            bus.publicar("ale/evento", tipo="error", origen="http", motivo=f"{e.code} {cuerpo[:100]}".strip(), turno=turno)
            if e.code == 401:
                print("\n❌ Hermes: token vencido o inválido (401). Renueva SALEADS_TOKEN en .env", flush=True)
            else:
                print(f"\n❌ Hermes respondió {e.code}: {cuerpo}", flush=True)
        except Exception as e:
            bus.publicar("ale/evento", tipo="error", origen="red", motivo=str(e)[:200], turno=turno)
            print(f"\n❌ No pude hablar con Hermes: {e}", flush=True)
        return ""


def entregar(instr: dict, webhook: str | None, hermes: "AleHermes | None" = None, locutor=None, relleno: bool = True,
             turno: str | None = None):
    if os.path.exists("/tmp/jolly-cara"):   # rodaje del villano: escucha y transcribe, pero no le pasa nada a Ale
        print(f"🎬 rodaje: no se envía a Ale → {instr['instruccion']!r}", flush=True)
        return
    SALIDA.parent.mkdir(exist_ok=True)
    with open(SALIDA, "a", encoding="utf-8") as f:
        f.write(json.dumps(instr, ensure_ascii=False) + "\n")
    print(f"\n✅ INSTRUCCIÓN → {instr['instruccion']!r}   (frase cerrada en el audio a los {instr['fin_audio_ms']} ms)", flush=True)
    if webhook:
        import urllib.request
        req = urllib.request.Request(webhook, data=json.dumps(instr).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                print(f"   ↳ enviada al webhook ({r.status})", flush=True)
        except Exception as e:
            print(f"   ↳ ⚠️ no se pudo enviar al webhook: {e}", flush=True)
    if hermes:
        frag = None
        if locutor:
            locutor.turno = turno                 # voz/* lleva el turno de la conversación
            from voz_salida import Fragmentador
            frag = Fragmentador(locutor); locutor.t_primer_audio = None
        t0 = time.monotonic()
        al_token = frag.token if frag else None
        if locutor and hasattr(locutor, "idioma"):
            from voz_cartesia import idioma
            locutor.idioma = idioma(instr["instruccion"], locutor.idioma)   # rellenos en el idioma de la pregunta
        if relleno and locutor and hasattr(locutor, "relleno"):
            # tapa el tiempo en que Ale piensa: un "mmm…" ya, y otro si a los 3.5 s aún no responde
            frase = locutor.relleno("inicio")
            if frase:
                bus.publicar("ale/evento", tipo="relleno", clase="inicio", frase=frase, turno=turno)
            llego = threading.Event()
            def _espera():
                if not llego.wait(3.5):
                    frase = locutor.relleno("espera")
                    if frase:
                        bus.publicar("ale/evento", tipo="relleno", clase="espera", frase=frase, turno=turno)
            threading.Thread(target=_espera, daemon=True).start()
            def al_token(t, _f=frag.token):
                llego.set(); _f(t)
        instr["respuesta"] = hermes.preguntar(instr["instruccion"], al_token=al_token,
                                              al_comentario=locutor.decir if locutor else None, turno=turno)
        if frag:
            if relleno and hasattr(locutor, "relleno"):
                llego.set()                   # sin respuesta (error) tampoco debe sonar el "ya casi"
            frag.cerrar()
            if hasattr(locutor, "fin_turno"):
                locutor.fin_turno()
            if locutor.t_primer_audio:
                print(f"   🔊 empezó a hablar a los {locutor.t_primer_audio - t0:.1f} s de enviar la pregunta", flush=True)
        with open(SALIDA, "a", encoding="utf-8") as f:
            f.write(json.dumps({"turno": instr.get("turno"), "respuesta": instr["respuesta"]}, ensure_ascii=False) + "\n")


class Dormida(Exception):
    """Jolly se durmió: se cierra la sesión con Muse y el micrófono."""


async def sesion(args, clave: str):
    cola: asyncio.Queue = asyncio.Queue()
    palabras = None if args.sin_palabra else [normalizar(p) for p in args.palabra]
    handshake = {
        "authorization": {"accessToken": f"Bearer {clave}"},
        "audioEncoding": f"PCM_{TASA // 1000}KHZ",
        "model": MODELO,
        "mode": "ENDPOINTING",
        "partialMode": "CUMULATIVE",
        "emitAudioProgress": False,
        "languageBias": ["Spanish", "English"],
        "keywords": args.keywords,
    }
    async with websockets.connect(f"{URL}?sessionId=stream-{uuid.uuid4()}", max_size=None) as ws:
        await ws.send(json.dumps(handshake))
        ack = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if "sessionId" not in ack:
            sys.exit(f"❌ Meta rechazó la sesión: {ack.get('message', ack)}")
        print(f"🔗 Conectado a Muse Voice Transcribe (sesión {ack['sessionId']})", flush=True)

        carpeta = getattr(args, "carpeta", None)
        fuente = (fuente_archivo(cola, args.archivo) if args.archivo else
                  fuente_carpeta(cola, carpeta) if carpeta else fuente_microfono(cola))
        t_fuente = asyncio.create_task(fuente)
        estado = {"fin_voz": None, "turno": None, "nombre": False, "t_inicio": None}
        loc = args.locutor
        avisos, candado = getattr(args, "avisos", None), getattr(args, "candado", None)
        conv = getattr(args, "conv", None) or Conversacion()    # la de args sobrevive a la reconexión de Muse
        conv.sesion_nueva()
        ses = uuid.uuid4().hex[:6]               # turnId de Muse se reinicia en cada sesión: turno = sesión-turnId

        def oido(tipo, **datos):
            bus.publicar("oido/evento", tipo=tipo, turno=estado["turno"], **datos)

        def ignorada(motivo):
            oido("ignorada", motivo=motivo)
            if estado["nombre"]:                 # nombre_detectado fue tentativo: el director vuelve atrás
                estado["nombre"] = False
                oido("nombre_cancelado", motivo=motivo)

        async def enviar_audio():
            while True:
                b = await cola.get()
                if b is None:
                    await ws.send(json.dumps({"type": "endStream"}))
                    return
                if loc and loc.ocupado(cola_s=0.8):
                    b = bytes(len(b))           # silencio del mismo largo: Muse sigue a tiempo real
                await ws.send(b)

        async def recibir():
            async for m in ws:
                if isinstance(m, bytes):
                    continue
                e = json.loads(m); tipo = e.get("type")
                if tipo == "speechStart":
                    estado["turno"], estado["nombre"] = f"{ses}-{e.get('turnId', uuid.uuid4().hex[:6])}", False
                    estado["t_inicio"] = time.monotonic()   # la ventana cuenta desde que empezó a hablar
                    conv.habla_inicio()
                    oido("habla_inicio")
                    print("\n🗣️  …", end="", flush=True)
                elif tipo == "transcript" and e.get("transcript"):
                    conv.parcial()
                    if estado["turno"] is None:
                        estado["turno"] = f"{ses}-{uuid.uuid4().hex[:6]}"
                    oido("parcial", texto=e["transcript"])
                    if (not estado["nombre"] and palabras and not (loc and loc.ocupado())
                            and (empieza_con_palabra(e["transcript"], palabras) or nombre_en_frase(e["transcript"], palabras))):
                        estado["nombre"] = True          # una vez por frase; tentativo hasta el texto final
                        oido("nombre_detectado", texto=e["transcript"])
                    print(f"\r🗣️  {e['transcript'][:110]}", end="", flush=True)
                elif tipo == "speechEnd":
                    estado["fin_voz"] = time.monotonic()
                    conv.habla_fin()
                    oido("habla_fin")
                    CRON["t0"] = time.monotonic(); cron("🛑 Muse detecta que terminaste de hablar")
                    estado["fin_audio_ms"] = e.get("audioProcessedMs")
                elif tipo == "speechComplete":
                    texto = e.get("transcript", "").strip()
                    if e.get("turnId") is not None:
                        estado["turno"] = f"{ses}-{e['turnId']}"
                    if loc and loc.ocupado():
                        ignorada("ocupado")
                        print(f"\r   (ignorado mientras Ale habla: {texto[:60]!r})", flush=True)
                        if avisos:
                            avisos.frase_ignorada()
                        continue
                    # momento (en el reloj del audio) en que Muse cerró la frase
                    lat = e.get("audioProcessedMs")
                    cron("📝 texto final de Muse"); print(f"\r📝 {texto}", flush=True)
                    exenta = bool(avisos) and conv.tomar_exencion_eco()   # «llegaron 22» responde, no es eco
                    if loc and not exenta and es_eco(texto, getattr(loc, "dicho", [])):
                        ignorada("eco")
                        print("   (eco de la voz del robot: ignorado)", flush=True)
                        continue
                    instr = instruccion_con_nombre(texto, palabras)
                    # dentro de la ventana vale la frase que EMPEZÓ antes de que cerrara, aunque Muse la cierre después
                    inicio = estado["t_inicio"] or time.monotonic()
                    en_conversacion = min(inicio, time.monotonic()) < conv.abierta_hasta
                    estado["t_inicio"] = None
                    if not instr and palabras and en_conversacion and any(c.isalnum() for c in texto) \
                            and not nombre_en_frase(texto, palabras):
                        instr = texto                    # conversación abierta: no hace falta repetir "Jolly"
                    if not instr and palabras and nombre_en_frase(texto, palabras):
                        # solo "Hey Jolly": escucha la frase siguiente sin repetir el nombre (la cara queda en escucha)
                        estado["nombre"] = False
                        conv.abierta_hasta = max(conv.abierta_hasta, time.monotonic() + ESPERA_NOMBRE_S)
                        bus.publicar("oido/evento", tipo="ventana", abierta_hasta=conv.abierta_hasta, turno=estado["turno"])
                        print(f"   👂 te escucho: dime en {ESPERA_NOMBRE_S:.0f} s", flush=True)
                        continue
                    if instr:
                        estado["nombre"] = False
                        turno = estado["turno"]
                        oido("aceptada", instruccion=instr, en_conversacion=en_conversacion)
                        pedido = {"instruccion": instr, "texto": texto, "hora": datetime.now().isoformat(timespec="seconds"),
                                  "fin_audio_ms": lat, "turno": e.get("turnId")}
                        while candado and not candado.tomar(False):   # sondeo: cancelar la tarea nunca deja el candado tomado
                            await asyncio.sleep(0.02)
                        try:                             # cubre el hueco en que Ale piensa y aún no suena nada
                            await asyncio.to_thread(entregar, pedido, args.webhook, args.cliente_hermes, loc, en_conversacion, turno)
                            if loc:
                                await asyncio.to_thread(loc.esperar)
                        finally:
                            if candado:
                                candado.soltar()
                        if avisos and pedido.get("respuesta", "").rstrip().endswith("?"):
                            conv.exentar_eco(time.monotonic() + max(args.ventana, 0))
                        if args.ventana > 0 and palabras:
                            conv.abierta_hasta = time.monotonic() + args.ventana
                            bus.publicar("oido/evento", tipo="ventana", abierta_hasta=conv.abierta_hasta, turno=turno)
                            print(f"   💬 te sigo escuchando {args.ventana:.0f} s sin que digas mi nombre", flush=True)
                    else:
                        ignorada("sin_nombre")
                        print("   (sin el nombre y fuera de la conversación: ignorada)", flush=True)
                elif tipo == "error":
                    print(f"\n❌ Error de Muse: {e.get('message', e)}", flush=True)

        async def vigilar_sueno():
            sueno = getattr(args, "sueno", None)
            while not (sueno and sueno.dormido and not (loc and loc.ocupado())):    # termina de hablar y se duerme
                await asyncio.sleep(0.2)
            raise Dormida

        t_env = asyncio.create_task(enviar_audio()); t_rec = asyncio.create_task(recibir())
        t_sue = asyncio.create_task(vigilar_sueno())
        tareas = {t_env, t_rec} if args.archivo else {t_env, t_rec, t_sue}
        await asyncio.wait(tareas, return_when=asyncio.FIRST_EXCEPTION if not args.archivo else asyncio.ALL_COMPLETED)
        for t in (t_fuente, t_env, t_rec, t_sue):
            t.cancel()
        if t_sue.done() and not t_sue.cancelled():
            t_sue.exception()


def main():
    ap = argparse.ArgumentParser(description="Voz → instrucciones para Hermes (MVP)")
    ap.add_argument("--archivo", help="WAV mono 16 bits para probar sin micrófono")
    ap.add_argument("--palabra", nargs="+", default=NOMBRE_ROBOT,
                    help="palabras de activación (sin tildes; 'Alé' cuenta como 'ale')")
    ap.add_argument("--ventana", type=float, default=20, help="segundos de conversación abierta tras cada respuesta")
    ap.add_argument("--sin-voz", action="store_true", help="no hablar las respuestas")
    ap.add_argument("--tts", choices=("cartesia", "say"), default="cartesia",
                    help="motor de voz: cartesia (nube, tiempo real) o say (la voz del sistema: macOS, Windows o espeak en Linux)")
    ap.add_argument("--voz", help="voz: cathy (por defecto), connie, katie, ella, adriana, dayana, catalina o un id de Cartesia; con --tts say, una voz de macOS")
    ap.add_argument("--cronometro", action="store_true", help="mostrar los milisegundos de cada tramo")
    ap.add_argument("--cuerpo", action="store_true",
                    help="arranca el director del cuerpo: la cara (robot/cara main.py --bus) reacciona")
    ap.add_argument("--sin-palabra", action="store_true", help="aceptar cualquier frase")
    ap.add_argument("--webhook", help="URL para enviar cada instrucción por POST")
    ap.add_argument("--hermes", nargs="?", const="http://localhost:8060", help="modo desarrollo: enviar a Hermes con login web (por defecto ale-runtime local)")
    ap.add_argument("--robot", nargs="?", const="", metavar="URL",
                    help="canal robot: se empareja con SaleADS (código/QR) y habla con la credencial del robot; "
                         "URL de ale-runtime (por defecto ALE_RUNTIME_URL). Sin esto, modo desarrollo con login web")
    args = ap.parse_args()
    load_dotenv(AQUI / ".env")
    clave = os.getenv("META_API_KEY")
    if not clave:
        sys.exit("❌ Falta META_API_KEY en voz-hermes/.env")
    args.cliente_hermes = None
    args.keywords = ["Jolly"]                         # sesgo de Muse STT hacia el nombre del robot
    args.locutor = None
    args.sueno = None if args.archivo else Sueno()
    args.carpeta = None if args.archivo else carpeta_inyectada()
    avisos_activos = os.getenv("ALE_AVISOS") == "1"
    args.avisos = None
    if args.robot is not None:
        args.robot = args.robot or os.getenv("ALE_RUNTIME_URL", "")
        if not args.robot:
            sys.exit("❌ Falta la URL de ale-runtime: --robot URL o ALE_RUNTIME_URL en .env")
        args.hermes = args.hermes or args.robot           # activa voz, rellenos y respuesta como en --hermes
    if args.hermes and not args.sin_voz:
        if args.tts == "cartesia" and os.getenv("CARTESIA_API_KEY"):
            from voz_cartesia import LocutorCartesia
            args.locutor = LocutorCartesia(args.voz or "cathy")
        else:
            if args.tts == "cartesia":
                print("⚠️ Falta CARTESIA_API_KEY en .env: uso la voz del sistema", flush=True)
            from voz_salida import locutor_del_sistema
            args.locutor = locutor_del_sistema(args.voz)
        args.locutor.cron = cron
    if avisos_activos and args.locutor:
        args.candado, args.conv = CandadoTurno(), Conversacion()
        (AQUI / "grabaciones").mkdir(exist_ok=True)
        args.avisos = Avisos(args.locutor, args.candado, args.conv, AQUI / "grabaciones" / "avisos-dichos.json", sueno=args.sueno, ventana=args.ventana)
    CRON["activo"] = args.cronometro
    if args.cuerpo:
        from cuerpo.director import arrancar
        args.listo = threading.Event()
        arrancar(args.listo)
        print("🙂 Director del cuerpo activo (bus " + bus.DIRECCION + ")", flush=True)
    if args.robot:
        bus.exigir_libre()
        sys.modules.setdefault("voz_hermes", sys.modules[__name__])   # canal_robot usa ESTE módulo (cronómetro, bus)
        from canal_robot import AleRobot
        args.cliente_hermes = AleRobot(args.robot, AQUI / ".env", avisos=args.avisos, sueno=args.sueno)
        args.cliente_hermes.preparar()                  # sin credencial: muestra el código y espera al dueño
    elif args.hermes:
        token = os.getenv("SALEADS_TOKEN")
        if not token:
            sys.exit("❌ Falta SALEADS_TOKEN (token web de SaleADS) en voz-hermes/.env")
        args.cliente_hermes = AleHermes(args.hermes, token, os.getenv("SALEADS_REFRESH"))
        args.cliente_hermes.preparar()
    if args.avisos:
        args.avisos.start()
    bus.publicar("_arranque")                           # abre el bus antes de escuchar (los oyentes ya conectan)
    if args.sueno:
        args.sueno.escuchar()
    if getattr(args, "listo", None):                    # dormido: que la cara oiga la orden antes del primer latido
        threading.Timer(2.5 if args.sueno and args.sueno.dormido else 0, args.listo.set).start()
    while True:                                         # Muse cierra la sesión a los 60 min: reconectar
        try:
            if args.sueno:
                args.sueno.esperar_despierto()
            asyncio.run(sesion(args, clave))
            if args.archivo:
                time.sleep(0.3)                         # deja salir lo último del bus antes de cerrar
                break
        except KeyboardInterrupt:
            print("\n👋 Listo."); break
        except websockets.ConnectionClosed as e:
            if args.archivo:
                break
            print(f"\n🔁 Sesión cerrada ({e.code}); reconectando…"); time.sleep(1)
        except (OSError, TimeoutError, websockets.WebSocketException) as e:
            if args.archivo:
                raise
            print(f"\n📡 Sin conexión con Muse ({type(e).__name__}); reintento en 5 s", flush=True); time.sleep(5)


if __name__ == "__main__":
    main()
