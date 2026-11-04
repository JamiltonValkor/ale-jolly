"""Pruebas de los avisos de Jolly (IVB-012). Cada prueba dice qué regla garantiza.
Sin red ni sonido: Muse y el locutor son falsos, la sesión, el candado y los hilos son los reales.

  .venv/bin/python -m pytest cuerpo/pruebas_avisos.py -q
"""
import asyncio, json, os, random, sys, threading, time, types

import pytest

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, AQUI)

import avisos as av                # noqa: E402
import canal_robot                 # noqa: E402
import voz_hermes as vh            # noqa: E402
from avisos import Avisos, CandadoTurno, Conversacion   # noqa: E402
from canal_robot import AleRobot, HiloEventos           # noqa: E402
from cuerpo import bus             # noqa: E402
from cuerpo.sueno import Sueno     # noqa: E402
from pruebas_canal_robot import ServidorEventos, TOKEN, _esperar, _foto  # noqa: E402

PAL = ["jolly"]


class Reloj:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Loc:
    """Locutor falso: registra lo que dice y cuándo."""

    def __init__(self, dura=0.0):
        self.frases, self.dicho, self.turno, self.oc, self.dura = [], [], None, False, dura
        self.t_primer_audio, self.fines = None, 0
        self.hablando_ahora = threading.Event()

    def ocupado(self, cola_s=0.6):
        return self.oc or self.hablando_ahora.is_set()

    def decir(self, texto):
        self.hablando_ahora.set()
        self.frases.append((time.monotonic(), self.turno, texto))
        self.dicho.append((time.monotonic(), texto))

    def fin_turno(self):
        self.fines += 1

    def esperar(self):
        if self.dura:
            time.sleep(self.dura)
        self.hablando_ahora.clear()

    def textos(self):
        return [t for _, _, t in self.frases]


def evento(i, texto="Te queda poco.", pregunta=False, **extra):
    return {"id": i, "kind": "decir", "payload": {"texto": texto, "pregunta": pregunta, "prioridad": "normal", "proposal_id": None, "vence_s": 3600, **extra}}


def armar(tmp_path, reloj=None, sueno=None, loc=None, ventana=20):
    reloj = reloj or Reloj()
    acks = []
    a = Avisos(loc or Loc(), CandadoTurno(reloj), Conversacion(reloj), tmp_path / "dichos.json", sueno=sueno,
               ack=lambda i, e: acks.append((i, e)), ventana=ventana, reloj=reloj)
    return a, acks, reloj


class Muse:
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


def frase(texto, turno=0):
    return [(0.0, {"type": "speechStart", "turnId": turno}), (0.0, {"type": "transcript", "transcript": texto}),
            (0.0, {"type": "speechEnd", "audioProcessedMs": 10, "turnId": turno}),
            (0.0, {"type": "speechComplete", "audioProcessedMs": 10, "turnId": turno, "transcript": texto})]


class Hermes:
    """Ale falso. `sostener` deja el turno pensando, sin una sola muestra de audio."""

    def __init__(self, respuesta="Listo.", sostener=None, pensar=0.0, al_entrar=None):
        self.preguntas, self.respuesta, self.sostener, self.pensar, self.al_entrar = [], respuesta, sostener, pensar, al_entrar
        self.ventanas = []

    def preguntar(self, texto, al_token=None, al_comentario=None, turno=None):
        t0 = time.monotonic()
        self.preguntas.append(texto)
        if self.al_entrar:
            self.al_entrar()
        if self.sostener:
            self.sostener.wait(5)
        if self.pensar:
            time.sleep(self.pensar)
        if al_token:
            al_token(self.respuesta)
        self.ventanas.append((t0, time.monotonic()))
        return self.respuesta


def correr(monkeypatch, tmp_path, guion, hermes, loc, conv=None, candado=None, avisos=None, palabra=PAL, ventana=20):
    monkeypatch.setattr(vh, "SALIDA", tmp_path / "instrucciones.jsonl")
    monkeypatch.setattr(vh.websockets, "connect", lambda *a, **k: Muse(guion))

    async def fuente(cola, ruta):
        await cola.put(bytes(64)); await asyncio.sleep(0.02); await cola.put(None)
    monkeypatch.setattr(vh, "fuente_archivo", fuente)
    args = types.SimpleNamespace(sin_palabra=False, palabra=palabra, keywords=[], archivo="x", locutor=loc, webhook=None,
                                 cliente_hermes=hermes, ventana=ventana, conv=conv, candado=candado, avisos=avisos)
    q = bus.escuchar_local()
    asyncio.run(vh.sesion(args, "x"))
    time.sleep(0.02)
    out = []
    while not q.empty():
        out.append(q.get())
    bus._locales.remove(q)
    return out


# --------------------------------------------------------------------------------------------- condición para hablar
def test_con_todo_libre_habla_con_turno_propio_y_abre_ventana(tmp_path):
    """El aviso es un turno de voz completo: id propio, fin_turno, espera y 20 s para responder sin decir Jolly."""
    a, acks, r = armar(tmp_path)
    q = bus.escuchar_local()
    a.recibir(evento(1, "¿Te llegaron 22 o 24?", pregunta=True))
    assert a.paso()
    assert a.loc.textos() == ["¿Te llegaron 22 o 24?"] and a.loc.frases[0][1] == "aviso-1" and a.loc.fines == 1
    assert acks == [(1, "hecho")] and a.conv.abierta_hasta == r.t + 20
    temas = []
    while not q.empty():
        temas.append(q.get())
    bus._locales.remove(q)
    assert any(m["tema"] == "ale/evento" and m["tipo"] == "aviso" and m["id"] == 1 for m in temas)
    assert any(m["tema"] == "oido/evento" and m["tipo"] == "ventana" for m in temas)


def test_turno_sin_audio_el_aviso_espera(monkeypatch, tmp_path):
    """Hueco de la sesión: Ale piensa, `ocupado` es falso y el micrófono sigue abierto. Sin candado el aviso entraría ahí."""
    a, acks, r = armar(tmp_path)
    a.recibir(evento(1))
    suelta, dentro = threading.Event(), threading.Event()
    h = Hermes(sostener=suelta, al_entrar=dentro.set)
    hilo = threading.Thread(target=correr, args=(monkeypatch, tmp_path, frase("Jolly, cómo voy"), h, a.loc),
                            kwargs=dict(conv=a.conv, candado=a.candado, avisos=a))
    hilo.start()
    assert dentro.wait(3)
    r.t += 60
    assert not a.loc.ocupado() and not a.paso() and a.loc.textos() == []
    suelta.set()
    hilo.join(3)
    r.t += av.GRACIA_S + 0.1
    assert a.paso() and a.loc.textos()[-1] == "Te queda poco."


def test_dueno_hablando_el_aviso_espera_sin_silenciar_el_microfono(monkeypatch, tmp_path):
    """Si el aviso sonara, `enviar_audio` taparía al dueño con silencio. Ni el locutor se ocupa."""
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    a.conv.habla_inicio()
    r.t += 5
    assert not a.paso() and not a.loc.ocupado() and a.loc.frases == []
    a.conv.habla_fin()
    assert not a.paso()                        # sin parcial en los últimos 1,5 s
    r.t += av.SIN_PARCIAL_S + 0.01
    assert a.paso()


def test_parcial_reciente_frena_el_aviso(tmp_path):
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    a.conv.parcial()
    r.t += 1.0
    assert not a.paso()
    r.t += 0.6
    assert a.paso()


def test_speech_end_perdido_no_traba_y_sesion_nueva_reinicia(tmp_path):
    """Un speechEnd perdido no puede dejar los avisos mudos para siempre."""
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    a.conv.habla_inicio()
    r.t += av.DUENO_VENCE_S - 0.1
    assert not a.paso()
    r.t += 0.2
    assert a.paso()
    c = Conversacion(r)
    c.habla_inicio()
    c.sesion_nueva()
    assert not c.dueno_activo()


def test_un_parcial_largo_renueva_al_dueno(tmp_path):
    """Hablar más de 10 s seguidos no vence: lo que vence es el silencio de Muse."""
    r = Reloj()
    c = Conversacion(r)
    c.habla_inicio()
    r.t += av.DUENO_VENCE_S - 1
    c.parcial()
    r.t += av.DUENO_VENCE_S - 1
    assert c.dueno_activo()


def test_abrir_sesion_real_reinicia_dueno_hablando(monkeypatch, tmp_path):
    """El arranque de `sesion` reinicia: la conexión caída se llevó el speechEnd."""
    conv = Conversacion()
    conv.dueno_hablando, conv.dueno_visto = True, time.monotonic()
    correr(monkeypatch, tmp_path, [], None, Loc(), conv=conv)
    assert conv.dueno_hablando is False


def test_gracia_de_1_5_s_tras_soltar_el_candado(tmp_path):
    """`recibir()` no drena eventos durante `entregar`: un speechStart viejo puede estar en cola."""
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    a.candado.tomar(); a.candado.soltar()
    r.t += 1.4
    assert not a.paso()
    r.t += 0.2
    assert a.paso()


def test_mirar_sin_hablar_no_reinicia_la_gracia(tmp_path):
    """Una vuelta en vacío del hilo no debe alargar la espera para siempre."""
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    a.conv.dueno_activo = lambda: False
    a.candado.tomar(False); a.candado.soltar(hablo=False)
    assert a.candado.liberado == float("-inf")


def test_dueno_entra_justo_antes_del_candado(tmp_path):
    """Se revisa de nuevo con el candado en mano."""
    a, _, r = armar(tmp_path)
    a.recibir(evento(1))
    vistas = iter([False, True])
    a.conv.dueno_activo = lambda: next(vistas)
    assert not a.paso() and a.loc.frases == [] and len(a.cola) == 1 and a.candado.libre()


# ------------------------------------------------------------------------------------------------- colisión sembrada
def test_cien_colisiones_sembradas_nunca_mezclan(monkeypatch, tmp_path):
    """Aviso y `entregar` a la vez: el `entregar` real sostiene el candado mientras `avisos` intenta hablar."""
    monkeypatch.setattr(av, "GRACIA_S", 0.0)
    monkeypatch.setattr(av, "SIN_PARCIAL_S", 0.0)
    azar = random.Random(12)
    intentos_en_turno = 0
    for corrida in range(100):
        loc = Loc(dura=0.002)
        a, acks, _ = armar(tmp_path, reloj=time.monotonic, loc=loc)
        a.ruta_dichos = tmp_path / f"dichos-{corrida}.json"
        a.dichos = []
        a.recibir(evento(corrida + 1, "Aviso."))
        entrada, fin = threading.Event(), threading.Event()
        h = Hermes(respuesta="Respuesta.", pensar=azar.uniform(0.002, 0.012), al_entrar=entrada.set)
        retraso = azar.uniform(0, 0.01)

        def vueltas():
            nonlocal intentos_en_turno
            time.sleep(retraso)
            while not fin.is_set() or a.cola:
                if entrada.is_set() and not h.ventanas:
                    a.conv.habla_fin()
                    intentos_en_turno += not a.candado.libre()
                a.paso()
                time.sleep(0.0005)
        hilo = threading.Thread(target=vueltas)
        hilo.start()
        correr(monkeypatch, tmp_path, frase("Jolly, cómo voy"), h, loc, conv=a.conv, candado=a.candado, avisos=a)
        fin.set()
        hilo.join(3)
        assert not hilo.is_alive()
        momentos = {t: tu for t, tu, _ in loc.frases}
        aviso = [t for t, tu in momentos.items() if tu and tu.startswith("aviso")]
        assert len(aviso) == 1 and acks == [(corrida + 1, "hecho")]
        for t0, t1 in h.ventanas:
            assert not t0 <= aviso[0] <= t1, f"corrida {corrida}: el aviso sonó dentro del turno"
    assert intentos_en_turno >= 100          # hubo disputa real, no carreras que nunca se cruzan


# ---------------------------------------------------------------------------------------------------------- es_eco
def test_llegaron_22_tras_la_pregunta_no_es_eco(monkeypatch, tmp_path):
    """R6: la respuesta repite palabras de la pregunta, y «22» ni cuenta por largo."""
    dicho = "¿Te llegaron 22 o 24?"
    assert vh.es_eco("llegaron 22", [(time.monotonic(), dicho)])     # control: sin exención se la traga
    a, _, r = armar(tmp_path, reloj=time.monotonic)
    a.recibir(evento(1, dicho, pregunta=True))
    assert a.paso()
    h = Hermes()
    correr(monkeypatch, tmp_path, frase("llegaron 22"), h, a.loc, conv=a.conv, candado=a.candado, avisos=a)
    assert h.preguntas == ["llegaron 22"]


def test_solo_la_primera_frase_se_salva_del_eco(monkeypatch, tmp_path):
    a, _, _ = armar(tmp_path, reloj=time.monotonic)
    a.recibir(evento(1, "¿Te llegaron 22 o 24?", pregunta=True))
    assert a.paso()
    h = Hermes(respuesta="Listo.")
    guion = frase("llegaron 22", 1) + [(0.05, e) for _, e in frase("te llegaron 22", 2)]
    m = correr(monkeypatch, tmp_path, guion, h, a.loc, conv=a.conv, candado=a.candado, avisos=a)
    assert h.preguntas == ["llegaron 22"]
    assert [x["motivo"] for x in m if x.get("tipo") == "ignorada"] == ["eco"]


def test_la_exencion_vence_con_la_ventana():
    r = Reloj()
    c = Conversacion(r)
    c.exentar_eco(r.t + 20)
    r.t += 21
    assert not c.tomar_exencion_eco()


def test_sin_avisos_es_eco_sigue_igual(monkeypatch, tmp_path):
    """ALE_AVISOS=0: ni una regla cambia."""
    loc = Loc()
    loc.dicho = [(time.monotonic(), "¿Te llegaron 22 o 24?")]
    conv = Conversacion()
    conv.exentar_eco(time.monotonic() + 20)
    conv.abierta_hasta = time.monotonic() + 20
    h = Hermes()
    m = correr(monkeypatch, tmp_path, frase("llegaron 22"), h, loc, conv=conv)
    assert h.preguntas == [] and [x["motivo"] for x in m if x.get("tipo") == "ignorada"] == ["eco"]


def test_pregunta_dentro_de_un_turno_normal_tambien_exenta(monkeypatch, tmp_path):
    """R6 también ocurre cuando Ale pregunta dentro de la conversación, sin aviso."""
    a, _, _ = armar(tmp_path, reloj=time.monotonic)
    h = Hermes(respuesta="¿Te llegaron 22 o 24?")
    guion = frase("Jolly, llegó el pedido", 1) + frase("llegaron 22", 2)
    correr(monkeypatch, tmp_path, guion, h, a.loc, conv=a.conv, candado=a.candado, avisos=a)
    assert h.preguntas == ["llegó el pedido", "llegaron 22"]


# ------------------------------------------------------------------------------------------------ reconexión y reinicio
def test_reconexion_de_muse_conserva_la_ventana(monkeypatch, tmp_path):
    conv, candado = Conversacion(), CandadoTurno()
    a = types.SimpleNamespace(frase_ignorada=lambda: None)
    h = Hermes()
    correr(monkeypatch, tmp_path, frase("Jolly, hola"), h, Loc(), conv=conv, candado=candado, avisos=a)
    correr(monkeypatch, tmp_path, frase("y mañana"), h, Loc(), conv=conv, candado=candado, avisos=a)
    assert h.preguntas == ["hola", "y mañana"]


def test_sin_avisos_la_ventana_muere_con_la_sesion_como_hoy(monkeypatch, tmp_path):
    h = Hermes()
    correr(monkeypatch, tmp_path, frase("Jolly, hola"), h, Loc())
    correr(monkeypatch, tmp_path, frase("y mañana"), h, Loc())
    assert h.preguntas == ["hola"]


def test_reinicio_no_repite_lo_dicho(tmp_path):
    """Se marca antes de sonar: un corte a mitad del aviso tampoco lo repite."""
    a, _, _ = armar(tmp_path)
    a.loc.esperar = lambda: (_ for _ in ()).throw(KeyboardInterrupt())
    a.recibir(evento(5))
    with pytest.raises(KeyboardInterrupt):
        a.paso()
    nuevo, _, _ = armar(tmp_path)
    assert nuevo.recibir(evento(5)) == "hecho" and nuevo.cola == []


def _hilo(sim, tmp_path, monkeypatch, avisos):
    monkeypatch.setenv("ALE_DEVICE_TOKEN", TOKEN)
    monkeypatch.setattr(canal_robot, "RECONEXION_S", (0.01,))
    env = tmp_path / ".env"
    env.write_text("")
    return HiloEventos(AleRobot(sim.url, env), tmp_path / "cursor", confirmar=lambda s: True, sub=object(), avisos=avisos)


def test_cursor_no_pasa_de_un_aviso_sin_confirmar(tmp_path, monkeypatch):
    """Una foto más nueva se confirma primero; si el cursor saltara al aviso, un reinicio lo perdería."""
    sim = ServidorEventos([evento(6), _foto(7)])
    a, _, _ = armar(tmp_path)
    hilo = _hilo(sim, tmp_path, monkeypatch, a)
    hilo.start()
    _esperar(lambda: (7, "recibido") in sim.acks)
    assert hilo.cursor == 0 and hilo.sin_ack == {6}
    assert a.paso()
    _esperar(lambda: (6, "hecho") in sim.acks and hilo.cursor == 7)
    hilo.parar.set()
    assert (tmp_path / "cursor").read_text() == "7"


def test_reentrega_de_un_aviso_en_cola_no_lo_duplica(tmp_path, monkeypatch):
    sim = ServidorEventos([evento(6)])
    a, _, _ = armar(tmp_path)
    hilo = _hilo(sim, tmp_path, monkeypatch, a)
    hilo.start()
    _esperar(lambda: len(sim.conexiones) >= 3)
    hilo.parar.set()
    assert len(a.cola) == 1


def test_ack_caido_se_reintenta_al_reconectar_sin_repetir(tmp_path, monkeypatch):
    sim = ServidorEventos([evento(6)])
    a, _, _ = armar(tmp_path)
    hilo = _hilo(sim, tmp_path, monkeypatch, a)
    op = hilo._op
    falla = [True]

    def _op(cuerpo):
        if cuerpo.get("op") == "event_ack" and falla:
            falla.clear()
            raise OSError("red")
        return op(cuerpo)
    hilo._op = _op
    hilo.start()
    _esperar(lambda: a.cola)
    assert a.paso()
    _esperar(lambda: (6, "hecho") in sim.acks and hilo.cursor == 6)
    hilo.parar.set()
    assert a.loc.textos() == ["Te queda poco."]


def test_solo_avisos_consume_decir_y_la_foto_va_a_ojo(tmp_path, monkeypatch):
    publicado = []
    monkeypatch.setattr(canal_robot.bus, "publicar", lambda tema, **d: publicado.append(tema))
    sim = ServidorEventos([evento(6), _foto(7)])
    a, _, _ = armar(tmp_path)
    hilo = _hilo(sim, tmp_path, monkeypatch, a)
    hilo.start()
    _esperar(lambda: (7, "recibido") in sim.acks and len(sim.conexiones) >= 3)    # el cursor sigue atrás: vuelve a llegar
    hilo.parar.set()
    assert publicado.count("ojo/orden") == 1 and [c["id"] for c in a.cola] == [6]


def test_robot_sin_avisos_no_se_traga_el_aviso(tmp_path, monkeypatch):
    """ALE_AVISOS=0 con ALE_EVENTOS=1: no suena, y queda para que Ale lo lleve por el canal."""
    sim = ServidorEventos([evento(6)])
    hilo = _hilo(sim, tmp_path, monkeypatch, None)
    hilo.start()
    _esperar(lambda: sim.acks)
    hilo.parar.set()
    assert sim.acks[0] == (6, "vencido")


# --------------------------------------------------------------------------------------------------- dormido y estado
def test_dormido_espera_al_despertar_habla(tmp_path):
    s = Sueno(tmp_path / "dormido")
    s.aplicar("dormir")
    a, _, _ = armar(tmp_path, sueno=s)
    a.recibir(evento(1))
    assert not a.paso() and len(a.cola) == 1
    s.aplicar("despertar")
    assert a.paso()


def test_vencido_no_se_dice(tmp_path):
    a, acks, r = armar(tmp_path)
    a.recibir(evento(1, vence_s=100))
    a.conv.habla_inicio()
    r.t += 101
    assert not a.paso() and a.loc.frases == [] and acks == [(1, "vencido")] and a.cola == []


def test_dormido_y_vencido_tampoco(tmp_path):
    s = Sueno(tmp_path / "dormido")
    s.aplicar("dormir")
    a, acks, r = armar(tmp_path, sueno=s)
    a.recibir(evento(1, vence_s=100))
    r.t += 101
    s.aplicar("despertar")
    assert not a.paso() and acks == [(1, "vencido")]


class ServidorEstado:
    def __init__(self):
        self.ops = []
        sim = self
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                sim.ops.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"))
                self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"


def test_sueno_avisa_el_estado_al_servidor(tmp_path, monkeypatch):
    """Sin esto el servidor seguiría entregando avisos a un robot dormido: `avisar_estado` existía y nadie la llamaba."""
    sim = ServidorEstado()
    monkeypatch.setenv("ALE_DEVICE_TOKEN", TOKEN)
    monkeypatch.setattr(canal_robot.HiloEventos, "start", lambda self: None)
    env = tmp_path / ".env"
    env.write_text("")
    s = Sueno(tmp_path / "dormido")
    a, _, _ = armar(tmp_path, sueno=s)
    AleRobot(sim.url, env, avisos=a, sueno=s).preparar()
    s.aplicar("dormir")
    _esperar(lambda: {"op": "state", "device_state": "dormido"} in sim.ops)
    s.aplicar("despertar")
    _esperar(lambda: {"op": "state", "device_state": "activo"} in sim.ops)


def test_arranca_dormido_y_conecta_dormido(tmp_path, monkeypatch):
    """Un reinicio dormido no se anuncia despierto al servidor."""
    monkeypatch.setenv("ALE_DEVICE_TOKEN", TOKEN)
    creados = []
    monkeypatch.setattr(canal_robot.HiloEventos, "start", lambda self: creados.append(self))
    env = tmp_path / ".env"
    env.write_text("")
    s = Sueno(tmp_path / "dormido")
    s.aplicar("dormir")
    a, _, _ = armar(tmp_path, sueno=s)
    AleRobot("http://127.0.0.1:1", env, avisos=a, sueno=s).preparar()
    assert creados[0].dormido is True


def test_sin_avisos_ni_eventos_no_hay_hilo_ni_gancho(tmp_path, monkeypatch):
    monkeypatch.setenv("ALE_DEVICE_TOKEN", TOKEN)
    monkeypatch.delenv("ALE_EVENTOS", raising=False)
    creados = []
    monkeypatch.setattr(canal_robot.HiloEventos, "start", lambda self: creados.append(self))
    env = tmp_path / ".env"
    env.write_text("")
    s = Sueno(tmp_path / "dormido")
    AleRobot("http://127.0.0.1:1", env, sueno=s).preparar()
    assert creados == [] and s.al_cambiar is None


# --------------------------------------------------------------------------------------------------- frase perdida
def test_respuesta_encima_de_la_pregunta_queda_ignorada_y_avisa(monkeypatch, tmp_path):
    """La sesión real: `ocupado` tira la frase, queda `ignorada` en el bus y avisos.py se entera."""
    llamadas = []
    a = types.SimpleNamespace(frase_ignorada=lambda: llamadas.append(1))
    loc = Loc()
    loc.oc = True
    m = correr(monkeypatch, tmp_path, frase("llegaron 22"), Hermes(), loc, conv=Conversacion(), candado=CandadoTurno(), avisos=a)
    assert [x["motivo"] for x in m if x.get("tipo") == "ignorada"] == ["ocupado"] and llamadas == [1]


def test_la_pregunta_se_reitera_una_sola_vez(tmp_path):
    """Una respuesta perdida no se queda en silencio, pero Jolly tampoco insiste."""
    a, acks, r = armar(tmp_path)
    a.recibir(evento(1, "¿Te llegaron 22 o 24?", pregunta=True))
    assert a.paso()
    a.frase_ignorada()
    a.frase_ignorada()
    assert len(a.cola) == 1
    a.loc.hablando_ahora.clear()
    r.t += av.GRACIA_S + 0.1
    assert a.paso()
    assert " ".join(" ".join(a.loc.textos()[1:]).split()) == " ".join((av.PERDON + "¿Te llegaron 22 o 24?").split())
    a.frase_ignorada()
    assert a.cola == [] and acks == [(1, "hecho")]


def test_afirmacion_no_se_reitera(tmp_path):
    a, _, _ = armar(tmp_path, reloj=time.monotonic)
    a.recibir(evento(1, "Quedan pocos."))
    assert a.paso()
    a.frase_ignorada()
    assert a.cola == []


def test_frase_tarde_tras_la_ventana_no_reitera(tmp_path):
    a, _, r = armar(tmp_path)
    a.recibir(evento(1, "¿Cuántos?", pregunta=True))
    assert a.paso()
    r.t += 21
    a.frase_ignorada()
    assert a.cola == []


# ------------------------------------------------------------------------------------------------------ orden y fallos
def test_prioridad_alta_primero(tmp_path):
    a, _, r = armar(tmp_path)
    a.recibir(evento(1, "Normal."))
    a.recibir(evento(2, "Alta.", prioridad="alta"))
    a.paso()
    assert a.loc.textos() == ["Alta."]


def test_un_aviso_no_pisa_la_pregunta_anterior(tmp_path):
    a, _, r = armar(tmp_path)
    a.recibir(evento(1, "¿Cuántos?", pregunta=True))
    a.recibir(evento(2, "Otro aviso."))
    assert a.paso()
    a.loc.hablando_ahora.clear()
    r.t += 2
    assert not a.paso()
    r.t += 20
    assert a.paso() and a.loc.textos()[-1] == "Otro aviso."


def test_fallo_del_locutor_suelta_el_candado_y_pasa_al_canal(tmp_path):
    a, acks, _ = armar(tmp_path)
    a.loc.decir = lambda t: (_ for _ in ()).throw(ConnectionError())
    a.recibir(evento(1))
    assert not a.paso() and a.candado.libre() and acks == [(1, "vencido")]


# -------------------------------------------------------------------------------------------------- voz inyectada
def test_fuente_carpeta_solo_con_bandera(monkeypatch):
    monkeypatch.setenv("ALE_VOZ_CARPETA", "/tmp/voz")
    monkeypatch.delenv("ALE_AVISOS", raising=False)
    assert vh.carpeta_inyectada() is None
    monkeypatch.setenv("ALE_AVISOS", "1")
    assert vh.carpeta_inyectada() == "/tmp/voz"
    monkeypatch.setenv("ALE_ENTORNO", "produccion")
    assert vh.carpeta_inyectada() is None


def test_fuente_carpeta_mete_el_wav_entre_silencios(tmp_path, monkeypatch):
    import wave
    with wave.open(str(tmp_path / "a.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(vh.TASA); w.writeframes(b"\x01\x00" * int(vh.TASA * 0.02))
    monkeypatch.setattr(vh, "BLOQUE_S", 0.005)

    async def medir():
        cola: asyncio.Queue = asyncio.Queue()
        t = asyncio.create_task(vh.fuente_carpeta(cola, str(tmp_path)))
        await asyncio.sleep(0.1)
        t.cancel()
        return [cola.get_nowait() for _ in range(cola.qsize())]
    bloques = asyncio.run(medir())
    assert any(any(b) for b in bloques) and any(not any(b) for b in bloques)
