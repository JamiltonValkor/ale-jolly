"""BR-004/005: los brazos complementan a la cara según la tabla aprobada. Cada prueba nombra su regla.
.venv/bin/python -m pytest pruebas_brazos.py -q"""
import gestos as G
from brazos import Cuerpo


def nuevo():
    hechos = []
    c = Cuerpo(G.cargar(), hechos.append, semilla=1)
    return c, hechos


def test_al_oir_ale_desde_reposo_saluda_y_en_conversacion_dice_si():
    """Tabla: 'Ale' desde reposo → saludo corto; en conversación → '¿sí?'."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 1.0)
    assert h[-1] == "saludo_corto"
    c.momento_nuevo({"momento": "hablando"}, 2.0)
    c.momento_nuevo({"momento": "escucha", "pista": "brillo_nombre"}, 9.0)
    assert h[-1] == "saludo_si"


def test_pensar_trabajar_y_problema():
    """Tabla: pensando → barbilla; largo → mmm; trabajando teclea/lee según la herramienta; problema → encoger."""
    c, h = nuevo()
    for m, pista, esperado in [("pensando", None, "barbilla"), ("pensando_largo", None, "mmm"),
                               ("trabajando", "tecleando", "teclear"), ("trabajando", "leyendo", "leer"),
                               ("problema", None, "encoger")]:
        c.momento_nuevo({"momento": m, "pista": pista}, 10.0)
        assert h[-1] == esperado, (m, pista)


def test_hablando_espera_a_la_frase_y_gesticula_variado():
    """Tabla: al hablar, un gesto pequeño por frase (no se adelanta a la voz); pregunta → barbilla; sin repetir el anterior."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "hablando"}, 1.0)
    assert h == []                                             # espera a la primera frase
    t, vistos = 1.0, []
    for _ in range(6):
        t += 1.5
        c.gesto_frase({"pregunta": False}, t); vistos.append(h[-1])
    assert set(vistos) <= {"gesticular_abrir", "gesticular_enfasis", "gesticular_dos"} and len(set(vistos)) >= 2
    assert all(a != b for a, b in zip(vistos, vistos[1:]))
    c.gesto_frase({"pregunta": True}, t + 2)
    assert h[-1] == "barbilla"


def test_emociones_complementarias():
    """Tabla: orgullosa → celebrar; feliz → asentir con la mano; preocupada → juntos (nunca derrotada)."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa"}, 1.0); assert h[-1] in ("celebrar_arriba", "celebrar_pechito")
    c.emocion({"emocion": "feliz"}, 2.0); assert h[-1] == "asentir_mano"
    c.emocion({"emocion": "preocupada"}, 3.0); assert h[-1] == "juntos"


def test_menos_es_mas_nunca_dos_gestos_grandes_seguidos():
    """Owner: acompañar sin competir — nunca dos gestos grandes (celebrar/estirarse/saludo) en < 3 s."""
    c, h = nuevo()
    c.emocion({"emocion": "orgullosa"}, 1.0)
    c.emocion({"emocion": "orgullosa"}, 2.0)
    c.micro_gesto("bostecito", 2.5)
    assert len(h) == 1
    c.emocion({"emocion": "orgullosa"}, 8.0)
    assert len(h) == 2


def test_vinculado_celebra_como_la_cara():
    """Contrato robot/emparejamiento: celebra solo al pasar de mostrando/vencido a vinculado."""
    c, h = nuevo()
    c.emparejamiento({"estado": "vinculado"}, 1.0); assert h == []    # ya estaba vinculado al arrancar
    c.emparejamiento({"estado": "mostrando"}, 2.0)
    c.emparejamiento({"estado": "vinculado"}, 3.0); assert h[-1] == "celebrar_vinculo"


def test_reposo_baja_los_brazos_y_tiene_vida_leve():
    """Tabla: reposo → abajo; de vez en cuando un balanceo leve (vida sin moverse de más)."""
    c, h = nuevo()
    c.momento_nuevo({"momento": "escucha"}, 1.0)
    c.momento_nuevo({"momento": "reposo"}, 2.0); assert h[-1] == "reposo"
    c.tic(2.0 + 60); assert h[-1] == "balanceo"


def test_todos_los_gestos_respetan_rangos():
    """A6: ninguna pose pide más de ±100 % (el firmware además limita a los µs calibrados)."""
    cat = G.cargar()
    for n, g in cat["gestos"].items():
        for ms, d, i in g["poses"]:
            assert all(v is None or -100 <= v <= 100 for v in (d, i)), n
    assert G.escalar(95, 1.2) == 100 and G.escalar(None, 1.0) == G.NO_TOCAR
