"""Pruebas de la dinámica de la cara: que no se sienta monótona. Cada prueba nombra la regla de negocio que garantiza.
.venv/bin/python -m pytest pruebas_viva.py -q"""
import json, os, time
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import pygame
import zmq

from controlador import ANTICIPA, Controlador, factor_intensidad, intensificar

pygame.init()
pygame.display.set_mode((64, 64))


def turno(c, t, previo="trabajando"):
    c.momento(previo, t, pista="leyendo" if previo == "trabajando" else None)
    c.momento("hablando", t + 1.0)
    c.cuadro(t + 1.0 + ANTICIPA)
    return list(c.burb.activos)


def reacciones(c):
    salen = []
    c.al_reaccion = lambda n, e, i, d, p, t: salen.append((n, p, round(t, 2)))
    return salen


def test_bombillito_nunca_dos_veces_en_90_s_y_sale_menos_de_un_tercio():
    """Queja del owner: siempre el bombillito (82 % de los turnos)."""
    con_foco, c, ultimo = 0, Controlador(4), -1e9
    for i in range(100):
        t = i * 20.0
        if "foco" in turno(c, t):
            assert t - ultimo >= 90
            con_foco += 1; ultimo = t
        c.momento("reposo", t + 5); c.burb.activos.clear()
    assert 3 <= con_foco < 30


def test_pensar_poquito_no_saca_bombillito():
    c = Controlador(4)
    for i in range(30):
        assert "foco" not in turno(c, i * 100.0, "pensando")
        c.momento("reposo", i * 100.0 + 5); c.burb.activos.clear()


def test_hablando_rota_de_cara_cada_dos_o_tres_frases():
    c, vistas = Controlador(3), set()
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    for i in range(30):
        t = 1.0 + i * 3.0
        c.gesto_habla(t); vistas.add(c.variante)
        c.anim.gesto_pasos = []
    assert len(vistas) >= 5
    cambios = [s for s in salen if s[0] == "cambio_al_hablar"]
    assert 10 <= len(cambios) <= 15 and cambios[0][1] == "brazos"


def test_cambio_de_cara_conserva_la_emocion_en_curso():
    c = Controlador(3)
    c.momento("hablando", 0.0)
    c.emocion("feliz", 0.1, 0.9); c.cuadro(0.1)
    expr = c.expr_emocion
    for i in range(3):
        c.gesto_habla(1.0 + i)
    assert c.nombre_emocion == "feliz" and c.expr_emocion == expr


def test_la_intensidad_se_nota_en_la_cara():
    assert factor_intensidad(1.0) > factor_intensidad(0.55) > factor_intensidad(0.3)
    c1, c2 = Controlador(1), Controlador(1)
    c1.momento("hablando", 0.0); c2.momento("hablando", 0.0)
    c1.emocion("feliz", 1.0, 0.3); c2.emocion("feliz", 1.0, 1.0)
    assert c2.expr_emocion["boca.sonrisa"] > c1.expr_emocion["boca.sonrisa"]


def test_nunca_triste_aunque_la_intensidad_sea_maxima():
    """D5 con el factor más alto: ni sonrisa al revés ni párpado triste."""
    from selector import cargar
    for lista in cargar()["emociones"].values():
        for v in lista:
            e = intensificar(v["expr"], factor_intensidad(1.0))
            assert e.get("boca.sonrisa", 1) >= 0 and e.get("ojos.sup_ang", 0) >= -20


def test_a_tope_no_deja_boca_recta_ni_ojos_partidos():
    """Hallado mirando las caras a intensidad máxima: preocupada quedaba sin sonrisa y orgullosa con el ojo cortado."""
    from selector import cargar
    emos = cargar()["emociones"]
    for v in emos["preocupada"]:
        assert intensificar(v["expr"], factor_intensidad(1.0))["boca.sonrisa"] >= 0.18
    e = emos["orgullosa"][0]["expr"]
    assert intensificar(e, factor_intensidad(1.0))["ojos.inf"] == intensificar(e)["ojos.inf"]


def test_celebra_avisa_antes_de_verse_y_van_los_dos_a_tope():
    """cara/reaccion sale 150 ms antes; la cara cambia a esa hora. orgullosa usa el factor máximo aunque la frase sea suave."""
    c = Controlador(1)
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    base = c.anim.objetivo["boca.sonrisa"]
    c.emocion("orgullosa", 2.0, 0.55)
    assert salen == [("celebra", "ambos", 2.15)]
    c.cuadro(2.1)
    assert c.anim.objetivo["boca.sonrisa"] == base
    c.cuadro(2.16)
    assert c.anim.objetivo["boca.sonrisa"] > base
    assert c.expr_emocion["boca.sonrisa"] >= intensificar({"boca.sonrisa": 1.3}, factor_intensidad(1.0))["boca.sonrisa"] - 0.2


def test_celebra_respeta_su_pausa_pero_la_cara_igual_cambia():
    c = Controlador(1)
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    c.emocion("orgullosa", 1.0, 0.8); c.cuadro(1.2)
    c.emocion("orgullosa", 5.0, 0.8)
    assert len([s for s in salen if s[0] == "celebra"]) == 1 and "destellos" in c.burb.activos


def test_mala_noticia_con_plan_es_alivio_con_brazos_de_protagonista():
    c = Controlador(1)
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    c.emocion("preocupada", 1.0, 0.5)
    c.emocion("preocupada", 30.0, 0.75)
    assert [s[:2] for s in salen] == [("alivio", "brazos")]


def test_ofrecer_y_senalar_salen_de_la_frase():
    c = Controlador(1)
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    c.gesto_habla(1.0, intencion="ofrece")
    c.gesto_habla(2.0, intencion="ofrece")                  # en pausa
    c.gesto_habla(3.0, intencion="muestra")
    nombres = [s[0] for s in salen if s[0] != "cambio_al_hablar"]
    assert nombres == ["ofrecer", "señalar"]


def test_dormida_no_reacciona():
    c = Controlador(1)
    salen = reacciones(c)
    c.momento("hablando", 0.0)
    c.gesto_habla(0.5, intencion="ofrece")
    c.orden_sueno("dormir", 0.55)
    c.cuadro(0.8)
    assert not c.reaccionar("ya_se", 1.0)


def test_reposo_cambia_de_expresion_solo():
    c, vistas, t = Controlador(2), set(), 0.0
    while t < 400:
        c.cuadro(t); vistas.add(c.variante)
        c.anim.gesto_pasos = []
        t += 0.5
    assert len(vistas) >= 4


def test_bus_publica_cara_reaccion(monkeypatch):
    import oyente as O
    monkeypatch.setattr(O, "BUS", "tcp://127.0.0.1:15780")
    monkeypatch.setattr(O, "BUS_CARA", "tcp://127.0.0.1:15781")
    ctx = zmq.Context.instance()
    pub = ctx.socket(zmq.PUB); pub.setsockopt(zmq.LINGER, 0); pub.bind("tcp://127.0.0.1:15780")
    c = Controlador(1)
    oy = O.Oyente(c)
    sub = ctx.socket(zmq.SUB); sub.setsockopt(zmq.LINGER, 0); sub.setsockopt(zmq.SUBSCRIBE, b"cara/reaccion")
    sub.connect("tcp://127.0.0.1:15781")
    time.sleep(0.25)
    c.momento("hablando", 0.0)
    pub.send_multipart([b"cuerpo/emocion", json.dumps({"t": 1.0, "emocion": "orgullosa", "intensidad": 0.75}).encode()])
    time.sleep(0.1)
    oy.atender(2.0)
    time.sleep(0.1)
    assert sub.poll(200)
    _, cuerpo = sub.recv_multipart()
    pub.close(0); sub.close(0); oy.sub.close(0); oy.pub.close(0)
    m = json.loads(cuerpo)
    assert (m["nombre"], m["emocion"], m["intensidad"], m["protagonista"], m["t"]) == ("celebra", "orgullosa", 0.75, "ambos", 2.15)
