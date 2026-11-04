"""BR-004/005: los brazos complementan a la cara según la tabla aprobada. Cada prueba nombra su regla.
.venv/bin/python -m pytest pruebas_brazos.py -q"""
import gestos as G
import pytest

from brazos import Cuerpo, TEMAS


def nuevo():
    hechos = []
    c = Cuerpo(G.cargar(), hechos.append, semilla=1)
    return c, hechos


def en_reposo_viva():
    """Cuerpo con director vivo, en reposo y sin gestos corriendo."""
    c, h = nuevo()
    c.latido = 0.0
    return c, h


def grupo(clave):
    return G.cargar()["complementos"][clave]


def dur(n):
    return sum(p[0] for p in G.cargar()["gestos"][n]["poses"])


def test_al_oir_ale_desde_reposo_saluda_y_en_conversacion_dice_si():
    """Tabla: 'Ale' desde reposo → saludo corto; en conversación → '¿sí?'."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 1.0)
    assert h[-1] in grupo("nombre_desde_reposo")
    c.momento_nuevo({"momento": "hablando"}, 2.0)
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 9.0)
    assert h[-1] in grupo("nombre_en_conversacion")


def test_pensar_trabajar_y_problema():
    """Tabla: pensando → barbilla; largo → mmm; trabajando teclea/lee según la herramienta; problema → encoger."""
    c, h = nuevo()
    for m, pista, clave in [("pensando", None, "pensando"), ("pensando_largo", None, "pensando_largo"),
                            ("trabajando", "tecleando", "trabajando_tecleando"), ("trabajando", "leyendo", "trabajando_leyendo"),
                            ("problema", None, "problema")]:
        c.momento_nuevo({"momento": m, "pista": pista}, 10.0)
        assert h[-1] in grupo(clave), (m, pista)


def test_hablando_espera_a_la_frase_y_gesticula_variado():
    """Tabla: al hablar, un gesto pequeño por frase (no se adelanta a la voz); pregunta → barbilla; sin repetir el anterior."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "hablando"}, 1.0)
    assert h == []                                             # espera a la primera frase
    t, vistos = 1.0, []
    for _ in range(6):
        t += 1.5
        c.gesto_frase({"pregunta": False}, t); vistos.append(h[-1])
    assert set(vistos) <= set(grupo("frase")) and len(set(vistos)) >= 4
    assert all(a != b for a, b in zip(vistos, vistos[1:]))
    c.gesto_frase({"pregunta": True}, t + 2)
    assert h[-1] in grupo("frase_pregunta")


def test_emociones_complementarias():
    """Tabla: orgullosa → celebrar; feliz → asentir con la mano; preocupada → juntos (nunca derrotada)."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa"}, 1.0); assert h[-1] in grupo("orgullosa")
    c.emocion({"emocion": "feliz"}, 2.0); assert h[-1] in grupo("feliz")
    c.emocion({"emocion": "preocupada"}, 3.0); assert h[-1] in grupo("preocupada")


def test_menos_es_mas_nunca_dos_gestos_grandes_seguidos():
    """Owner: acompañar sin competir — nunca dos gestos grandes (celebrar/estirarse/saludo) en < 3 s."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa"}, 1.0)
    c.emocion({"emocion": "orgullosa"}, 2.0)
    c.micro_gesto("bostecito", 2.5)
    assert len(h) == 1
    c.micro_gesto("bostecito", 8.0)
    assert len(h) == 2


def test_vinculado_celebra_como_la_cara():
    """Contrato robot/emparejamiento: celebra solo al pasar de mostrando/vencido a vinculado."""
    c, h = nuevo()
    c.emparejamiento({"estado": "vinculado"}, 1.0); assert h == []    # ya estaba vinculado al arrancar
    c.emparejamiento({"estado": "mostrando"}, 2.0)
    c.emparejamiento({"estado": "vinculado"}, 3.0); assert h[-1] in grupo("vinculado")


def test_todos_los_gestos_respetan_rangos():
    """A6: ninguna pose pide más de ±100 % (el firmware además limita a los µs calibrados)."""
    cat = G.cargar()
    for n, g in cat["gestos"].items():
        for ms, d, i in g["poses"]:
            assert all(v is None or -100 <= v <= 100 for v in (d, i)), n
    assert G.escalar(95, 1.2) == 100 and G.escalar(None, 1.0) == G.NO_TOCAR


# ---------------- si la cara hace X, el brazo hace Y (S1/S2) ----------------
@pytest.mark.parametrize("cara", ["giro_jolly", "bostecito"])
def test_gesto_de_reposo_de_la_cara_mueve_los_brazos(cara):
    """S2: los brazos acompañan el giro y el bostezo de la cara."""
    c, h = en_reposo_viva()
    c.micro_gesto(cara, 10.0)
    assert len(h) == 1 and h[0] in grupo(cara)


@pytest.mark.parametrize("cara", ["mirar_alrededor", "parpadeo_doble"])
def test_mirar_y_parpadear_dejan_los_brazos_quietos(cara):
    """Tabla de reposo: esos gestos son solo de la cara."""
    c, h = en_reposo_viva()
    c.micro_gesto(cara, 10.0)
    assert h == []


def test_en_reposo_los_brazos_no_se_mueven_solos():
    """S2: sin aviso de la cara no hay gesto, aunque pase mucho tiempo."""
    c, h = en_reposo_viva()
    for t in range(0, 600):
        c.latido = float(t); c.tic(float(t))
    assert h == []


def test_gesto_de_reposo_solo_en_reposo_y_sin_codigo_en_pantalla():
    """Fuera de reposo se ignora; con el código de vinculación los brazos no se mueven detrás."""
    c, h = en_reposo_viva()
    c.momento_nuevo({"momento": "hablando"}, 1.0)
    c.micro_gesto("giro_jolly", 2.0); assert h == []
    c, h = en_reposo_viva()
    c.emparejamiento({"estado": "mostrando"}, 1.0)
    c.micro_gesto("bostecito", 2.0); assert h == []


def test_duracion_del_reposo_igual_a_los_pasos_de_la_cara():
    """S2: mano y cara van a la par: giro 4,6 s y bostezo 2,3 s, con el brazo del mismo lado que la cara."""
    assert dur("balanceo_giro") == 4600 and dur("giro_amplio") == 4600 and dur("estirarse") == 2300
    poses = G.cargar()["gestos"]["balanceo_giro"]["poses"]
    assert poses[0][1] > 0 > poses[2][1]


@pytest.mark.parametrize("m,clave", [({"momento": "pensando"}, "pensando"), ({"momento": "pensando_largo"}, "pensando_largo"),
                                     ({"momento": "trabajando", "pista": "tecleando"}, "trabajando_tecleando"),
                                     ({"momento": "trabajando", "pista": "leyendo"}, "trabajando_leyendo"),
                                     ({"momento": "escucha"}, "escucha"), ({"momento": "problema"}, "problema")])
def test_momento_de_la_cara_mueve_el_brazo(m, clave):
    """S1: el brazo sale del mismo aviso que mueve a la cara, a su hora."""
    c, h = en_reposo_viva()
    c.recibir("cuerpo/momento", {**m, "t": 5.0}, 4.9)
    c.tic(4.95); assert h == []                               # todavía no es la hora
    c.tic(5.0); assert len(h) == 1 and h[0] in grupo(clave)


# ---------------- prioridades ----------------
def test_frase_no_corta_celebrar():
    """Nivel 1 no corta nivel 2: la celebración se ve completa."""
    c, h = nuevo()
    c.momento = "hablando"
    c.emocion({"emocion": "orgullosa"}, 1.0)
    c.gesto_frase({"pregunta": False}, 1.5)
    assert len(h) == 1


def test_nombre_corta_frase_y_celebrar():
    """Oír su nombre es lo que lo hace sentir vivo: corta aunque corra un gesto grande."""
    c, h = nuevo()
    c.momento = "hablando"
    c.emocion({"emocion": "orgullosa"}, 1.0)
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 2.0)
    assert h[-1] in grupo("nombre_en_conversacion")


def test_problema_corta_teclear_y_frase_no():
    """Nivel 4 corta el bucle; una frase no."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "trabajando", "pista": "tecleando"}, 1.0)
    c.momento = "hablando"
    c.gesto_frase({"pregunta": False}, 2.0); assert len(h) == 1
    c.momento = "trabajando"
    c.momento_nuevo({"momento": "problema"}, 3.0); assert h[-1] in grupo("problema")


def test_emparejamiento_corta_todo():
    """Nivel 5: el momento de vinculación manda."""
    c, h = nuevo()
    c.emparejamiento({"estado": "mostrando"}, 0.5)
    c.momento_nuevo({"momento": "problema"}, 1.0)
    c.emparejamiento({"estado": "vinculado"}, 1.1)
    assert h[-1] == "celebrar_vinculo"


def test_salir_de_teclear_baja_los_brazos_aunque_el_bucle_no_tenga_fin():
    """Regreso a reposo, también si muere el director: un bucle no deja los brazos arriba."""
    paradas = []
    h = []
    c = Cuerpo(G.cargar(), h.append, semilla=1, detener=lambda: paradas.append(1))
    c.momento_nuevo({"momento": "trabajando", "pista": "tecleando"}, 1.0)
    c.momento_nuevo({"momento": "reposo"}, 2.0)
    assert h[-1] == "reposo" and paradas
    c, h = en_reposo_viva()
    c.recibir("cuerpo/momento", {"momento": "trabajando", "pista": "leyendo", "t": 1.0}, 1.0)
    c.tic(1.0); c.tic(4.1)
    assert h[-1] == "reposo"


def test_el_momento_nunca_se_pierde():
    """Owner: si Ale piensa durante el saludo, la mano va a la barbilla al terminar el saludo."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 1.0)
    c.momento_nuevo({"momento": "pensando"}, 1.5)
    assert len(h) == 1
    c.tic(1.0 + dur(h[0]) / 1000 - 0.05); assert len(h) == 1
    c.tic(1.0 + dur(h[0]) / 1000); assert len(h) == 2 and h[1] in grupo("pensando")


def test_pendiente_vencida_no_se_ejecuta():
    """Si el momento cambió mientras esperaba, solo vale el último."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 1.0)
    c.momento_nuevo({"momento": "pensando"}, 1.2)
    c.momento_nuevo({"momento": "pensando_largo"}, 1.4)
    c.tic(9.0)
    assert len(h) == 2 and h[1] in grupo("pensando_largo")


def test_reposo_pendiente_baja_al_terminar_el_gesto():
    """Los brazos nunca se quedan arriba: el regreso a reposo espera y se ejecuta."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa"}, 1.0)
    c.momento = "hablando"
    c.momento_nuevo({"momento": "reposo"}, 1.2)
    assert h[-1] != "reposo"
    c.tic(5.0); assert h[-1] == "reposo"


def test_al_hablar_para_el_bucle():
    """Al empezar a hablar deja de teclear y sostiene la pose hasta la primera frase."""
    paradas, h = [], []
    c = Cuerpo(G.cargar(), h.append, semilla=1, detener=lambda: paradas.append(1))
    c.momento_nuevo({"momento": "trabajando", "pista": "tecleando"}, 1.0)
    c.momento_nuevo({"momento": "hablando"}, 2.0)
    assert paradas and c.vivo is None and len(h) == 1


# ---------------- bus ----------------
def test_la_cara_viva_no_reemplaza_al_director():
    """Si muere el director a los 3 s van a reposo, aunque sigan llegando avisos de la cara."""
    c, h = en_reposo_viva()
    c.recibir("cuerpo/momento", {"momento": "pensando", "t": 1.0}, 1.0)
    c.tic(1.0)
    for t in (2.0, 3.0, 3.9):
        c.recibir("cara/micro", {"nombre": "giro_jolly", "t": t}, t); c.tic(t)
    c.tic(4.1)
    assert h[-1] == "reposo"


def test_gesto_de_reposo_viejo_se_descarta():
    """Un aviso que llega tarde no se hace."""
    c, h = en_reposo_viva()
    c.recibir("cara/micro", {"nombre": "giro_jolly", "t": 1.0}, 2.0); c.tic(2.0)
    assert h == []


def test_solo_escucha_los_temas_necesarios():
    """cara/estado llega 10 veces por segundo y no se usa."""
    import zmq
    ctx = zmq.Context.instance()
    pub, sub = ctx.socket(zmq.PUB), ctx.socket(zmq.SUB)
    puerto = pub.bind_to_random_port("tcp://127.0.0.1")
    for tema in TEMAS:
        sub.setsockopt(zmq.SUBSCRIBE, tema)
    sub.connect(f"tcp://127.0.0.1:{puerto}")
    import time
    time.sleep(0.2)
    pub.send_multipart([b"cara/estado", b"{}"]); pub.send_multipart([b"cara/micro", b"{}"])
    time.sleep(0.2)
    assert sub.recv_multipart(flags=zmq.NOBLOCK)[0] == b"cara/micro"
    assert sub.poll(50) == 0
    pub.close(0); sub.close(0)


# ---------------- pool variado (feedback owner 1-nov: "siempre selecciona los mismos") ----------------
import random


def test_ningun_momento_tiene_un_solo_gesto():
    """Cada momento de la tabla tiene al menos 2 opciones (reposo y bostezo son la excepción)."""
    for clave, lista in G.cargar()["complementos"].items():
        if clave not in ("reposo", "bostecito"):
            assert len(lista) >= 2, clave
    for clave, n in (("frase", 6), ("pensando", 4), ("feliz", 4), ("trabajando_leyendo", 4)):
        assert len(grupo(clave)) >= n, clave


def test_no_repite_los_ultimos_dos_del_grupo():
    """En un grupo de 3 o más, un gesto no vuelve hasta que pasen 2."""
    c, h = nuevo()
    c.momento = "hablando"
    t = 0.0
    for _ in range(100):
        t += 5.0
        c.gesto_frase({"pregunta": False}, t)
    assert len(h) == 100 and all(h[i] not in h[i - 2:i] for i in range(2, 100))
    assert len(set(h)) == len(grupo("frase"))                  # usa todo el pool


def test_los_gestos_de_una_mano_se_alternan():
    """Antes el 52 % era solo la derecha: ahora cada gesto de una mano cambia de lado en cada uso."""
    envios = []
    class B:
        def mover(self, d, i, ms): envios.append((d, i))
    r = G.Reproductor(B())
    g = {"espejo": True, "poses": [[40, 50, None]]}
    import time
    for _ in range(4):
        r.reproducir(g); time.sleep(0.08)
    assert [e[0] == 999 for e in envios] == [True, False, True, False]


def test_el_mismo_gesto_nunca_sale_identico():
    """Variación de amplitud y tiempo, sin pasar del rango."""
    g = G.cargar()["gestos"]["celebrar_arriba"]
    a, b = G.preparar(g, rnd=random.Random(1)), G.preparar(g, rnd=random.Random(2))
    assert a != b
    assert all(-100 <= v <= 100 for p in a + b for v in p[1:])


def test_emocion_fuerte_usa_todo_el_rango_y_leve_menos():
    """Owner: una emoción muy expresiva llega al 100 %."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa", "intensidad": 1.0}, 1.0)
    assert c.vivo["intensidad"] == 1.0
    c, h = nuevo()
    c.emocion({"emocion": "feliz", "intensidad": 0.55}, 1.0)
    assert c.vivo["intensidad"] == 0.75
    assert max(p[1] for p in G.preparar(G.cargar()["gestos"]["celebrar_arriba"], 1.0)) == 100


def test_celebrar_no_se_repite_en_una_misma_respuesta():
    """Con emociones seguidas celebra una vez y vuelve a poder a los 15 s."""
    c, h = nuevo()
    for t in (1.0, 5.0, 10.0, 15.0):
        c.emocion({"emocion": "orgullosa"}, t)
    assert len(h) == 1
    c.emocion({"emocion": "orgullosa"}, 16.5)
    assert len(h) == 2


def test_trabajar_mueve_los_brazos_aunque_solo_lea():
    """Las herramientas usadas fueron de lectura y por eso 'teclear' salió cero veces."""
    assert "teclear" in grupo("trabajando_leyendo")
    g = G.cargar()["gestos"]["teclear"]
    assert g["bucle"] and g["poses"][0][0] <= 130 and abs(g["poses"][0][1] - g["poses"][1][1]) >= 30


def test_gesto_de_reposo_desconocido_se_ignora():
    """La cara puede agregar gestos nuevos sin romper los brazos."""
    c, h = en_reposo_viva()
    c.micro_gesto("estornudo", 1.0)
    assert h == []
