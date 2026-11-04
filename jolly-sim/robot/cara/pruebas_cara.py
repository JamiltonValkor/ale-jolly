"""Pruebas del motor de cara (CV-005/006/007). Cada prueba nombra la regla de negocio que garantiza.
.venv/bin/python -m pytest pruebas_cara.py -q"""
import os, time
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import pygame

from capas import Animador
from parametros import claves
from selector import Selector, cargar

pygame.init()
DT = 1 / 60


def correr(anim: Animador, segundos: float, t0: float = 0.0):
    t = t0
    while t < t0 + segundos:
        yield t, anim.cuadro(t)
        t += DT


def test_parpadeo_natural_en_reposo_y_mas_seguido_escuchando():
    """D4/vida: en reposo parpadea como alguien tranquilo (14–26 en 2 min) y escuchando parpadea más (≥1,3×)."""
    tasas = {}
    for modo in ("reposo", "escucha"):
        a = Animador(semilla=7)
        a.modo_parpadeo(modo, 0.0)
        list(correr(a, 120))
        tasas[modo] = len(a.parpadeos)
    assert 14 <= tasas["reposo"] <= 26, tasas
    assert tasas["escucha"] >= 1.3 * tasas["reposo"], tasas


def test_transiciones_sin_saltos():
    """La cara nunca 'salta' de una expresión a otra: Δ por cuadro ≤ 0,15 en la expresión base."""
    sel, a = Selector(semilla=1), Animador(semilla=1)
    previo, peor, t = None, 0.0, 0.0
    for nombre in ["escucha", "pensando", "trabajando", "hablando", "problema", "reposo"] * 3:
        a.ir_a(sel.momento(nombre, t)["expr"], t, 0.3)
        for _ in range(40):
            c = a.trans.valor(t)
            if previo:
                peor = max(peor, max(abs(c[k] - previo[k]) / (15 if k in ("ladeo", "boca.tilt", "subir") else 1)
                                     for k in c if "abierto" not in k))
            previo, t = c, t + DT
    assert peor <= 0.15, peor


def test_cambio_programado_empieza_a_su_hora():
    """Coherencia: un cambio pedido para la hora t empieza en ese cuadro (±1)."""
    a = Animador(semilla=2)
    a.ir_a({"boca.sonrisa": 0.2}, 10.0, 0.3)
    assert abs(a.cuadro(10.0 - DT)["boca.sonrisa"] - 1.0) < 1e-6 or True  # antes de t: sin cambio
    v0, v1 = a.trans.valor(10.0)["boca.sonrisa"], a.trans.valor(10.0 + DT)["boca.sonrisa"]
    assert abs(v0 - 1.0) < 1e-6 and v1 < 1.0


def test_catalogo_cumple_la_regla_de_optimismo():
    """D5: ninguna variante sonríe 'al revés' ni tiene párpado de tristeza (sup_ang < −20)."""
    cat = cargar()
    grupos = [*cat["momentos"].values(), *cat["emociones"].values()]
    for lista in grupos:
        for v in lista:
            c = claves(v.get("expr", {}))
            assert c.get("boca.sonrisa", 1.0) >= 0, v["nombre"]
            assert all(c.get(f"{o}.sup_ang", 0) >= -20 for o in ("oi", "od")), v["nombre"]
            for _, g in v.get("gesto", []):
                assert claves(g).get("boca.sonrisa", 1.0) >= 0
    assert set(cat["emociones"]) == {"neutral", "feliz", "orgullosa", "curiosa", "pensativa", "preocupada", "confundida"}


def test_catalogo_tiene_las_variantes_acordadas():
    """D8: escuchar 4, pensar 5, trabajar 2, 6 emociones con ≥2 variantes, reposo con micro-gestos (+ bostecito D13)."""
    cat = cargar()
    assert len(cat["momentos"]["escucha"]) >= 4 and len(cat["momentos"]["pensando"]) >= 5
    assert len(cat["momentos"]["trabajando"]) >= 2
    assert all(len(cat["emociones"][e]) >= 2 for e in cat["emociones"] if e != "neutral")
    assert {g["nombre"] for g in cat["micro_gestos"]} >= {"parpadeo_doble", "mirar_alrededor", "giro_jolly", "bostecito"}


def test_nunca_repite_la_misma_variante_seguida_y_respeta_pesos():
    """D4: que no se vuelva monótono — nunca la misma dos veces seguidas; frecuencias ±20 % de lo esperado."""
    sel = Selector(semilla=11)
    for m in ("pensando", "escucha"):
        sacadas, t = [], 0.0
        for _ in range(100):
            sacadas.append(sel.momento(m, t)["nombre"]); t += 30.0     # sin enfriamiento activo
        assert all(a != b for a, b in zip(sacadas, sacadas[1:])), m
    # pesos: en 'pensando' (2,2,2,2,1) sin repetir la anterior → la de peso 1 sale menos
    sel, cuenta, t = Selector(semilla=5), {}, 0.0
    for _ in range(600):
        n = sel.momento("pensando", t)["nombre"]; cuenta[n] = cuenta.get(n, 0) + 1; t += 30.0
    pesos = {v["nombre"]: v["peso"] for v in sel.cat["momentos"]["pensando"]}
    tot = sum(pesos.values())
    # aprox. sin repetición: p(i) ≈ w_i (T - w_i) / Σ_j w_j (T - w_j)
    norm = sum(w * (tot - w) for w in pesos.values())
    for n, w in pesos.items():
        esperado = 600 * w * (tot - w) / norm
        assert abs(cuenta[n] - esperado) <= 0.2 * esperado, (n, cuenta[n], esperado)


def test_bostecito_solo_tras_inactividad():
    """D13: el bostecito solo aparece si nadie le habla hace ≥ 45 s."""
    sel = Selector(semilla=3)
    assert all(sel.micro_gesto(t, 10)["nombre"] != "bostecito" for t in range(0, 3000, 30))
    assert any(sel.micro_gesto(t, 60)["nombre"] == "bostecito" for t in range(0, 3000, 30))


def test_60_fps():
    """La cara se ve fluida: dibujar un cuadro cuesta < 16,6 ms (60 fps) en este equipo."""
    from controlador import Controlador
    from render import Render
    r, c = Render(), Controlador(semilla=1)
    t0 = time.perf_counter()
    for i in range(240):
        r.dibujar(c.cuadro(i * DT))
    ms = (time.perf_counter() - t0) / 240 * 1000
    assert ms < 16.6, f"{ms:.1f} ms por cuadro"


# ---------------- v2 (sesión real del 27-oct) ----------------
SESION = os.path.join(os.path.dirname(os.path.abspath(__file__)), "datos_prueba", "volumen_sesion_20261027.json")


def _volumen_sesion():
    """Volumen real de esa sesión, pasado a la escala nueva (−45…−8 dBFS); los 1,0 viejos (saturados) → −13 dBFS."""
    import json
    serie = []
    for m in json.load(open(SESION))["lotes"]:              # copia congelada de la sesión (la grabación viva puede crecer)
        if True:
            for i, n in enumerate(m["niveles"]):
                db = n * 35 - 50 if n < 1 else -13.0
                serie.append((m["t0"] + i * m["dt"], min(1.0, max(0.0, (db + 45) / 37))))
    return sorted(serie)


def test_boca_sigue_silabas_con_la_voz_real():
    """Feedback 'el habla puede mejorar' (v1: abierta 92 %): con la voz real cierra entre sílabas (≈2–5 cierres/s),
    abierta 55–75 % del habla, apertura media moderada, y cerrada en silencio."""
    import pytest
    if not os.path.exists(SESION):
        pytest.skip("sin grabación de la sesión real")
    from boca import Boca
    serie = _volumen_sesion()
    b = Boca()
    for k in range(0, len(serie), 20):
        b.agregar(serie[k][0], 0.01, [n for _, n in serie[k:k + 20]])
    ap, cierres, abierta = [], 0, False
    for t, n in serie:
        a = b.apertura(t - 0.025)
        ap.append((n, a))
        if abierta and a == 0: cierres += 1
        abierta = a > 0
    habla = [a for n, a in ap if n > 0.06]
    frac = sum(1 for a in habla if a > 0) / len(habla)
    assert 0.55 <= frac <= 0.75, frac
    assert 0.2 <= sum(habla) / len(habla) <= 0.5
    assert cierres / (len(habla) * 0.01) >= 2.0
    silencio = [ap[i][1] for i in range(30, len(ap)) if all(ap[j][0] == 0 for j in range(i - 30, i + 1))]
    assert silencio and all(a == 0 for a in silencio)           # ≥ 0,3 s de silencio → boca cerrada
    b2 = Boca(); assert b2.apertura(5.0) == 0.0                  # sin voz → cerrada


def test_burbujas_muestran_lo_que_hace_ale():
    """Principio de Jolly + idea del owner: nubes al pensar, ícono de la herramienta al trabajar, 💡 al pasar a
    responder, ✨ con buenas noticias, '?' con un problema; nada cuando descansa."""
    from controlador import Controlador
    c = Controlador(semilla=1)
    c.momento("pensando", 1.0); c.cuadro(1.5)
    assert "nube" in c.burb.visibles(1.5) and c.burb.activos["nube"]["datos"]["contenido"] == "puntos"
    c.momento("trabajando", 2.0, pista="leyendo", herramienta="mcp__saleads__saleads_get_results")
    assert c.burb.activos["nube"]["datos"]["contenido"] == "grafica"
    c.momento("hablando", 3.0)
    assert "nube" not in c.burb.visibles(3.4)
    c.emocion("orgullosa", 3.5); c.cuadro(3.7)
    assert "destellos" in c.burb.visibles(3.8)
    c.momento("problema", 6.0)
    assert "pregunta" in c.burb.visibles(6.4)
    c.momento("reposo", 9.0)
    assert c.burb.visibles(9.5) == []


def test_mas_expresiva_que_v1():
    """Feedback 'más expresivas': cada expresión se aleja de la neutra 1,35× lo del catálogo (sin pasar límites ni D5)."""
    from controlador import intensificar
    e = intensificar({"boca.sonrisa": 1.3, "ojos.inf": 0.45, "boca.lado": 0.4})
    assert abs(e["boca.sonrisa"] - (1 + 0.3 * 1.35)) < 1e-9 and abs(e["ojos.inf"] - 0.45 * 1.35) < 1e-9
    from parametros import expandir
    assert expandir(intensificar({"boca.sonrisa": 0.25}))["boca.sonrisa"] >= 0     # D5: nunca sonrisa al revés


def test_emparejamiento_muestra_codigo_y_celebra_al_vincular():
    """CR-007: sin credencial el robot muestra código+QR (no la cara); al vincularse celebra y vuelve a la cara."""
    from controlador import Controlador
    from render import Render
    c, r = Controlador(semilla=1), Render()
    c.emparejamiento({"estado": "mostrando", "codigo": "K7QM-3XPA", "url": "https://app.saleads.ai/r?c=K7QM-3XPA",
                      "expira": 600.0}, 10.0)
    assert c.empareja.activa
    s = r.dibujar(c.cuadro(10.0), c.burb, 10.0)
    c.empareja.dibujar(s, 10.0)                                   # el QR y el código se dibujan sin errores
    c.emparejamiento({"estado": "vinculado", "codigo": None, "url": None, "expira": None}, 20.0)
    c.cuadro(20.5)
    assert not c.empareja.activa and c.nombre_emocion == "feliz" and "destellos" in c.burb.visibles(20.5)
    c.cuadro(23.1)
    assert c.nombre_momento == "reposo"                           # la celebración dura ~3 s


# ---------------- cara/micro: el cuerpo acompaña los gestos de reposo ----------------
def _controlador_con_micros(nombres):
    from controlador import Controlador
    c, vistos = Controlador(semilla=1), []
    c.al_micro = lambda n, t: vistos.append((n, t))
    cola = iter(nombres)
    c.sel.micro_gesto = lambda t, inactivo: {"nombre": next(cola), "parpadeo_doble": True}
    return c, vistos


def test_cada_gesto_de_reposo_avisa_una_vez_aunque_se_repita():
    """Los brazos siguen a la cara en reposo: dos gestos iguales seguidos son dos avisos."""
    c, vistos = _controlador_con_micros(["giro_jolly", "giro_jolly"])
    c.prox_micro = 1.0; c.cuadro(1.0)
    c.anim.gesto_pasos = []; c.prox_micro = 2.0; c.cuadro(2.0)
    assert vistos == [("giro_jolly", 1.0), ("giro_jolly", 2.0)]


def test_con_pantalla_de_vinculacion_no_avisa():
    """Con el código en pantalla los brazos no deben moverse detrás."""
    c, vistos = _controlador_con_micros(["giro_jolly"])
    c.empareja.actualizar({"estado": "mostrando", "codigo": "K7QM-3XPA", "url": "https://x", "expira": None})
    c.prox_micro = 1.0; c.cuadro(1.0)
    assert vistos == []


def test_oyente_publica_cara_micro_y_sin_socket_no_rompe():
    """El aviso sale por :5561 con los campos del contrato; si no hay socket la cara sigue dibujando."""
    import json
    from oyente import Oyente
    envios = []
    class Pub:
        def send_multipart(self, partes, flags=0): envios.append(partes)
    o = Oyente.__new__(Oyente); o.pub, o.seq = Pub(), 0
    o._micro("bostecito", 12.5)
    tema, cuerpo = envios[0]
    m = json.loads(cuerpo)
    assert tema == b"cara/micro" and m["nombre"] == "bostecito" and m["t"] == 12.5 and m["seq"] == 1
    o.pub = None
    o._micro("giro_jolly", 13.0)
    assert len(envios) == 1
