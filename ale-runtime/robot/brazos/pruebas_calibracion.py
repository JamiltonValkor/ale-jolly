"""BR-002: brazos.yaml es la única verdad y nunca queda en un estado inválido. pytest pruebas_calibracion.py"""
import pytest

import calibracion as c


@pytest.fixture
def ruta(tmp_path):
    p = tmp_path / "brazos.yaml"
    p.write_text("# prueba\nbrazos:\n  derecho:   {pin: A0, minimo_us: 1400, reposo_us: 1500, maximo_us: 1600, calibrado: false}\n"
                 "  izquierdo: {pin: A1, minimo_us: 1400, reposo_us: 1500, maximo_us: 1600, calibrado: false}\n")
    return str(p)


def test_guardar_punto_deja_respaldo_y_desmarca_calibrado(ruta):
    """Cada guardado deja .bak; cambiar un límite exige volver a confirmar la calibración."""
    c.marcar_calibrado("derecho", True, ruta)
    d = c.fijar("derecho", "maximo_us", 1700, ruta)
    assert d["brazos"]["derecho"]["maximo_us"] == 1700 and d["brazos"]["derecho"]["calibrado"] is False
    assert open(ruta + ".bak").read() != open(ruta).read()
    assert c.cargar(ruta)["brazos"]["derecho"]["maximo_us"] == 1700


def test_valor_invalido_se_rechaza_y_el_archivo_queda_intacto(ruta):
    """Nunca se guardan pulsos fuera de 100–2900 µs (rango de la librería Servo), y no se marca calibrado con el reposo fuera de [mín, máx]."""
    antes = open(ruta).read()
    with pytest.raises(c.CalibracionInvalida):
        c.fijar("izquierdo", "minimo_us", 50, ruta)
    assert open(ruta).read() == antes
    c.fijar("derecho", "reposo_us", 1900, ruta)              # a medio alinear se permite…
    with pytest.raises(c.CalibracionInvalida):
        c.marcar_calibrado("derecho", True, ruta)          # …pero no se puede dar por calibrado


def test_brazo_espejado_es_valido(ruta):
    """El izquierdo va espejado: el máximo puede ser MENOR que el reposo."""
    c.fijar("izquierdo", "minimo_us", 1800, ruta)
    c.fijar("izquierdo", "maximo_us", 1100, ruta)
    assert c.cargar(ruta)["brazos"]["izquierdo"]["maximo_us"] == 1100
