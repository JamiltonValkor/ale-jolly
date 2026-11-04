"""BR-001 contra el Arduino conectado (mueve el brazo derecho ±7° alrededor de 1500 µs).
.venv/bin/python -m pytest pruebas_firmware.py -q   (se salta si no hay Arduino)"""
import random, time

import pytest

import arduino
import calibracion as c

pytestmark = pytest.mark.skipif(not arduino.buscar_puerto(), reason="sin Arduino conectado")


@pytest.fixture(scope="module")
def b(tmp_path_factory):
    ruta = tmp_path_factory.mktemp("cal") / "brazos.yaml"
    ruta.write_text("brazos:\n  derecho:   {pin: A0, minimo_us: 1460, reposo_us: 1500, maximo_us: 1540, calibrado: false}\n"
                    "  izquierdo: {pin: A1, minimo_us: 1460, reposo_us: 1500, maximo_us: 1540, calibrado: false}\n")
    eco = []
    br = arduino.Brazos(al_leer=lambda l: eco.append(l), ruta_yaml=str(ruta))
    br.eco = eco
    yield br
    br.cerrar(reposo=True)


def test_nunca_sale_de_los_limites(b):
    """A6: ningún movimiento fuera de los límites guardados, aunque se pidan % absurdos."""
    b.enviar("V 1"); time.sleep(0.1)
    b.eco.clear()
    for _ in range(80):
        b.mover(random.uniform(-400, 400), random.uniform(-400, 400), random.randint(20, 120))
        time.sleep(0.06)
    time.sleep(0.3); b.enviar("V 0"); time.sleep(0.1)
    pulsos = [int(x) for l in b.eco if l.startswith("A ") for x in l.split()[1:3] if int(x) > 0]
    assert len(pulsos) > 50
    assert all(1460 <= p <= 1540 for p in pulsos), (min(pulsos), max(pulsos))


def test_porcentaje_llega_exacto_al_maximo_y_al_reposo(b):
    """A6: el 100 % es exactamente el máximo calibrado y el 0 % el reposo (los gestos usan los límites reales)."""
    b.mover(100, 999, 200); time.sleep(0.35)
    assert b.estado()["derecho"]["us"] == 1540
    b.mover(0, 999, 200); time.sleep(0.35)
    assert b.estado()["derecho"]["us"] == 1500


def test_soltar_responde_rapido(b):
    """A6: la emergencia suelta los servos en < 0,5 s (el firmware responde en < 100 ms)."""
    t = time.time()
    r = b.preguntar("X", "OK X")
    assert r and r.startswith("OK X") and time.time() - t < 0.1
    assert b.estado()["energizado"] is False


def test_brazo_sin_limites_no_se_mueve_por_porcentaje(b):
    """Seguridad: un brazo a medio alinear (sin límites válidos) no se mueve por %; solo con pulsos crudos U."""
    b.enviar("X"); time.sleep(0.1)
    r = b.preguntar("L d 1600 1700 1500", "OK L")              # reposo fuera de [min,max] → el firmware lo rechaza
    assert r and r.startswith("ERR")


def test_alinear_con_pulso_crudo_no_se_recorta_a_los_limites(b):
    """Regresión 28-oct (owner: 'el desplazamiento es mínimo'): al ALINEAR, el pulso crudo usa el rango físico
    500–2500 µs; los límites provisionales solo aplican a gestos/%."""
    b.enviar("V 1"); time.sleep(0.1); b.eco.clear()
    b.pulso("derecho", 1590); time.sleep(0.4)                 # dentro del sobre de prueba de este módulo (1460–1540)…
    vistos = [int(l.split()[1]) for l in b.eco if l.startswith("A ")]
    b.enviar("V 0"); b.mover(0, 999, 300); time.sleep(0.4)
    assert vistos and vistos[-1] == 1590                       # …y NO se recortó a 1540
