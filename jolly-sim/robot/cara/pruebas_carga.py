"""Pruebas de la pantalla de carga del arranque. Cada prueba nombra la regla de negocio que garantiza.
.venv/bin/python -m pytest pruebas_carga.py -q"""
import json, os, time
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import pygame
import zmq

from boton_sueno import ZONA_CIRCULO
from carga import ANCHO_MAX, ESPERA_BUS, Carga
from controlador import Controlador
from render import Render
from sueno import DUR, FPS_DORMIDA

pygame.init()
pygame.display.set_mode((64, 64))
VINCULAR = {"estado": "mostrando", "codigo": "K7QM-3XPA", "url": "https://x", "expira": None}


def en_carga():
    ctl, avisos = Controlador(1), []
    ctl.al_sueno = lambda e, d, t: avisos.append(e)
    ctl.iniciar_carga(0.0, ESPERA_BUS)
    return ctl, avisos


def correr(ctl, t0, t1, dt=1 / 60):
    t = t0
    while t < t1:
        ctl.cuadro(t)
        t += dt
    return t


def test_en_carga_se_ve_el_texto_sin_zzz_ni_boton_y_es_liviana():
    ctl, _ = en_carga()
    assert ctl.estado()["carga"] and ctl.sueno.estado == "dormida" and ctl.fps_bajo() == FPS_DORMIDA
    assert not ctl.boton_visible() and ctl.toque(*ZONA_CIRCULO.center, (480, 320), 0, 1.0) is None
    r, t = Render(ss=2), correr(ctl, 0.0, 1.0)
    c = ctl.cuadro(t)
    con = r.dibujar(c, None, t, lambda L, ss: ctl.dibujar_encima(L, ss, t, c["subir"])).copy()
    sin = r.dibujar(c).copy()
    assert con.get_at((240, 304))[:3] != sin.get_at((240, 304))[:3]       # los puntos se dibujan


def test_el_texto_cabe_aunque_la_fuente_sea_ancha(monkeypatch):
    """Si la Pi usa una fuente más ancha el texto se reduce, nunca se corta en 3,5 pulgadas."""
    grande = pygame.font.SysFont("dejavusans", 80, bold=True)
    monkeypatch.setattr(pygame.font, "SysFont", lambda *a, **k: grande)
    assert Carga().texto(2).get_width() <= ANCHO_MAX * 2


def test_latido_la_despierta_con_animacion_sin_mover_brazos():
    """La voz ya está: se va el texto y hace el despertar de 3 s, sin avisar a brazos que pueden no estar listos."""
    ctl, avisos = en_carga()
    t = correr(ctl, 0.0, 5.0)
    ctl.voz_lista(t)
    assert not ctl.carga.activa and ctl.sueno.estado == "despertando"
    correr(ctl, t, t + DUR["despertando"] + 0.1)
    assert ctl.sueno.estado == "despierta" and avisos == [] and not ctl.sueno_mudo
    ctl.orden_sueno("dormir", 20.0)
    assert avisos == ["durmiendose"]                                       # después del arranque avisa normal


def test_si_estaba_dormida_termina_dormida_sin_animacion():
    ctl, avisos = en_carga()
    ctl.orden_sueno("dormir", 2.0)
    assert not ctl.carga.activa and ctl.sueno.estado == "dormida" and avisos == ["dormida"]
    assert ctl.boton_visible()
    correr(ctl, 2.0, 3.0)
    assert ctl.cuadro(3.0)["arco_ojos"] > 0.5 and ctl.sueno.estado == "dormida"


def test_orden_despertar_como_primer_mensaje_avisa_a_los_brazos():
    ctl, avisos = en_carga()
    ctl.orden_sueno("despertar", 2.0)
    assert ctl.sueno.estado == "despertando" and avisos == ["despertando"]


def test_sin_vincular_va_directo_a_la_pantalla_del_codigo():
    ctl, avisos = en_carga()
    ctl.emparejamiento(VINCULAR, 2.0)
    assert ctl.empareja.activa and not ctl.carga.activa and ctl.sueno.estado == "despierta" and avisos == []


def test_vinculado_al_arrancar_despierta_normal():
    ctl, _ = en_carga()
    ctl.emparejamiento({"estado": "vinculado", "codigo": None, "url": None, "expira": None}, 2.0)
    assert not ctl.empareja.activa and ctl.sueno.estado == "despertando"


def test_a_los_45_s_sin_mensajes_sale_sola_a_reposo():
    ctl, _ = en_carga()
    correr(ctl, 0.0, ESPERA_BUS - 0.5, dt=0.5)
    assert ctl.carga.activa
    t = correr(ctl, ESPERA_BUS - 0.5, ESPERA_BUS + DUR["despertando"] + 0.2, dt=0.1)
    assert not ctl.carga.activa and ctl.sueno.estado == "despierta" and ctl.nombre_momento == "reposo"
    assert ctl.boton_visible()


def test_mensaje_cuerpo_latido_por_el_bus_sale_de_carga(monkeypatch):
    import oyente as O
    monkeypatch.setattr(O, "BUS", "tcp://127.0.0.1:15770")
    monkeypatch.setattr(O, "BUS_CARA", "tcp://127.0.0.1:15771")
    pub = zmq.Context.instance().socket(zmq.PUB); pub.setsockopt(zmq.LINGER, 0); pub.bind("tcp://127.0.0.1:15770")
    ctl, _ = en_carga()
    oy = O.Oyente(ctl)
    time.sleep(0.25)
    pub.send_multipart([b"cuerpo/latido", json.dumps({"t": 0.0}).encode()])
    time.sleep(0.1)
    oy.atender(1.0)
    pub.close(0); oy.sub.close(0); oy.pub.close(0)
    assert not ctl.carga.activa and ctl.sueno.estado == "despertando"


def test_sin_internet_no_sale_de_la_carga_y_avisa():
    """Regla del dueño: sin red no hay bucle ni se finge la cara normal; avisa y sale apenas la voz dé señales."""
    import types
    ctl = Controlador(1)
    ctl.red = types.SimpleNamespace(caida=True)
    ctl.iniciar_carga(0.0, 45.0)
    ctl.cuadro(100.0)
    assert ctl.carga.activa and ctl.sin_internet
    ctl.red.caida = False
    ctl.cuadro(101.0)
    assert not ctl.carga.activa


def test_red_necesita_dos_fallos(monkeypatch):
    """Un bache de wifi no muestra el aviso."""
    import red
    r = red.Red("127.0.0.1:9")
    def falla(*a, **k):
        raise OSError
    monkeypatch.setattr(red.socket, "create_connection", falla)
    r.revisar()
    assert not r.caida
    r.revisar()
    assert r.caida
