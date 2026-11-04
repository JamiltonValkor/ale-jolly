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


# ---- sembrar.py: el inventario demo de Stock ---------------------------------------------------------------------

def test_sembrar_casa_cada_oferta_de_la_semilla_con_una_de_saleads_sim():
    import yaml
    sys.path.insert(0, str(AQUI))
    import sembrar
    semilla = yaml.safe_load((AQUI.parent / "ale-runtime" / "robot" / "banco" / "semillas" / "masquebella-v1.yaml").read_text())
    ofertas = sembrar.ofertas(semilla["ofertas_por_nombre"])
    assert set(ofertas) == {p["oferta"] for p in semilla["productos"]}
    assert all(o["type"] in ("product", "service") and re.fullmatch(r"[0-9a-f-]{36}", o["id"]) for o in ofertas.values())
    assert len({o["id"] for o in ofertas.values()}) == len(ofertas)


def test_sembrar_sin_vincular_explica_que_falta(tmp_path, monkeypatch):
    sys.path.insert(0, str(AQUI))
    import sembrar
    monkeypatch.setattr(sembrar, "ENV_ROBOT", tmp_path / ".env")
    monkeypatch.setattr(sys, "argv", ["sembrar.py"])
    with pytest.raises(SystemExit, match="no está vinculado"):
        sembrar.main()


# ---- Windows: replay sin voz local y consola cp1252 ---------------------------------------------------------------

def test_replay_sin_voz_local_sigue_mudo_en_windows(monkeypatch):
    import shutil
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shutil, "which", lambda m: None)
    assert reproducir.locutor_local() is None


def test_doctor_no_exige_voz_en_replay(monkeypatch, capsys):
    import shutil
    sys.path.insert(0, str(AQUI))
    import doctor
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shutil, "which", lambda m: None)
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
    monkeypatch.setattr(doctor, "fallos", [])
    doctor.voz(obligatoria=False)
    assert doctor.fallos == [] and "sin voz local" in capsys.readouterr().out
    doctor.voz()
    assert doctor.fallos


def test_doctor_no_se_cae_con_la_consola_cp1252():
    import os
    env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
    r = subprocess.run([sys.executable, str(AQUI / "doctor.py"), "--help"], env=env, capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")
    r = subprocess.run([sys.executable, "-c", "import sys; sys.argv=['doctor']; sys.path.insert(0, %r); import doctor; doctor.ok('listo ✓')"
                        % str(AQUI)], env=env, capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")


def test_sembrar_vincula_en_la_terminal_y_guarda_solo_la_credencial(tmp_path, monkeypatch, capsys):
    import http.server, threading
    sys.path.insert(0, str(AQUI))
    import sembrar
    sondeos = []

    class Servidor(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            cuerpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/devices/pairing":
                resp = {"pairing_id": "p1", "code": "K7QM-3XPA", "poll_secret": "s", "expires_at": "2099-01-01T00:00:00Z"}
            else:
                assert self.path == "/devices/pairing/p1/poll" and cuerpo == {"poll_secret": "s"}
                sondeos.append(1)
                resp = {"status": "paired", "device_token": "ale_dev_nuevo", "device_id": "d1"} if len(sondeos) > 1 else {"status": "pending"}
            datos = json.dumps(resp).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(datos))); self.end_headers(); self.wfile.write(datos)

    srv = http.server.HTTPServer(("127.0.0.1", 0), Servidor)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = tmp_path / ".env"
    env.write_text("ALE_RUNTIME_URL=x\nALE_DEVICE_TOKEN=ale_dev_viejo\nALE_ROBOT_NAME=Jolly\n")
    monkeypatch.setattr(sembrar, "ENV_ROBOT", env)
    monkeypatch.setattr(sembrar.time, "sleep", lambda s: None)
    sembrar.vincular(f"http://127.0.0.1:{srv.server_address[1]}")
    srv.shutdown()
    assert "K7QM-3XPA" in capsys.readouterr().out
    assert env.read_text().splitlines() == ["ALE_RUNTIME_URL=x", "ALE_ROBOT_NAME=Jolly", "ALE_DEVICE_TOKEN=ale_dev_nuevo", "ALE_DEVICE_ID=d1"]
