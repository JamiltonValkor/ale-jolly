"""Voz de salida en tiempo real con Cartesia Sonic (nube) por WebSocket.

Mismo contrato que voz_salida.Locutor (decir, ocupado, esperar, t_primer_audio, cron) más fin_turno():
- Un WebSocket abierto todo el rato (sin handshake por frase).
- Cada turno de Ale es un `context_id`: cada frase que suelta el Fragmentador va como continuación
  (`continue: true`), así la entonación sigue entre frases; fin_turno() cierra el contexto.
- El audio (PCM16 24 kHz) suena en cuanto llega cada pedazo, no al terminar la frase.

Reloj de audio (cara-viva-v1, CV-003/CV-004):
- Un hilo ALIMENTADOR lee self.audio (pedazos de Cartesia, rellenos, timestamps y marcas None) y pasa las muestras a
  un FIFO; el CALLBACK de sd.OutputStream(blocksize=240) solo copia muestras del FIFO a la tarjeta y anota a qué hora
  (outputBufferDacTime → monotónico + ALE_DESFASE_AUDIO) empezó/terminó cada pedazo. El callback nunca imprime,
  nunca publica y no usa locks.
- Cada pedazo se fecha al entrar al FIFO (sigue al anterior, o al próximo bloque si el FIFO estaba vacío) y se
  publica por adelantado: voz/volumen (RMS 20 ms cada 10 ms), voz/turno_inicio, voz/frase (rellenos y, con los
  timestamps de palabra de Cartesia, cada frase de la respuesta) y voz/turno_fin. Contrato: cuerpo/CONTRATO.md.
- "hablando" se apaga cuando la última muestra ya sonó (antes: ~76 ms antes de tiempo).
"""
import base64, bisect, collections, hashlib, json, os, queue, random, re, sys, threading, time, unicodedata, urllib.request, uuid
from pathlib import Path

import numpy as np
import sounddevice as sd
from websockets.sync.client import connect

from cuerpo import bus
from voz_salida import limpiar_para_voz

URL = "wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-11-02"
TASA = 24000
VOCES = {"cathy": "e8e5fffb-252c-436d-b842-8879b84445b6", "katie": "f786b574-daa5-4673-aa0c-cbe3e8534c02",
         "connie": "8d8ce8c9-44a4-46c4-b10f-9a927b99a853", "ella": "2a12b36c-7f9b-4c3a-9f7a-72731b15323a",
         "adriana": "f4d6bb07-f876-4464-ba70-cd48d8701890", "dayana": "2c0a6de4-a619-4428-8559-2e7c2bb93448",
         "catalina": "162e0f37-8504-474c-bb33-c606c01890dc", "ximena": "3597a26f-80ef-4bd5-8101-9699bc764917",
         "fernanda": "b4b8e2af-6139-466e-a93a-30c20d2e1fc5", "mateo": "2fc4f1ec-bfd0-46f1-8e6d-d4279eaaf838"}


# Frases cortas para tapar el tiempo en que Ale piensa. "inicio" suena apenas mandas la pregunta;
# "espera" si Ale lleva rato sin responder. Se generan una vez con Cartesia y quedan en disco.
RELLENOS = {
    "es": {
        "inicio": ["Mmm…", "Mmm, déjame ver.", "A ver…", "Ok, ya miro.", "Dale, un momento.", "Ajá, déjame pensar.",
                   "Buena pregunta.", "Listo, reviso.", "Ya te digo.", "Mmm, a ver…", "Uy, buena.", "Va, ya lo miro."],
        "espera": ["Dame un segundito…", "Ya casi lo tengo.", "Estoy revisando, ya voy.", "Un momentico más.",
                   "Sigo en eso, ya casi."],
    },
    "en": {
        "inicio": ["Hmm…", "Hmm, let me see.", "Let's see…", "Okay, checking.", "One sec.", "Ooh, good one.",
                   "Good question.", "On it.", "Let me check.", "Hmm, okay…", "Sure, one moment.", "Alright, looking."],
        "espera": ["Just a second…", "Almost there.", "Still checking, hang on.", "One more moment.",
                   "Nearly got it."],
    },
}

_EN = set("the you your is are i my what how to and of it this that do does can for with me we our sales business "
          "hi hello hey thanks please show tell".split())
_ES = set("el la los las tu tus es son yo mi que qué como cómo de y para con me nosotros nuestro ventas negocio "
          "hola gracias por favor muestra dime un una".split())


def idioma(texto: str, por_defecto: str = "es") -> str:
    """'en' o 'es' según las palabras comunes del texto (empate → por_defecto)."""
    pal = re.findall(r"[a-záéíóúñü']+", texto.lower())
    en, es = sum(w in _EN for w in pal), sum(w in _ES for w in pal)
    if re.search(r"[ñ¿¡áéíóú]", texto.lower()):
        es += 2
    return "en" if en > es else "es" if es > en else por_defecto
CACHE = Path(__file__).with_name("voces") / "rellenos"


BLOQUE = 240                                 # 10 ms por callback (blocksize=0 da llamadas de 15 muestras en el Mac)
HOP = 240                                    # voz/volumen: un nivel cada 10 ms…
VENTANA = 480                                # …con RMS en una ventana centrada de 20 ms
ESPERA_TS = 0.4                              # sin timestamps a los 0,4 s del primer audio → degradación (1 frase/turno)


def desfase_audio() -> float:
    """Segundos que se suman a outputBufferDacTime (env ALE_DESFASE_AUDIO, en ms; lo mide calibrar_latencia.py)."""
    try:
        return float(os.environ.get("ALE_DESFASE_AUDIO", "0") or 0) / 1000
    except ValueError:
        return 0.0


def niveles_rms(pcm: np.ndarray) -> list[float]:
    """Volumen 0–1 cada 10 ms (ventana centrada de 20 ms): −45 dBFS → 0, −8 dBFS → 1. (Con −15 dBFS como tope la voz de
    Cartesia saturaba: mediana 0,77 y p90 = 1 en la sesión real del 27-oct → la boca no veía las sílabas.)"""
    x = pcm.astype(np.float32)
    out = []
    for c in range(0, len(x), HOP):
        v = x[max(0, c - VENTANA // 2):c + VENTANA // 2]
        rms = float(np.sqrt(np.mean(v * v))) if len(v) else 0.0
        db = 20 * np.log10(rms / 32768) if rms > 0 else -120.0
        out.append(round(min(1.0, max(0.0, (db + 45) / 37)), 3))
    return out


def _norm(palabra: str) -> str:
    """Letras y números sin tildes ni signos: para alinear el texto de decir() con las palabras de Cartesia."""
    t = unicodedata.normalize("NFD", palabra.lower())
    return "".join(c for c in t if c.isalnum() and unicodedata.category(c) != "Mn")


class _Pedazo:
    """Audio en el FIFO. El alimentador fija t_pred al encolarlo; el callback anota t_real/t_fin_real al sonar."""
    __slots__ = ("pcm", "n", "tipo", "ctx", "k", "t_pred", "t_real", "t_fin_real")

    def __init__(self, pcm, tipo, ctx, k):
        self.pcm, self.n, self.tipo, self.ctx, self.k = pcm, len(pcm), tipo, ctx, k
        self.t_pred = self.t_real = self.t_fin_real = None

    def inicio(self):
        return self.t_real if self.t_real is not None else self.t_pred

    def fin(self):
        return self.t_fin_real if self.t_fin_real is not None else self.inicio() + self.n / TASA


class _Contexto:
    """Un turno hablado (context_id): sus frases, sus pedazos de audio y las palabras con hora que manda Cartesia."""

    def __init__(self, ctx, idioma, turno):
        self.ctx, self.idioma, self.turno = ctx, idioma, turno
        self.frases: list[list] = []        # [texto, letra_inicio, publicada]
        self.letras = 0                     # letras normalizadas de las frases registradas
        self.letras_pal = 0                 # letras normalizadas de las palabras recibidas
        self.pend: list[tuple] = []         # palabras cuyo audio aún no entra al FIFO: (letra, ini, fin, palabra)
        self.pedazos: list[_Pedazo] = []
        self.k = 0                          # muestras del contexto ya encoladas
        self.con_ts = False
        self.t_ultima = None                # hora de la última palabra con hora
        self.t_alta = None                  # cuándo entró al FIFO su primer audio

    def hora(self, s: float):
        """Hora de salida del instante `s` (segundos desde la primera muestra del contexto); None si aún no llegó."""
        k = int(round(s * TASA))
        if not self.pedazos or k >= self.k:
            return None
        i = max(0, bisect.bisect_right([p.k for p in self.pedazos], k) - 1)
        p = self.pedazos[i]
        return p.inicio() + (k - p.k) / TASA


class LocutorCartesia:
    def __init__(self, voz: str = "cathy", modelo: str = "sonic-3", clave: str | None = None):
        self.clave = clave or os.environ["CARTESIA_API_KEY"]
        self.voz, self.modelo = VOCES.get(voz.lower(), voz), modelo
        self._estado_inicial()
        self._conectar()
        threading.Thread(target=self._reproducir, daemon=True, name="voz-alimentador").start()
        threading.Thread(target=self._preparar_rellenos, daemon=True).start()

    def _estado_inicial(self):
        self.hablando = threading.Event()
        self.ultimo_fin = 0.0
        self.t_primer_audio = None
        self.cron = None
        self.ctx = None                      # contexto (turno) abierto en Cartesia
        self.ctx_abiertos: set[str] = set()  # contextos que aún no mandaron "done"
        self.audio: queue.Queue = queue.Queue()
        self.fin_audio = 0.0                 # hora (prevista) en que termina de sonar lo ya encolado
        self.lock = threading.Lock()
        self.ws = None
        self.idioma = "es"                   # idioma de la conversación (lo fija la pregunta del usuario)
        self.ctx_idioma = "es"               # idioma del turno que está sonando
        self.rellenos: dict[tuple[str, str], list[tuple[str, bytes]]] = {
            (lang, tipo): [] for lang, tipos in RELLENOS.items() for tipo in tipos}
        self.recientes: list[str] = []
        self.dicho: list[tuple[float, str]] = []   # lo que el robot dijo (para detectar eco)
        self.pendiente = False               # se dijo un relleno y falta la respuesta: no soltar "hablando"
        self.turno = None                    # id del turno de conversación (lo pone voz_hermes) → va en voz/*
        # reloj de audio
        self.desfase = desfase_audio()
        self.silencio = os.environ.get("ALE_SILENCIO", "") not in ("", "0")   # ALE_SILENCIO=1: medir sin sonar
        self.latencia_salida = None          # stream.latency (lo que PortAudio dice)
        self.dac_menos_actual = None         # outputBufferDacTime − currentTime del último callback
        self.underflows = 0                  # status.output_underflow de PortAudio: fallo real
        self.bloques_con_hueco = 0           # el FIFO se vació a mitad de bloque: pausa normal entre frases
        self.registro: collections.deque = collections.deque(maxlen=800)          # pedazos (para medir)
        self.registro_palabras: collections.deque = collections.deque(maxlen=2000)  # (palabra, t, t_fin, ctx)
        self._fifo: collections.deque = collections.deque()
        self._sonando = None                 # pedazo que el callback está copiando
        self._pos = 0
        self._n_sonado = 0                   # muestras ya entregadas a la tarjeta (solo escribe el callback)
        self._n_encolado = 0                 # muestras metidas al FIFO (solo escribe el alimentador)
        self._ancla = None                   # (hora monotónica del callback, hora DAC de su primera muestra)
        self._frames_cb = 0                  # muestras pedidas por la tarjeta desde que arrancó el stream
        self._linea = None                   # hora monotónica de la muestra 0 del stream (sin el dac − current)
        self._tarde, self._min_tarde = 0, 0.0
        self.cortes_reloj = 0                # veces que la línea se rehízo (corte real de la tarjeta)
        self._ultimo: _Pedazo | None = None
        self._ctxs: dict[str, _Contexto] = {}
        self._revisar_fin = False
        self._anuncio: _Pedazo | None = None  # primer pedazo de la respuesta: avisar "empieza a sonar"

    def _sintetizar(self, texto: str, lang: str = "es") -> bytes:
        cuerpo = {"model_id": self.modelo, "transcript": texto, "voice": {"mode": "id", "id": self.voz}, "language": lang,
                  "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": TASA}}
        req = urllib.request.Request("https://api.cartesia.ai/tts/bytes", data=json.dumps(cuerpo).encode(), method="POST",
                                     headers={"X-API-Key": self.clave, "Cartesia-Version": "2026-10-29",
                                              "Content-Type": "application/json", "User-Agent": "voz-hermes/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read()

    def _preparar_rellenos(self):
        """Carga (o genera la primera vez) el audio de cada frase de relleno con la voz actual."""
        for lang, tipos in RELLENOS.items():
            for tipo, frases in tipos.items():
                for frase in frases:
                    archivo = CACHE / f"{hashlib.sha1(f'{self.voz}|{self.modelo}|{lang}|{frase}'.encode()).hexdigest()[:16]}.pcm"
                    try:
                        if not archivo.exists():
                            CACHE.mkdir(parents=True, exist_ok=True)
                            archivo.write_bytes(self._sintetizar(frase, lang))
                        self.rellenos[(lang, tipo)].append((frase, archivo.read_bytes()))
                    except Exception as e:
                        print(f"   ⚠️ no pude preparar el relleno {frase!r}: {e}", flush=True)

    def relleno(self, tipo: str = "inicio") -> str | None:
        """Suena YA una frase corta al azar (sin repetir las últimas). Devuelve la frase o None."""
        todas = self.rellenos.get((self.idioma, tipo), [])
        opciones = [r for r in todas if r[0] not in self.recientes] or todas
        if not opciones:
            return None
        frase, pcm = random.choice(opciones)
        self.recientes = (self.recientes + [frase])[-4:]
        self.dicho = (self.dicho + [(time.monotonic(), frase)])[-20:]
        self.pendiente = True
        self.hablando.set()
        if self.cron:
            self.cron(f"💭 relleno: {frase!r}")
        self.audio.put(("relleno", pcm, frase, self.turno))
        self.audio.put(None)
        return frase

    def _conectar(self):
        self.ws = connect(URL, additional_headers={"X-API-Key": self.clave}, max_size=None, open_timeout=10)
        threading.Thread(target=self._recibir, args=(self.ws,), daemon=True).start()

    def _enviar(self, msg: dict):
        try:
            self.ws.send(json.dumps(msg))
        except Exception:                    # conexión caída (inactividad, red): se reabre y se reintenta una vez
            self._conectar()
            self.ws.send(json.dumps(msg))

    def decir(self, texto: str):
        texto = limpiar_para_voz(texto)
        if not texto:
            return
        self.dicho = (self.dicho + [(time.monotonic(), texto)])[-20:]
        with self.lock:
            if self.ctx is None:
                self.ctx = f"turno-{uuid.uuid4().hex[:12]}"
                self.ctx_abiertos.add(self.ctx)
                self.ctx_idioma = idioma(texto, self.idioma)   # Ale responde en el idioma de la pregunta
            self.hablando.set()
            if self.cron:
                self.cron(f"✂️  frase a Cartesia ({len(texto)} letras)")
            self.audio.put(("frase", self.ctx, texto, self.ctx_idioma, self.turno))   # antes de que lleguen sus timestamps
            self._enviar({"model_id": self.modelo, "transcript": texto + " ", "voice": {"mode": "id", "id": self.voz},
                          "language": self.ctx_idioma, "context_id": self.ctx, "continue": True, "max_buffer_delay_ms": 0,
                          "add_timestamps": True, "use_normalized_timestamps": False,
                          "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": TASA}})

    def fin_turno(self):
        """No viene más texto en este turno: Cartesia genera lo que quede y cierra el contexto."""
        with self.lock:
            self.pendiente = False
            if self.ctx is None:
                self.audio.put(None)         # no hubo respuesta hablada: libera "hablando"
                return
            self._enviar({"model_id": self.modelo, "transcript": "", "voice": {"mode": "id", "id": self.voz},
                          "language": self.ctx_idioma, "context_id": self.ctx, "continue": False,
                          "add_timestamps": True, "use_normalized_timestamps": False,
                          "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": TASA}})
            self.ctx = None

    def _recibir(self, ws):
        try:
            for raw in ws:
                m = json.loads(raw)
                tipo, ctx = m.get("type"), m.get("context_id")
                if tipo == "chunk" and m.get("data"):
                    self.audio.put(("voz", ctx, base64.b64decode(m["data"])))
                elif tipo == "timestamps" and m.get("word_timestamps"):
                    w = m["word_timestamps"]
                    self.audio.put(("ts", ctx, list(w.get("words", [])), list(w.get("start", [])), list(w.get("end", []))))
                elif tipo == "done":
                    self.ctx_abiertos.discard(ctx)
                    self.audio.put(("fin", ctx))   # marca: cierra el contexto y revisa si ya terminó todo
                elif tipo == "error":
                    print(f"\n   ⚠️ Cartesia: {m.get('title')} — {m.get('message')}", flush=True)
                    self.ctx_abiertos.discard(ctx)
                    self.audio.put(("fin", ctx))
        except Exception:
            pass                             # la conexión se cerró; _enviar la reabre

    # ------------------------------------------------------------------ callback (hilo de PortAudio)
    def _callback(self, outdata, frames, ti, status):
        """Solo copia muestras del FIFO y anota horas. Sin print, sin publicar, sin locks."""
        if status.output_underflow:
            self.underflows += 1
        ahora = time.monotonic()
        # Reloj por conteo de muestras. En macOS, Stream.time (currentTime/outputBufferDacTime) da saltos de 10–70 ms
        # bajo carga aunque el audio sigue continuo (medido), así que no se usa su valor absoluto: la tarjeta consume
        # TASA muestras/s exactas, el bloque k sale en  linea + k/TASA + (dac − current). `linea` = mínimo de
        # (monotónico al llamar − k/TASA): quita lo que el callback esperó el GIL. +1 µs por bloque sigue la deriva;
        # un corte (callback tardío) pierde ese bloque pero no corre la línea; solo si llega >20 ms tarde durante 2 s
        # seguidos (el stream se reinició, p. ej. cambio de dispositivo) la línea se rehace.
        k = self._frames_cb
        self._frames_cb = k + frames
        obs = ahora - k / TASA
        if self._linea is None or obs < self._linea + 1e-6:
            self._linea, self._tarde = obs, 0
        else:
            self._linea += 1e-6
            if obs - self._linea > 0.020:
                self._min_tarde = obs if self._tarde == 0 else min(self._min_tarde, obs)
                self._tarde += 1
                if self._tarde >= 200:
                    self._linea, self._tarde = self._min_tarde, 0
                    self.cortes_reloj += 1
            else:
                self._tarde = 0
        self.dac_menos_actual = ti.outputBufferDacTime - ti.currentTime
        dac = self._linea + k / TASA + self.dac_menos_actual + self.desfase
        out = outdata[:, 0]
        n = 0
        while n < frames:
            p = self._sonando
            if p is None:
                if not self._fifo:
                    break
                p = self._sonando = self._fifo.popleft()
                self._pos = 0
            if self._pos == 0:
                p.t_real = dac + n / TASA
            tomar = min(frames - n, p.n - self._pos)
            out[n:n + tomar] = p.pcm[self._pos:self._pos + tomar]
            self._pos += tomar
            n += tomar
            if self._pos >= p.n:
                p.t_fin_real = dac + n / TASA
                self._sonando = None
        if n < frames:
            out[n:] = 0
            if n:
                self.bloques_con_hueco += 1
        if self.silencio:
            out[:] = 0                       # pruebas sin sonido: el reloj corre igual, la tarjeta recibe ceros
        self._n_sonado += n
        self._ancla = (ahora, dac)

    # ------------------------------------------------------------------ alimentador (hilo propio)
    def _reproducir(self):
        # El callback de PortAudio corre en un hilo de tiempo real pero necesita el GIL: si un hilo normal lo tiene y
        # el sistema lo saca de la CPU, la tarjeta se queda sin muestras (medido con el Mac cargado: hasta 200 ms).
        # Turnos de GIL más cortos (1 ms en vez de 5) bajaron lo perdido de ~1,1 s a ~0,1 s en 22 s.
        sys.setswitchinterval(min(sys.getswitchinterval(), 0.001))
        with sd.OutputStream(samplerate=TASA, channels=1, dtype="int16", blocksize=BLOQUE, latency="low",
                             callback=self._callback) as salida:
            self.latencia_salida = salida.latency
            while True:
                # sin tareas con hora pendientes no hace falta despertar cada 5 ms (menos peleas por el GIL)
                ocupado = self._anuncio is not None or self._revisar_fin or self._ctxs
                self._paso(0.005 if ocupado else 0.05)

    def _paso(self, espera: float = 0.005):
        """Una vuelta del alimentador: procesa lo que llegó (si llegó) y las tareas con hora."""
        try:
            item = self.audio.get(timeout=espera)
        except queue.Empty:
            pass
        else:
            self._procesar(item)
        self._tareas()

    def _hora_siguiente(self) -> float:
        """Hora a la que sonará la próxima muestra que entre al FIFO."""
        u = self._ultimo
        if u is not None and self._n_encolado > self._n_sonado:      # aún suena algo: va pegada a lo anterior
            return u.fin()
        if self._ancla is None:                                      # el stream aún no arrancó
            return time.monotonic() + (self.latencia_salida or 0.02) + self.desfase
        t_cb, dac = self._ancla                                      # FIFO vacío: entra en el próximo bloque
        bd = BLOQUE / TASA
        return dac + (int((time.monotonic() - t_cb) / bd) + 1) * bd

    def _encolar(self, pcm: bytes, tipo: str, c: "_Contexto | None", turno=None) -> _Pedazo:
        p = _Pedazo(np.frombuffer(pcm, dtype=np.int16), tipo, c.ctx if c else None, c.k if c else 0)
        p.t_pred = self._hora_siguiente()
        if c is not None:
            c.k += p.n
            c.pedazos.append(p)
        self._n_encolado += p.n
        self._ultimo = p
        self.fin_audio = p.t_pred + p.n / TASA
        self._fifo.append(p)
        self.registro.append(p)
        bus.publicar("voz/volumen", t=p.t_pred, t0=p.t_pred, dt=HOP / TASA, niveles=niveles_rms(p.pcm),
                     es_relleno=tipo == "relleno", turno=c.turno if c else turno, contexto=p.ctx)
        return p

    def _contexto(self, ctx: str) -> _Contexto:
        if ctx not in self._ctxs:
            self._ctxs[ctx] = _Contexto(ctx, self.ctx_idioma, self.turno)
        return self._ctxs[ctx]

    def _publicar_frase(self, c: _Contexto, j: int, t: float, fuente: str):
        for i in range(j + 1):                  # en orden: si una frase quedó sin palabras, sale con la siguiente
            f = c.frases[i]
            if not f[2]:
                f[2] = True
                bus.publicar("voz/frase", t=t, texto=f[0], es_relleno=False, idioma=c.idioma, turno=c.turno,
                             contexto=c.ctx, fuente=fuente)

    def _resolver(self, c: _Contexto):
        """Pone hora a las palabras cuyo audio ya entró al FIFO y publica voz/frase al llegar la 1.ª de cada frase."""
        while c.pend:
            letra, ini, fin, palabra = c.pend[0]
            t = c.hora(ini)
            if t is None:
                return
            c.pend.pop(0)
            self.registro_palabras.append((palabra, t, t + max(0.0, fin - ini), c.ctx))
            c.t_ultima = t
            if c.frases:
                j = max(0, bisect.bisect_right([f[1] for f in c.frases], letra) - 1)
                if not c.frases[j][2]:
                    self._publicar_frase(c, j, t, "timestamps")

    def _procesar(self, item):
        if item is None:
            self._revisar_fin = True
            return
        tipo = item[0]
        if tipo == "relleno":            # ("relleno", pcm[, frase, turno]) — no cuenta como "empezó la respuesta"
            frase = item[2] if len(item) > 2 else None
            turno = item[3] if len(item) > 3 else self.turno
            p = self._encolar(item[1], "relleno", None, turno)
            if frase:
                bus.publicar("voz/frase", t=p.t_pred, texto=frase, es_relleno=True, idioma=self.idioma, turno=turno,
                             contexto=None, fuente="relleno")
        elif tipo == "frase":            # ("frase", ctx, texto, idioma, turno): lo que decir() mandó a Cartesia
            _, ctx, texto, lang, turno = item
            c = self._contexto(ctx)
            c.idioma, c.turno = lang, turno
            c.frases.append([texto, c.letras, False])
            c.letras += len(_norm(texto))
        elif tipo == "voz":              # ("voz", ctx, pcm): audio de la respuesta
            c = self._contexto(item[1])
            primero = not c.pedazos
            p = self._encolar(item[2], "voz", c)
            if primero:
                bus.publicar("voz/turno_inicio", t=p.t_pred, turno=c.turno, contexto=c.ctx, idioma=c.idioma)
                if self.t_primer_audio is None:
                    self.t_primer_audio = p.t_pred    # se corrige a la hora real cuando el callback lo toma
                    self._anuncio = p
            if primero:
                c.t_alta = time.monotonic()
            self._resolver(c)
        elif tipo == "ts":               # ("ts", ctx, palabras, inicios, fines) en s desde el 1.er audio del contexto
            _, ctx, palabras, inicios, fines = item
            c = self._contexto(ctx)
            c.con_ts = True
            for w, ini, fin in zip(palabras, inicios, fines):
                c.pend.append((c.letras_pal, float(ini), float(fin), w))
                c.letras_pal += len(_norm(w))
            self._resolver(c)
        elif tipo == "fin":              # ("fin", ctx): Cartesia cerró el contexto (done o error)
            c = self._ctxs.pop(item[1], None)
            if c is not None and c.pedazos:
                self._resolver(c)
                if not c.con_ts:
                    self._sin_timestamps(c)
                elif any(not f[2] for f in c.frases):   # frases sin palabra propia (texto ≠ palabras de Cartesia)
                    self._publicar_frase(c, len(c.frases) - 1, c.t_ultima or c.pedazos[-1].fin(), "fin_turno")
                bus.publicar("voz/turno_fin", t=c.pedazos[-1].fin(), turno=c.turno, contexto=c.ctx,
                             con_timestamps=c.con_ts)
            self._revisar_fin = True

    def _sin_timestamps(self, c: _Contexto):
        """Degradación (CV-004): sin timestamps, una sola voz/frase por turno con la hora de voz/turno_inicio."""
        if c.frases and not c.frases[0][2]:
            c.frases[0][2] = True
            bus.publicar("voz/frase", t=c.pedazos[0].inicio(), texto=c.frases[0][0], es_relleno=False, idioma=c.idioma,
                         turno=c.turno, contexto=c.ctx, fuente="sin_timestamps")

    def _tareas(self):
        ahora = time.monotonic()
        for c in self._ctxs.values():    # el timestamp de la 1.ª palabra llega ~0,1 s después que su audio
            if c.pedazos and not c.con_ts and ahora - c.t_alta > ESPERA_TS:
                self._sin_timestamps(c)
        a = self._anuncio
        if a is not None and a.t_real is not None:
            if self.t_primer_audio == a.t_pred:
                self.t_primer_audio = a.t_real
            if ahora >= a.t_real:
                self._anuncio = None
                if self.cron:
                    self.cron("🔊 empieza a sonar (Cartesia)")
        if self._revisar_fin:
            if self.ctx_abiertos or self.ctx is not None or self.pendiente or not self.audio.empty():
                self._revisar_fin = False    # viene más: una marca posterior lo vuelve a revisar
            elif self._n_sonado >= self._n_encolado and (self._ultimo is None or self._ultimo.fin() <= ahora):
                # la última muestra ya sonó (hora DAC + desfase), no solo salió de la cola
                self._revisar_fin = False
                self.ultimo_fin = time.monotonic()
                self.hablando.clear()
                if self.cron:
                    self.cron("🔇 terminó de hablar")

    def ocupado(self, cola_s: float = 0.6) -> bool:
        """Verdadero mientras habla y un momento después (para no escucharse a sí mismo)."""
        return self.hablando.is_set() or (time.monotonic() - self.ultimo_fin) < cola_s

    def esperar(self):
        while self.hablando.is_set():
            time.sleep(0.05)

    def estadisticas(self) -> dict:
        """Para medir: latencias de PortAudio, underflows y error de la hora prevista frente a la real."""
        err = [abs(p.t_real - p.t_pred) for p in self.registro if p.t_real is not None]
        return {"latencia_salida_s": self.latencia_salida, "dac_menos_actual_s": self.dac_menos_actual,
                "desfase_s": self.desfase, "underflows": self.underflows, "bloques_con_hueco": self.bloques_con_hueco, "cortes_reloj": self.cortes_reloj,
                "error_prevision_max_ms": round(1000 * max(err), 2) if err else None,
                "error_prevision_med_ms": round(1000 * float(np.median(err)), 2) if err else None}


if __name__ == "__main__":                   # prueba: .venv/bin/python voz_cartesia.py "Hola, soy Jolly."
    import sys
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
    bus.publicar("_arranque")                # abre el bus ya: un grabador conectado no pierde el inicio del turno
    loc = LocutorCartesia(sys.argv[2] if len(sys.argv) > 2 else "catalina")
    t0 = time.monotonic()
    for frase in (sys.argv[1] if len(sys.argv) > 1 else "Hola, soy Jolly. Tu negocio va muy bien esta semana.").split(". "):
        loc.decir(frase)
    loc.fin_turno()
    time.sleep(0.2); loc.esperar()
    print(f"primer audio a los {(loc.t_primer_audio or t0) - t0:.2f} s · total {time.monotonic() - t0:.2f} s")
    if os.environ.get("ALE_VOZ_ESTADISTICAS"):
        print(json.dumps(loc.estadisticas()))
    time.sleep(0.3)                          # deja salir lo último del bus
