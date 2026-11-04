"""Pruebas del modo dormir. Cada prueba nombra la regla de negocio que garantiza.
.venv/bin/python -m pytest pruebas_sueno.py -q"""
import json, os, time
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import pygame
import zmq

from boton_sueno import AUTO_RECOGER, ZONA_CIRCULO, ZONA_PILDORA, a_logico
from controlador import Controlador
from render import CREMA, Render
from sueno import DUR, FPS_DORMIDA

pygame.init()
pygame.display.set_mode((64, 64))
TAM = (480, 320)
EN_CIRCULO, EN_PILDORA, LEJOS = ZONA_CIRCULO.center, ZONA_PILDORA.center, (240, 100)


def correr(ctl, t0, t1, dt=1 / 60):
    t = t0
    while t < t1:
        ctl.cuadro(t)
        t += dt
    return t


def dormida(t0=0.0):
    ctl = Controlador(1)
    ctl.orden_sueno("dormir", t0)
    return ctl, correr(ctl, t0, t0 + DUR["durmiendose"] + 0.1)


def test_duraciones_claras_para_que_brazos_y_voz_acompanen():
    """Cada animación avisa su inicio con la duración y su fin; 3,8 s al dormir y 3,0 s al despertar."""
    ctl, avisos = Controlador(1), []
    ctl.al_sueno = lambda e, d, t: avisos.append((e, d, round(t, 1)))
    ctl.orden_sueno("dormir", 0.0)
    t = correr(ctl, 0.0, 4.0)
    ctl.orden_sueno("despertar", t)
    correr(ctl, t, t + 3.2)
    assert [(e, d) for e, d, _ in avisos] == [("durmiendose", 3.8), ("dormida", 0.0), ("despertando", 3.0), ("despierta", 0.0)]
    assert avisos[1][2] == 3.8


def test_dormida_ignora_al_director_y_al_despertar_aplica_lo_ultimo():
    """Dormida no gesticula aunque el latido republique momentos; al despertar queda en el último momento recibido."""
    ctl, t = dormida()
    ctl.momento("escucha", t)
    ctl.emocion("feliz", t)
    assert ctl.nombre_emocion == "neutral" and ctl.nombre_momento == "reposo"
    ctl.orden_sueno("despertar", t)
    correr(ctl, t, t + 3.2)
    assert ctl.nombre_momento == "escucha" and not ctl.sueno.activo


def test_orden_en_plena_animacion_espera_su_fin():
    """Pedir despertar mientras se duerme no corta la animación: despierta al terminar."""
    ctl = Controlador(1)
    ctl.orden_sueno("dormir", 0.0)
    t = correr(ctl, 0.0, 1.0)
    ctl.orden_sueno("despertar", t)
    assert ctl.sueno.estado == "durmiendose"
    t = correr(ctl, t, 3.9)
    assert ctl.sueno.estado == "despertando"


def test_boton_primer_toque_abre_segundo_ejecuta():
    """Regla del owner: el primer toque abre y el segundo ejecuta."""
    ctl = Controlador(1)
    assert ctl.toque(*EN_CIRCULO, TAM, 0, 0.0) is None and ctl.boton.abierto
    assert ctl.toque(*EN_PILDORA, TAM, 0, 0.5) == "dormir"
    assert not ctl.boton.abierto


def test_boton_se_recoge_solo_y_tocar_fuera_no_ejecuta():
    ctl = Controlador(1)
    ctl.toque(*EN_CIRCULO, TAM, 0, 0.0)
    ctl.cuadro(AUTO_RECOGER + 0.1)
    assert not ctl.boton.abierto
    ctl.toque(*EN_CIRCULO, TAM, 0, 10.0)
    assert ctl.toque(*LEJOS, TAM, 0, 10.5) is None and not ctl.boton.abierto


def test_dormida_un_roce_no_la_despierta():
    """Tocar en cualquier parte solo abre el botón; despertar exige el segundo toque sobre la píldora."""
    ctl, t = dormida()
    assert ctl.toque(*LEJOS, TAM, 0, t) is None and ctl.boton.abierto and ctl.sueno.estado == "dormida"
    assert ctl.toque(*EN_PILDORA, TAM, 0, t + 0.5) == "despertar"


def test_boton_visible_al_conversar_y_oculto_al_emparejar():
    """Se puede dormir mientras escucha, piensa o habla; no en plena animación ni en la pantalla de vinculación."""
    ctl = Controlador(1)
    ctl.momento("hablando", 0.0)
    assert ctl.boton_visible() and ctl.toque(*EN_CIRCULO, TAM, 0, 0.1) is None and ctl.boton.abierto
    ctl = Controlador(1)
    ctl.orden_sueno("dormir", 0.0)
    assert not ctl.boton_visible()
    ctl = Controlador(1)
    ctl.emparejamiento({"estado": "mostrando", "codigo": "K7QM-3XPA", "url": None, "expira": 99}, 0.0)
    assert not ctl.boton_visible()


def test_toque_con_pantalla_al_reves():
    """Con giro 180 el toque en la esquina opuesta del panel cae sobre el botón, también a resolución nativa."""
    assert a_logico(1280, 720, (1280, 720), 0) == (480, 320)
    assert a_logico(0, 0, (1280, 720), 180) == (480, 320)
    ctl = Controlador(1)
    ctl.toque(10, 10, (1280, 720), 180, 0.0)
    assert ctl.boton.abierto


def test_dormida_baja_los_cuadros_salvo_con_el_boton_abierto():
    ctl, t = dormida()
    assert ctl.fps_bajo() == FPS_DORMIDA
    ctl.toque(*LEJOS, TAM, 0, t)
    assert ctl.fps_bajo() is None
    assert Controlador(1).fps_bajo() is None


def test_dibuja_cada_estado_sin_tocar_la_cara_despierta():
    """El gorrito y los arcos se dibujan; despierta y sin botón la cara queda igual que antes."""
    ctl, t = dormida()
    r = Render(ss=2)
    c = ctl.cuadro(t)
    s = r.dibujar(c, ctl.burb, t, lambda L, ss: ctl.dibujar_encima(L, ss, t, c["subir"]))
    assert s.get_at((100, 20))[:3] != s.get_at((100, 200))[:3]            # arriba hay gorrito, no piel
    ctl.boton.abierto = True
    r.dibujar(c, ctl.burb, t, lambda L, ss: ctl.dibujar_encima(L, ss, t, c["subir"]))
    assert Controlador(1).cuadro(0.0)["arco_ojos"] == 0.0


def test_el_gorrito_cubre_el_borde_de_arriba_aunque_baje():
    """Dormida la cara baja 2 px y el gorrito rebota al caer: nunca se ve piel por encima de él."""
    ctl, t = dormida()
    r = Render(ss=2)
    c = {**ctl.cuadro(t), "subir": -6.0}
    s = r.dibujar(c, None, t, lambda L, ss: ctl.dibujar_encima(L, ss, t, c["subir"]))
    assert all(s.get_at((x, 0))[:3] != CREMA for x in range(0, 480, 20))


def test_bus_orden_y_avisos(monkeypatch):
    """cuerpo/sueno duerme la cara y ella publica cara/sueno y cara/toque en su bus."""
    import oyente as O
    monkeypatch.setattr(O, "BUS", "tcp://127.0.0.1:15760")
    monkeypatch.setattr(O, "BUS_CARA", "tcp://127.0.0.1:15761")
    ctx = zmq.Context.instance()
    pub = ctx.socket(zmq.PUB); pub.setsockopt(zmq.LINGER, 0); pub.bind("tcp://127.0.0.1:15760")
    ctl = Controlador(1)
    oy = O.Oyente(ctl)
    sub = ctx.socket(zmq.SUB); sub.setsockopt(zmq.LINGER, 0); sub.setsockopt(zmq.SUBSCRIBE, b"cara/")
    sub.connect("tcp://127.0.0.1:15761")
    time.sleep(0.25)
    pub.send_multipart([b"cuerpo/sueno", json.dumps({"orden": "dormir", "t": 0.0}).encode()])
    time.sleep(0.1)
    oy.atender(1.0)
    oy.toque("despertar", "boton", 1.0)
    time.sleep(0.1)
    temas = {}
    while sub.poll(50):
        tema, cuerpo = sub.recv_multipart()
        temas[tema.decode()] = json.loads(cuerpo)
    pub.close(0); sub.close(0); oy.sub.close(0); oy.pub.close(0)
    assert ctl.sueno.estado == "durmiendose"
    assert temas["cara/sueno"]["estado"] == "durmiendose" and temas["cara/sueno"]["dur"] == 3.8
    assert temas["cara/toque"]["accion"] == "despertar" and temas["cara/toque"]["origen"] == "boton"


def test_tactil_medido_cae_donde_se_toco():
    """Los toques de la calibración real caen en su blanco; el botón de la esquina queda al alcance."""
    import tactil
    for cx, cy, x, y in [(942, 976, .22, .24), (1060, 3127, .78, .24), (2941, 978, .22, .76), (1978, 2104, .5, .5)]:
        lx, ly = tactil.a_pantalla(cx, cy)
        assert abs(lx / 480 - x) < .02 and abs(ly / 320 - y) < .03
