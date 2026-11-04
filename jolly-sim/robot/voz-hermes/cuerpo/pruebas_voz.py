"""Pruebas de la voz con hora (CV-003, CV-004) y de los eventos de oído/Ale (CV-002).
Cada prueba dice qué regla de negocio garantiza.   .venv/bin/python -m pytest cuerpo/pruebas_voz.py -q

Sin red ni sonido: el locutor corre con un reloj falso y un callback simulado (mismo código que en la tarjeta);
voz_hermes corre contra un Muse falso (eventos guionados) y contra pruebas/ale_falso.py (HTTP/SSE de verdad).
"""
import asyncio, contextlib, json, os, re, socket, subprocess, sys, time, types, wave

import numpy as np
import pytest

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, AQUI)

import voz_cartesia as vc          # noqa: E402
import voz_hermes as vh            # noqa: E402
from cuerpo import bus             # noqa: E402

BD = vc.BLOQUE / vc.TASA           # 10 ms


# ---------------------------------------------------------------------------------------------------- locutor simulado
class Reloj:
    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.t += s


class Sim:
    """Locutor sin red ni tarjeta: el callback real de voz_cartesia recibe bloques con horas de un reloj falso."""
    LAT = 0.009                    # outputBufferDacTime − currentTime medido en el Mac

    def __init__(self, monkeypatch):
        self.reloj = Reloj()
        monkeypatch.setattr(vc, "time", types.SimpleNamespace(monotonic=self.reloj.monotonic, sleep=self.reloj.sleep))
        loc = vc.LocutorCartesia.__new__(vc.LocutorCartesia)
        loc._estado_inicial()
        loc.desfase = 0.0
        loc.latencia_salida = 0.043
        self.loc = loc
        self.cola = bus.escuchar_local()
        self.sonado = []           # (hora DAC de la muestra 0 del bloque, muestras emitidas)
        self.underflow = False
        self.correr(0.03)          # el stream ya está corriendo (en voz_cartesia arranca al crear el locutor)

    def bloque(self, retraso=0.0):
        """Un callback. `self.salto` desplaza el reloj de PortAudio (en macOS salta bajo carga); `retraso` = lo que
        el callback esperó el GIL (time.monotonic() se lee tarde)."""
        out = np.zeros((vc.BLOQUE, 1), np.int16)
        pa = self.reloj.t + getattr(self, "salto", 0.0)
        ti = types.SimpleNamespace(currentTime=pa, outputBufferDacTime=pa + self.LAT)
        self.reloj.t += retraso
        self.loc._callback(out, vc.BLOQUE, ti, types.SimpleNamespace(output_underflow=self.underflow))
        self.reloj.t -= retraso
        self.sonado.append((self.reloj.t + self.LAT, out[:, 0].copy()))

    def alimentar(self):
        while not self.loc.audio.empty():
            self.loc._paso(espera=0)
        self.loc._paso(espera=0)

    def correr(self, s):
        for _ in range(int(round(s / BD))):
            self.alimentar()
            self.bloque()
            self.reloj.t += BD
            self.alimentar()

    def msgs(self, tema=None):
        out = []
        while not self.cola.empty():
            out.append(self.cola.get())
        self._viejos = getattr(self, "_viejos", []) + out
        return [m for m in self._viejos if tema is None or m["tema"] == tema]


def tono(seg, amp=8000, f=220):
    n = int(seg * vc.TASA)
    return (amp * np.sin(2 * np.pi * f * np.arange(n) / vc.TASA)).astype(np.int16).tobytes()


def silencio(seg):
    return bytes(2 * int(seg * vc.TASA))


def inicio_real(sim):
    """Hora DAC de la primera muestra no nula emitida."""
    for t, blq in sim.sonado:
        nz = np.nonzero(blq)[0]
        if len(nz):
            return t + nz[0] / vc.TASA
    return None


def fin_real(sim):
    ult = None
    for t, blq in sim.sonado:
        nz = np.nonzero(blq)[0]
        if len(nz):
            ult = t + (nz[-1] + 1) / vc.TASA
    return ult


# ---------------------------------------------------------------------------------------------------- CV-003
def test_hablando_sigue_hasta_que_suena_la_ultima_muestra_half_duplex(monkeypatch):
    """Regla (half-duplex): Ale no se escucha a sí misma — 'hablando' sigue mientras su voz suena y se apaga
    después de la última muestra, no al sacarla de la cola (antes se apagaba ~76 ms antes de tiempo)."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.hablando.set()
    loc.ctx_abiertos.add("c1")
    loc.audio.put(("frase", "c1", "Hola, soy Ale.", "es", "t-1"))
    loc.audio.put(("voz", "c1", tono(0.3)))
    loc.ctx_abiertos.discard("c1")
    loc.audio.put(("fin", "c1"))
    apagado = None
    for _ in range(60):
        s.correr(BD)
        if apagado is None and not loc.hablando.is_set():
            apagado = s.reloj.t
    fin = fin_real(s)
    assert apagado is not None, "nunca terminó de hablar"
    assert apagado >= fin, f"se apagó {1000 * (fin - apagado):.0f} ms ANTES de que dejara de sonar"
    assert apagado - fin <= 2 * BD, "tarda demasiado en soltar 'hablando'"
    assert loc.ultimo_fin >= fin
    assert loc.ocupado(cola_s=0.8)            # la cola del half-duplex se cuenta desde el fin real
    s.reloj.t = fin + 0.81
    assert not loc.ocupado(cola_s=0.8)


def test_relleno_suena_por_el_mismo_fifo_y_la_respuesta_espera_su_turno(monkeypatch):
    """Regla: el 'mmm…' tapa el silencio y la respuesta suena DESPUÉS sin pisarlo; el relleno se publica como
    voz/frase es_relleno con la hora en que suena, y t_primer_audio es la hora en que suena la RESPUESTA."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.turno = "t-7"
    loc.pendiente = True
    loc.hablando.set()
    loc.audio.put(("relleno", tono(0.25, f=330), "Mmm…", "t-7"))
    loc.audio.put(None)
    s.correr(0.05)
    loc.ctx_abiertos.add("c2")
    loc.audio.put(("frase", "c2", "Listo.", "es", "t-7"))
    loc.audio.put(("voz", "c2", tono(0.2)))
    s.correr(0.6)
    rel = [m for m in s.msgs("voz/frase") if m["es_relleno"]]
    assert len(rel) == 1 and rel[0]["texto"] == "Mmm…" and rel[0]["turno"] == "t-7"
    assert abs(rel[0]["t"] - inicio_real(s)) <= BD
    ini = s.msgs("voz/turno_inicio")[0]["t"]
    assert ini >= rel[0]["t"] + 0.25 - 1e-6, "la respuesta se montó sobre el relleno"
    assert abs(loc.t_primer_audio - ini) < 1e-6
    assert loc.hablando.is_set(), "con la respuesta pendiente no se suelta 'hablando'"


def test_volumen_sigue_lo_que_suena_y_es_cero_en_silencio(monkeypatch):
    """Regla (boca kawaii D3): la boca se mueve con la voz que SUENA y queda quieta sin voz — voz/volumen
    (publicado por adelantado) coincide con el audio que el callback entregó de verdad, también tras un hueco."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c3")
    loc.audio.put(("frase", "c3", "Uno. Dos.", "es", "t"))
    loc.audio.put(("voz", "c3", tono(0.3) + silencio(0.2) + tono(0.15, 3000)))
    s.correr(0.9)                                       # el FIFO se vacía: hueco real entre pedazos
    loc.audio.put(("voz", "c3", silencio(0.1) + tono(0.25, 12000, 180)))
    s.correr(0.6)
    vols = s.msgs("voz/volumen")
    serie = [(v["t0"] + i * v["dt"], x) for v in vols for i, x in enumerate(v["niveles"])]
    sonado = np.concatenate([b for _, b in s.sonado])
    t_ini = s.sonado[0][0]
    pub, real = [], []
    for t, x in serie:                                  # nivel publicado vs. nivel de lo que sonó a esa hora
        c = int(round((t - t_ini) * vc.TASA))
        if 240 <= c < len(sonado) - 240:
            pub.append(x)
            real.append(vc.niveles_rms(sonado[c - 240:c + 240])[1])
    assert len(pub) > 80
    r = np.corrcoef(pub, real)[0, 1]
    assert r > 0.9, f"correlación {r:.3f}"
    en_silencio = [x for x, y in zip(pub, real) if y == 0]
    assert en_silencio and max(en_silencio) <= 0.02


def test_callback_no_publica_no_imprime(monkeypatch):
    """Regla técnica del contrato: nunca se publica ni se imprime desde el callback de audio (cortes de voz)."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c4")
    loc.audio.put(("voz", "c4", tono(0.1)))
    s.alimentar()
    llamado = []
    monkeypatch.setattr(bus, "publicar", lambda *a, **k: llamado.append(a))
    monkeypatch.setattr("builtins.print", lambda *a, **k: llamado.append(a))
    for _ in range(15):
        s.bloque()
        s.reloj.t += BD
    assert not llamado
    assert inicio_real(s) is not None


def test_underflow_de_portaudio_se_cuenta_aparte_del_fifo_vacio(monkeypatch):
    """Regla de medición: una pausa normal entre frases (FIFO vacío) no se confunde con un corte real (underflow)."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c5")
    loc.audio.put(("voz", "c5", tono(0.105)))
    s.correr(0.3)
    assert loc.underflows == 0 and loc.bloques_con_hueco == 1
    s.underflow = True
    s.correr(BD)
    assert loc.underflows == 1


# ---------------------------------------------------------------------------------------------------- CV-004
def test_cada_frase_sale_a_la_hora_de_su_primera_palabra(monkeypatch):
    """Regla (D7): la emoción cambia justo en la frase que la justifica — con varias frases en un mismo context_id,
    voz/frase sale por frase con hora = inicio real del contexto + start de su 1.ª palabra (aunque el timestamp llegue
    antes o después que su audio, y aunque haya un hueco de audio en medio)."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c6")
    for f in ("Hola, soy Ale.", "Tus ventas subieron 3 pedidos.", "¡Qué alegría!"):
        loc.audio.put(("frase", "c6", f, "es", "t-9"))
    loc.audio.put(("voz", "c6", silencio(0.05) + tono(1.0)))
    s.correr(0.1)                                       # el timestamp de la 1.ª palabra llega después que su audio
    loc.audio.put(("ts", "c6", ["Hola,", "soy", "Ale."], [0.05, 0.45, 0.7], [0.4, 0.68, 1.0]))
    loc.audio.put(("ts", "c6", ["Tus", "ventas", "subieron", "3", "pedidos.", "¡Qué"],
                   [1.10, 1.3, 1.6, 1.9, 2.1, 2.62], [1.3, 1.6, 1.9, 2.1, 2.5, 2.8]))   # antes que su audio
    s.correr(1.5)                                       # se acaba el audio: hueco
    loc.audio.put(("voz", "c6", tono(1.0) + tono(0.6, 4000)))
    loc.audio.put(("ts", "c6", ["alegría!"], [2.8], [3.2]))
    loc.ctx_abiertos.discard("c6")
    loc.audio.put(("fin", "c6"))
    s.correr(2.0)
    frases = s.msgs("voz/frase")
    assert [f["texto"] for f in frases] == ["Hola, soy Ale.", "Tus ventas subieron 3 pedidos.", "¡Qué alegría!"]
    assert all(f["fuente"] == "timestamps" and f["turno"] == "t-9" and not f["es_relleno"] for f in frases)
    ini = inicio_real(s) - 0.05                         # 1.ª muestra del contexto (empieza con 50 ms de silencio)
    t0_2 = s.msgs("voz/volumen")[1]["t0"]               # 2.º pedazo: suena tras el hueco
    esperado = [ini + 0.05, t0_2 + (1.10 - 1.05), t0_2 + (2.62 - 1.05)]
    for f, e in zip(frases, esperado):
        assert abs(f["t"] - e) <= BD, f"{f['texto']}: {1000 * (f['t'] - e):.0f} ms"
    assert t0_2 > ini + 1.05 + 0.3, "el hueco no se reflejó en la hora"
    fin = s.msgs("voz/turno_fin")[0]
    assert abs(fin["t"] - fin_real(s)) <= BD and fin["con_timestamps"]


def test_sin_timestamps_una_sola_frase_por_turno_a_la_hora_del_inicio(monkeypatch):
    """Regla de degradación (CV-004): si Cartesia no manda timestamps, voz/frase sale una vez por turno con la hora de
    voz/turno_inicio (el director usa la emoción de la 1.ª frase) y nunca inventa horas para las demás."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c7")
    loc.audio.put(("frase", "c7", "Uy, hay un problema.", "es", "t"))
    loc.audio.put(("frase", "c7", "Ya lo arreglo.", "es", "t"))
    loc.audio.put(("voz", "c7", tono(1.2)))
    s.correr(0.6)
    frases = s.msgs("voz/frase")
    assert len(frases) == 1 and frases[0]["fuente"] == "sin_timestamps"
    assert frases[0]["texto"] == "Uy, hay un problema."
    assert frases[0]["t"] == s.msgs("voz/turno_inicio")[0]["t"]
    loc.ctx_abiertos.discard("c7")
    loc.audio.put(("fin", "c7"))
    s.correr(1.0)
    assert len(s.msgs("voz/frase")) == 1


# ---------------------------------------------------------------------------------------------------- CV-002
PAL = ["ale", "muse", "mius", "miuz", "hermes"]


@pytest.mark.parametrize("texto,si", [("Ale", True), ("Ale,", True), ("ale, en tres", True), ("Oye Ale", True),
                                      ("Hola, Muse,", True), ("¿Hermes?", True), ("Alé", True),
                                      ("Alejandra me dijo", False), ("alegre", False), ("Hola", False),
                                      ("la tele", False), ("", False)])
def test_empieza_con_palabra_en_parciales(texto, si):
    """Regla D11 (reacción a 'Ale' < 100 ms): el primer parcial 'Ale' ya cuenta (extraer_instruccion da None ahí),
    pero 'Alejandra' o 'alegre' no."""
    assert vh.empieza_con_palabra(texto, PAL) is si
    if texto in ("Ale", "Ale,"):
        assert vh.extraer_instruccion(texto, PAL) is None     # por eso hace falta la función nueva


JOLLY = [vh.normalizar(p) for p in vh.NOMBRE_ROBOT]


@pytest.mark.parametrize("texto,instr", [
    ("Hey Jolly, traje nueva mercancía", "traje nueva mercancía"),
    ("Hola Jolly, traje mercancía", "traje mercancía"),
    ("Oye, Jolly, ¿cómo van mis ventas?", "cómo van mis ventas?"),
    ("Traje nueva mercancía, Jolly.", "Traje nueva mercancía"),
    ("Mira Jolly traje cajas", "Mira traje cajas"),
    ("Buenos días, oye Jolly, cuenta esto", "Buenos días cuenta esto"),
    ("Hey Jolly", None), ("Jolly.", None), ("Oye, Yoli", None),
    ("front center.", None), ("I love jelly beans", None), ("Holly dijo que sí", "dijo que sí"),
])
def test_nombre_en_cualquier_parte_de_la_frase(texto, instr):
    """Owner 3-nov: la activación no depende de decir el nombre al inicio; las formas que son palabras comunes
    ("jelly", "holly") solo cuentan al inicio."""
    assert vh.instruccion_con_nombre(texto, JOLLY) == instr


@pytest.mark.parametrize("texto,si", [("Hey Jolly", True), ("Jolly.", True), ("traje cajas, Jolly", True),
                                      ("front center.", False), ("I love jelly beans", False)])
def test_solo_el_nombre_abre_la_escucha(texto, si):
    """Solo "Hey Jolly" (sin instrucción) abre la ventana de ESPERA_NOMBRE_S; frases sin nombre no."""
    assert bool(vh.nombre_en_frase(texto, JOLLY)) is si


def _puerto_libre():
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


@contextlib.contextmanager
def ale_falso(*extra):
    puerto = _puerto_libre()
    p = subprocess.Popen([sys.executable, os.path.join(AQUI, "pruebas", "ale_falso.py"), str(puerto), *extra],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", puerto), 0.1):
            break
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{puerto}"
    finally:
        p.terminate(); p.wait(3)


class MuseFalso:
    """WebSocket de Muse con eventos guionados [(espera_s, evento)]."""

    def __init__(self, guion):
        self.guion = guion

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def send(self, b):
        pass

    async def recv(self):
        return json.dumps({"sessionId": "falsa"})

    def __aiter__(self):
        return self._eventos()

    async def _eventos(self):
        for espera, ev in self.guion:
            await asyncio.sleep(espera)
            yield json.dumps(ev)


class LocutorFalso:
    def __init__(self, ocupado=False, dicho=()):
        self._oc, self.dicho = ocupado, [(time.monotonic(), d) for d in dicho]

    def ocupado(self, cola_s=0.6):
        return self._oc

    def esperar(self):
        pass


def frase_muse(texto, turno=0, parciales=None):
    pals = texto.split()
    parciales = parciales or [" ".join(pals[:i]) for i in range(1, len(pals) + 1)]
    return ([(0.01, {"type": "speechStart", "turnId": turno})]
            + [(0.02, {"type": "transcript", "transcript": p, "final": False}) for p in parciales]
            + [(0.02, {"type": "speechEnd", "audioProcessedMs": 1000, "turnId": turno}),
               (0.0, {"type": "speechComplete", "audioProcessedMs": 1000, "turnId": turno, "transcript": texto})])


def correr_sesion(monkeypatch, tmp_path, guion, hermes=None, locutor=None):
    wav = tmp_path / "corto.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(vh.TASA); w.writeframes(bytes(2 * 2400))
    monkeypatch.setattr(vh, "SALIDA", tmp_path / "instrucciones.jsonl")
    monkeypatch.setattr(vh.websockets, "connect", lambda *a, **k: MuseFalso(guion))
    async def fuente_corta(cola, ruta):         # mismo papel que fuente_archivo, sin 2,5 s de silencio al final
        await cola.put(bytes(2 * 1920)); await asyncio.sleep(0.6); await cola.put(None)
    monkeypatch.setattr(vh, "fuente_archivo", fuente_corta)
    args = types.SimpleNamespace(sin_palabra=False, palabra=PAL, keywords=[], archivo=str(wav), locutor=locutor,
                                 webhook=None, cliente_hermes=hermes, ventana=20)
    q = bus.escuchar_local()
    asyncio.run(vh.sesion(args, "x"))
    time.sleep(0.1)
    out = []
    while not q.empty():
        out.append(q.get())
    return [m for m in out if m["tema"] in ("oido/evento", "ale/evento")]


def tipos(msgs):
    return [m["tipo"] for m in msgs if m["tipo"] != "parcial"]


def test_orden_de_eventos_de_una_pregunta_y_todos_llevan_turno(monkeypatch, tmp_path):
    """Regla del director: habla_inicio → nombre_detectado → habla_fin → aceptada → pregunta → token → fin, todo con
    el mismo turno, y nombre_detectado ANTES de habla_fin (la cara reacciona al oír 'Ale', no al final)."""
    with ale_falso() as url:
        m = correr_sesion(monkeypatch, tmp_path, frase_muse("Ale, cómo van mis ventas"), vh.AleHermes(url, "tok"))
    t = tipos(m)
    assert t == ["habla_inicio", "nombre_detectado", "habla_fin", "aceptada", "pregunta", "herramienta_inicio",
                 "herramienta_fin", "primer_token", "fin", "ventana"], t
    assert len({x["turno"] for x in m}) == 1 and m[0]["turno"]
    assert [x for x in m if x["tipo"] == "nombre_detectado"][0]["texto"] == "Ale,"
    assert [x for x in m if x["tipo"] == "herramienta_inicio"][0]["nombre"] == "saleads_get_account_overview"
    v = [x for x in m if x["tipo"] == "ventana"][0]
    assert v["abierta_hasta"] > v["t"] + 19


@pytest.mark.parametrize("caso,motivo", [("eco", "eco"), ("ocupado", "ocupado"), ("sin_nombre", "sin_nombre")])
def test_nombre_detectado_se_cancela_si_la_frase_no_se_acepta(monkeypatch, tmp_path, caso, motivo):
    """Regla C8: 'Ale' en un parcial es tentativo; si la frase termina como eco, llega mientras Ale habla o el final ya
    no empieza con la palabra ('Ale…' → 'Alejandra'), se publica nombre_cancelado y nunca 'pregunta'."""
    if caso == "eco":
        loc, texto, parc = LocutorFalso(dicho=["Hola, soy Ale, tu asistente de ventas"]), "Ale tu asistente de ventas", None
    elif caso == "ocupado":
        loc, texto, parc = LocutorFalso(), "Ale, para", None
    else:
        loc, texto, parc = LocutorFalso(), "Alejandra vino ayer", ["Ale", "Ale jandra", "Alejandra vino ayer"]
    guion = frase_muse(texto, parciales=parc)
    if caso == "ocupado":                    # Ale empieza a hablar entre el parcial y el texto final
        guion.insert(-1, (0.0, {"type": "_ocupar"}))
        orig = MuseFalso._eventos

        async def _ev(self):
            async for x in orig(self):
                if json.loads(x)["type"] == "_ocupar":
                    loc._oc = True
                    continue
                yield x
        monkeypatch.setattr(MuseFalso, "_eventos", _ev)
    m = correr_sesion(monkeypatch, tmp_path, guion, None, loc)
    t = tipos(m)
    assert t == ["habla_inicio", "nombre_detectado", "habla_fin", "ignorada", "nombre_cancelado"], t
    assert m[-1]["motivo"] == motivo and m[-2]["motivo"] == motivo
    assert "pregunta" not in t and "aceptada" not in t


def test_reintento_sin_modo_voz_publica_una_sola_pregunta(monkeypatch, tmp_path):
    """Regla C2: con el reintento de modo_voz (400) el director recibe UNA pregunta y UN fin (no piensa dos veces)."""
    with ale_falso("--sin-modo-voz") as url:
        cli = vh.AleHermes(url, "tok")
        m = correr_sesion(monkeypatch, tmp_path, frase_muse("Ale, hola"), cli)
    t = tipos(m)
    assert t.count("pregunta") == 1 and t.count("fin") == 1 and "primer_token" in t, t
    assert cli.modo_voz is False


@pytest.mark.parametrize("modo", ["http", "red"])
def test_fallo_http_o_de_red_publica_error_y_fin(monkeypatch, tmp_path, modo):
    """Regla C2 ('error → problema'): un 5xx o el port-forward caído publican ale/evento error y fin; el director
    nunca se queda en 'pensando' para siempre."""
    if modo == "http":
        with ale_falso("--falla", "503") as url:
            m = correr_sesion(monkeypatch, tmp_path, frase_muse("Ale, hola"), vh.AleHermes(url, "tok"))
    else:
        m = correr_sesion(monkeypatch, tmp_path, frase_muse("Ale, hola"),
                          vh.AleHermes(f"http://127.0.0.1:{_puerto_libre()}", "tok"))
    t = tipos(m)
    err = [x for x in m if x["tipo"] == "error"]
    assert len(err) == 1 and err[0]["origen"] == modo, err
    assert t.index("error") < t.index("fin") and t.count("fin") == 1
    if modo == "http":
        assert err[0]["motivo"].startswith("503")


def test_la_terminal_se_ve_igual_con_y_sin_bus(monkeypatch, tmp_path, capsys):
    """Regla CV-002: publicar en el bus no cambia nada de lo que el usuario ve en la terminal."""
    def correr():
        with ale_falso() as url:
            correr_sesion(monkeypatch, tmp_path, frase_muse("Ale, cómo van mis ventas"), vh.AleHermes(url, "tok"))
        return re.sub(r"\d+\.\d s", "N s", capsys.readouterr().out)
    con_bus = correr()
    monkeypatch.setattr(bus, "publicar", lambda *a, **k: None)      # como hoy: sin bus
    sin_bus = correr()
    assert con_bus == sin_bus and "✅ INSTRUCCIÓN" in con_bus


def test_hora_de_salida_no_se_mueve_con_saltos_del_reloj_de_portaudio_ni_con_el_gil(monkeypatch):
    """Regla (sincronía boca/emoción): la hora publicada es la hora en que la muestra suena. En el Mac, Stream.time
    salta 10–70 ms bajo carga y el callback a veces espera el GIL; nada de eso puede correr las horas."""
    s = Sim(monkeypatch)
    loc = s.loc
    loc.ctx_abiertos.add("c8")
    loc.audio.put(("frase", "c8", "Hola.", "es", "t"))
    loc.audio.put(("voz", "c8", tono(0.2)))
    loc.audio.put(("voz", "c8", tono(0.2, 3000)))
    loc.audio.put(("voz", "c8", tono(0.2, 9000)))
    for i in range(70):
        s.alimentar()
        if i in (5, 25):
            s.salto = getattr(s, "salto", 0.0) + 0.043          # Stream.time da un salto hacia adelante
        s.bloque(retraso=0.030 if i in (8, 20, 40, 41) else 0.0)
        s.reloj.t += BD
    segs = [p for p in loc.registro if p.tipo == "voz"]
    t_ini = inicio_real(s)
    for j, p in enumerate(segs):
        assert abs(p.t_real - (t_ini + j * 0.2)) < 1e-3, f"pedazo {j}: {1000 * (p.t_real - t_ini - j * 0.2):.1f} ms"
        assert abs(p.t_real - p.t_pred) < 1e-3
    assert abs(segs[-1].t_fin_real - fin_real(s)) < 1e-3


def test_ruido_pegado_al_nombre_es_solo_el_nombre():
    for frase in ["la hey Jolly", "El, Jolly", "a Jolly"]:
        assert vh.instruccion_con_nombre(frase, JOLLY) is None, frase
    assert vh.instruccion_con_nombre("No, Jolly.", JOLLY) == "No"
    assert vh.instruccion_con_nombre("Sí Jolly", JOLLY) == "Sí"
