"""Pruebas de negocio del director y las emociones (CV-009/010). .venv/bin/python -m pytest cuerpo/pruebas_director.py -q"""
from cuerpo.director import Director
from cuerpo.emociones import Emociones, clasificar


class Reloj:
    def __init__(self): self.t = 100.0
    def __call__(self): return self.t


def nuevo():
    salida, reloj = [], Reloj()
    d = Director(publicar=lambda tema, **m: salida.append({"tema": tema, **m}), reloj=reloj)
    return d, salida, reloj


def momentos(salida):
    return [(m["momento"], m.get("pista")) for m in salida if m["tema"] == "cuerpo/momento"]


def ev(tema, t, **k):
    return {"tema": tema, "t": t, **k}


def test_reacciona_al_nombre_al_instante_y_con_la_misma_hora():
    """D11: al oír 'Ale' la cara pasa a escucha a la hora del parcial (sin esperar el fin de la frase)."""
    d, s, _ = nuevo()
    d.evento(ev("oido/evento", 100.2, tipo="nombre_detectado", texto="Ale"))
    assert s[-1]["momento"] == "escucha" and s[-1]["pista"] == "brillo_nombre" and s[-1]["t"] == 100.2


def test_falsa_alarma_vuelve_atras_sin_pasar_por_pensando():
    """Eco/ignorada: si 'Ale' no era para ella, vuelve al momento anterior y nunca piensa."""
    d, s, _ = nuevo()
    d.evento(ev("oido/evento", 100.0, tipo="nombre_detectado"))
    d.evento(ev("oido/evento", 100.3, tipo="nombre_cancelado", motivo="eco"))
    assert momentos(s) == [("escucha", "brillo_nombre"), ("reposo", None)]


def test_flujo_completo_pregunta_herramienta_respuesta():
    """Coherencia: escucha → pensando → trabajando (leyendo) → pensando → hablando → escucha (ventana abierta)."""
    d, s, r = nuevo()
    d.evento(ev("oido/evento", 100.0, tipo="nombre_detectado"))
    d.evento(ev("ale/evento", 101.0, tipo="pregunta", turno="T1", texto="¿cómo va mi negocio?"))
    d.evento(ev("ale/evento", 101.5, tipo="herramienta_inicio", turno="T1", nombre="mcp__saleads__saleads_get_results"))
    d.evento(ev("ale/evento", 102.5, tipo="herramienta_fin", turno="T1", nombre="mcp__saleads__saleads_get_results", ok=True))
    d.evento(ev("voz/turno_inicio", 103.2))
    d.evento(ev("voz/turno_fin", 106.0))
    d.evento(ev("oido/evento", 106.1, tipo="ventana", abierta_hasta=126.0))
    assert momentos(s)[:5] == [("escucha", "brillo_nombre"), ("pensando", None), ("trabajando", "leyendo"),
                               ("pensando", None), ("hablando", None)]
    assert momentos(s)[-1] == ("escucha", None)


def test_herramienta_que_escribe_se_ve_tecleando():
    """D10: como Jolly, cuando Ale cambia algo en SaleADS se le ve 'tecleando'."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 1.0, tipo="pregunta", turno="T"))
    d.evento(ev("ale/evento", 1.2, tipo="herramienta_inicio", turno="T", nombre="mcp__saleads__saleads_update_plan"))
    assert momentos(s)[-1] == ("trabajando", "tecleando")


def test_si_tarda_pasa_a_pensando_largo():
    """D8: si Ale tarda > 3,5 s en responder, la cara muestra 'ya casi' (no se queda congelada)."""
    d, s, r = nuevo()
    d.evento(ev("ale/evento", 100.0, tipo="pregunta", turno="T"))
    d.tic(103.0); assert momentos(s)[-1][0] == "pensando"
    d.tic(103.6); assert momentos(s)[-1][0] == "pensando_largo"


def test_error_muestra_problema_y_nunca_se_queda_pensando():
    """D5/auditoría: un error de red pone cara confundida unos segundos y luego vuelve (nunca pensando eterno)."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 100.0, tipo="pregunta", turno="T"))
    d.evento(ev("ale/evento", 100.5, tipo="error", turno="T", origen="red"))
    assert momentos(s)[-1][0] == "problema"
    d.tic(103.1)
    assert momentos(s)[-1][0] in ("reposo", "escucha")
    d.tic(110.0)
    assert momentos(s)[-1][0] != "pensando_largo"


def test_eventos_de_otro_turno_se_ignoran():
    """Coherencia: una herramienta tardía del turno anterior no cambia la cara del turno nuevo."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 1.0, tipo="pregunta", turno="NUEVO"))
    d.evento(ev("ale/evento", 1.1, tipo="herramienta_inicio", turno="VIEJO", nombre="x"))
    assert momentos(s)[-1][0] == "pensando"


def test_ventana_vencida_vuelve_a_reposo():
    """Tras la conversación (ventana de 20 s vencida) la cara descansa."""
    d, s, _ = nuevo()
    d.evento(ev("voz/turno_inicio", 1.0)); d.evento(ev("voz/turno_fin", 3.0))
    d.evento(ev("oido/evento", 3.1, tipo="ventana", abierta_hasta=23.1))
    d.tic(10.0); assert momentos(s)[-1][0] == "escucha"
    d.tic(23.2); assert momentos(s)[-1][0] == "reposo"


def test_emocion_por_frase_a_la_hora_de_la_frase():
    """D7/D11: la emoción cambia cuando suena la frase que la justifica, con su misma hora."""
    d, s, _ = nuevo()
    d.evento(ev("voz/turno_inicio", 10.0))
    d.evento(ev("voz/frase", 10.0, texto="Hola, soy Ale."))
    d.evento(ev("voz/frase", 11.4, texto="Tus ventas subieron un 20% esta semana."))
    emos = [(m["emocion"], m["t"]) for m in s if m["tema"] == "cuerpo/emocion"]
    assert emos == [("feliz", 10.0), ("orgullosa", 11.4)]


def test_relleno_no_cambia_la_emocion():
    """El 'mmm…' es relleno: no debe disparar emociones."""
    d, s, _ = nuevo()
    d.evento(ev("voz/frase", 1.0, texto="Buena pregunta.", es_relleno=True))
    assert not [m for m in s if m["tema"] == "cuerpo/emocion"]


def test_latido_no_adelanta_un_cambio_programado():
    """El republicado (slow-joiner) nunca hace que la cara hable antes de que suene la voz."""
    d, s, _ = nuevo()
    d.evento(ev("voz/turno_inicio", 50.0))             # sonará a las 50
    d.latido(49.0)
    rep = [m for m in s if m["tema"] == "cuerpo/momento"][-1]
    assert rep["momento"] == "hablando" and rep["t"] == 50.0


# ---------- emociones (léxico) ----------
def test_nunca_feliz_ni_orgullosa_en_una_mala_noticia():
    """D5/D11: con una mala noticia la cara nunca sonríe de más."""
    malas = ["Tus ventas bajaron un 10% esta semana.", "La campaña está pausada por falta de presupuesto.",
             "Hubo un error al publicar el anuncio.", "Ahora mismo no tengo acceso a tu negocio.",
             "Your sales dropped this week.", "The campaign failed to launch."]
    for f in malas:
        assert clasificar(f)[0] == "preocupada", f


def test_buenas_noticias_orgullosa_y_saludos_feliz():
    assert clasificar("Vendiste 30 pedidos, tu mejor semana.")[0] == "orgullosa"
    assert clasificar("Tus ventas subieron un 15%.")[0] == "orgullosa"
    assert clasificar("Así tu negocio crece sin que pierdas tiempo.")[0] == "orgullosa"
    assert clasificar("¡Hola! ¿En qué te ayudo?")[0] == "feliz"
    assert clasificar("¿Quieres que la reactive?")[0] == "curiosa"
    assert clasificar("Déjame revisar tus campañas.")[0] == "pensativa"
    assert clasificar("No te entendí bien, ¿me lo repites?")[0] == "confundida"
    assert clasificar("El reporte tiene cuatro columnas.")[0] == "neutral"


def test_negacion_no_es_mala_noticia():
    assert clasificar("No hay ningún problema con tu cuenta.")[0] != "preocupada"
    assert clasificar("Las ventas no bajaron.")[0] != "preocupada"


def test_despues_del_problema_la_solucion_es_optimista():
    """D5: preocupación siempre con solución — la frase con el plan se ve positiva."""
    e = Emociones()
    assert e.frase("La campaña está pausada.")[0] == "preocupada"
    assert e.frase("Podemos reactivarla hoy mismo con un presupuesto menor.")[0] == "feliz"


def test_al_terminar_de_hablar_no_parpadea_a_reposo():
    """Coherencia: al terminar la respuesta pasa directo a escucha (la ventana llega justo después), sin flash de reposo."""
    d, s, _ = nuevo()
    d.evento(ev("voz/turno_inicio", 1.0)); d.evento(ev("voz/turno_fin", 3.0))
    d.evento(ev("oido/evento", 3.15, tipo="ventana", abierta_hasta=23.15))
    assert [m for m, _ in momentos(s)] == ["hablando", "escucha"]


def test_sin_ventana_vuelve_a_reposo():
    """Si la conversación no queda abierta (sin palabra/ventana 0), descansa enseguida."""
    d, s, _ = nuevo()
    d.evento(ev("voz/turno_inicio", 1.0)); d.evento(ev("voz/turno_fin", 3.0))
    d.tic(4.3)
    assert momentos(s)[-1][0] == "reposo"


def test_cada_frase_trae_un_gesto_y_la_herramienta_viaja_a_la_cara():
    """v2 (sesión real): no hablar 'congelada' — un gesto por frase; y la cara sabe QUÉ herramienta usa (ícono)."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 1.0, tipo="pregunta", turno="T"))
    d.evento(ev("ale/evento", 1.1, tipo="herramienta_inicio", turno="T", nombre="mcp__saleads__saleads_get_results"))
    assert [m for m in s if m["tema"] == "cuerpo/momento"][-1]["herramienta"] == "mcp__saleads__saleads_get_results"
    d.evento(ev("voz/turno_inicio", 2.0))
    d.evento(ev("voz/frase", 2.0, texto="Todo bien."))
    d.evento(ev("voz/frase", 3.0, texto="¿Quieres verlo?"))
    gestos = [m for m in s if m["tema"] == "cuerpo/gesto"]
    assert [(g["t"], g["pregunta"]) for g in gestos] == [(2.0, False), (3.0, True)]


def test_charla_casual_ya_no_queda_neutral():
    """v2 (sesión real: 69 % neutral): las frases conversacionales de Ale tienen emoción."""
    for f in ["Estoy bien, gracias por preguntar.", "Todo en orden por aquí, qué bueno que te gusta.",
              "Me alegra que te guste, aquí estoy para apoyarte.", "Claro, con gusto te ayudo."]:
        assert clasificar(f)[0] == "feliz", f


def test_texto_listo_antes_que_la_voz_no_pasa_por_reposo():
    """E2E local 29-oct: Ale termina el texto antes de que suene la voz; la cara no debe 'descansar' en medio."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 1.0, tipo="pregunta", turno="T"))
    d.evento(ev("ale/evento", 2.0, tipo="primer_token", turno="T"))
    d.evento(ev("ale/evento", 2.1, tipo="fin", turno="T"))
    d.evento(ev("voz/turno_inicio", 2.4))
    assert [m for m, _ in momentos(s)] == ["pensando", "hablando"]


def test_fin_sin_texto_si_vuelve_a_escuchar():
    """Si Ale no mandó nada (respuesta vacía), la cara no se queda pensando."""
    d, s, _ = nuevo()
    d.evento(ev("ale/evento", 1.0, tipo="pregunta", turno="T"))
    d.evento(ev("ale/evento", 2.0, tipo="fin", turno="T"))
    assert momentos(s)[-1][0] in ("reposo", "escucha")


def test_frases_reales_que_antes_quedaban_neutras():
    """Sesiones reales en la Pi: lo cálido y los logros se notan, lo negativo no se ve feliz."""
    assert clasificar("Soy Ale y me pone contenta trabajar contigo.")[0] == "feliz"
    assert clasificar("Tu página ya quedó publicada en versión 6.")[0] == "orgullosa"
    assert clasificar("En los últimos 30 días el gasto es cero y los resultados son cero.")[0] == "preocupada"
    assert clasificar("Tu página sigue publicada en versión 6.")[0] == "neutral"
    assert clasificar("Si vendiste por fuera, dime por dónde.")[0] != "orgullosa"


def test_intencion_de_la_frase():
    from cuerpo.emociones import intencion
    assert intencion("Si quieres te detallo por marca.") == "ofrece"
    assert intencion("Abre este enlace y pon el monto mensual:") == "muestra"
    assert intencion("Tu página sigue publicada.") is None
