"""Pruebas de lo propio de jolly-sim: el Locutor de Linux (cambio 3), el recorte redactado y el reproductor."""
import json, re, subprocess, sys
from pathlib import Path

import pytest

AQUI = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AQUI / "robot" / "voz-hermes"))
sys.path.insert(0, str(AQUI / "replay"))

import recortar, reproducir                            # noqa: E402
import voz_salida                                      # noqa: E402

TRAZA = AQUI / "replay" / "traza-2026-11-02-p2.jsonl"


def locutor(monkeypatch, motor):
    import shutil
    monkeypatch.setattr(shutil, "which", lambda m: f"/usr/bin/{m}" if m == motor else None)
    dichas = []
    monkeypatch.setattr(voz_salida.subprocess, "run", lambda orden, check=False: dichas.append(orden))
    return voz_salida.LocutorEspeak(), dichas


@pytest.mark.parametrize("motor,esperada", [
    ("espeak-ng", ["espeak-ng", "-v", "es-419", "-s", "165", "Hola, soy Jolly."]),
    ("spd-say", ["spd-say", "-w", "-l", "es", "Hola, soy Jolly."]),
])
def test_locutor_espeak_habla_con_el_motor_que_hay(monkeypatch, motor, esperada):
    loc, dichas = locutor(monkeypatch, motor)
    loc.decir("**Hola**, soy Jolly.")
    loc.esperar()
    assert dichas == [esperada]
    assert not loc.ocupado(cola_s=0)


def test_locutor_espeak_sin_motor_no_rompe_y_suelta_el_turno(monkeypatch):
    loc, dichas = locutor(monkeypatch, None)
    loc.decir("Hola.")
    loc.esperar()
    assert dichas == [] and not loc.hablando.is_set()


def test_el_mapeo_de_tiempos_es_monotono_y_corta_lo_quieto():
    mover = recortar.mapeador([(100.0, 110.0), (200.0, 205.0)])
    assert mover(100.0) == 0 and mover(110.0) == 10
    assert mover(150.0) == 11.0 == mover(200.0)          # dentro del corte cae al inicio del tramo siguiente
    assert mover(205.0) == 16.0 and mover(999.0) == 17.0


def test_el_fragmento_no_trae_datos_sensibles():
    texto = TRAZA.read_text(encoding="utf-8")
    assert "/home/" + "pi" not in texto
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", texto)   # ids reales
    for l in texto.splitlines()[1:]:
        m = json.loads(l)
        assert not m["tema"].startswith(("cara/", "oido/"))
        assert "t_rec" not in m and "seq" not in m
        if m["tema"] == "ale/evento" and m.get("tipo") == "pregunta":
            assert m["texto"] == recortar.REDACTADO


def test_el_reproductor_resuelve_la_pantalla_y_la_etiqueta():
    meta, msgs = reproducir.cargar(TRAZA)
    assert reproducir.etiqueta(meta) == "REPLAY · traza real del 2-nov-2026"
    rutas = {m["ruta_pantalla"] for m in msgs if "ruta_pantalla" in m}
    assert rutas and all(Path(r).is_file() for r in rutas)
    assert [m["t_pub"] for m in msgs] == sorted(m["t_pub"] for m in msgs)
    assert any(m["tema"] == "voz/frase" for m in msgs) and any(m["tema"] == "ojo/conteo" for m in msgs)
