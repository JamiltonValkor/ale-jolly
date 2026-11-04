"""Pruebas del bus (CV-001). Cada prueba dice qué regla garantiza.  .venv/bin/python -m pytest cuerpo/pruebas_bus.py -q"""
import json, os, subprocess, sys, textwrap, threading, time

import pytest

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable


def _correr(codigo: str, puerto: int, **kw) -> subprocess.Popen:
    env = {**os.environ, "ALE_BUS": f"tcp://127.0.0.1:{puerto}", "PYTHONPATH": AQUI}
    return subprocess.Popen([PY, "-c", textwrap.dedent(codigo)], env=env, cwd=AQUI,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kw)


PUBLICADOR = """
import time
from cuerpo import bus
bus.publicar("_arranque"); time.sleep(1.0)          # el SUB ya está conectado (slow-joiner)
# Espaciado de a uno: en ráfagas de 50, una sola pausa del sistema retrasa el 5 % de la muestra y mueve el p95.
for i in range(1000):
    bus.publicar("prueba/n", i=i)
    time.sleep(0.001)
time.sleep(0.5)
"""


def test_mil_mensajes_entre_procesos_sin_perdida_y_latencia_baja():
    """Regla: la cara recibe todo lo que el director publica, a tiempo (latencia local p95 < 2 ms)."""
    os.environ["ALE_BUS"] = "tcp://127.0.0.1:5570"
    from cuerpo.bus import Suscriptor
    sub = Suscriptor(("prueba/",), "tcp://127.0.0.1:5570")
    p = _correr(PUBLICADOR, 5570)
    recibidos, lat = [], []
    fin = time.monotonic() + 8
    while time.monotonic() < fin and len(recibidos) < 1000:
        for m in sub.recibir(espera_ms=100):
            recibidos.append(m["i"]); lat.append(time.monotonic() - m["t_pub"])
    p.wait(5); sub.cerrar()
    assert recibidos == list(range(1000))
    lat.sort()
    assert lat[int(len(lat) * 0.95)] < 0.002, f"p95={lat[int(len(lat)*0.95)]*1000:.2f} ms"


def test_cinco_hilos_publicando_a_la_vez_sin_errores_ni_mensajes_rotos():
    """Regla: en el proceso de voz publican varios hilos (Muse, SSE, Cartesia, audio) y nada se corrompe."""
    codigo = """
    import threading, time
    from cuerpo import bus
    bus.publicar("_arranque"); time.sleep(1.0)
    def f(k):
        for i in range(400): bus.publicar("prueba/h", hilo=k, i=i, relleno="x" * 200)
    hs = [threading.Thread(target=f, args=(k,)) for k in range(5)]
    [h.start() for h in hs]; [h.join() for h in hs]
    time.sleep(0.5); print("OK")
    """
    from cuerpo.bus import Suscriptor
    sub = Suscriptor(("prueba/",), "tcp://127.0.0.1:5571")
    p = _correr(codigo, 5571)
    msgs, fin = [], time.monotonic() + 8
    while time.monotonic() < fin and len(msgs) < 2000:
        msgs += sub.recibir(espera_ms=100)
    out, err = p.communicate(timeout=5); sub.cerrar()
    assert "OK" in out and "Traceback" not in err
    assert len(msgs) == 2000
    assert all(m["relleno"] == "x" * 200 for m in msgs)
    por_hilo = {k: [m["i"] for m in msgs if m["hilo"] == k] for k in range(5)}
    assert all(v == list(range(400)) for v in por_hilo.values())   # orden por hilo intacto
    assert len({m["seq"] for m in msgs}) == 2000


def test_puerto_ocupado_no_tumba_al_segundo_proceso():
    """Regla: si algo ya usa el puerto (otra voz abierta), la voz sigue funcionando en modo mudo."""
    dueno = _correr("from cuerpo import bus; import time; bus.publicar('x'); time.sleep(3)", 5572)
    time.sleep(0.8)
    segundo = _correr("""
    from cuerpo import bus; import time
    bus.publicar('x'); time.sleep(0.5)
    for i in range(10): bus.publicar('y', i=i)
    time.sleep(0.2); print('VIVO', bus.mudo)
    """, 5572)
    out, err = segundo.communicate(timeout=5)
    dueno.kill()
    assert "VIVO True" in out
    assert "Traceback" not in err
    assert err.count("no pude abrir") == 1          # avisa una sola vez


def test_publicar_sin_oyentes_no_bloquea():
    """Regla: la voz nunca depende de que la cara esté abierta."""
    p = _correr("""
    from cuerpo import bus; import time
    t = time.monotonic()
    for i in range(20000): bus.publicar('nadie/escucha', i=i)
    print('MS', (time.monotonic() - t) * 1000)
    """, 5573)
    out, _ = p.communicate(timeout=10)
    assert float(out.split("MS")[1]) < 2000         # 20 000 mensajes en < 2 s: nunca se queda esperando


def test_cola_local_recibe_lo_publicado_en_el_mismo_proceso():
    """Regla: el director (mismo proceso de voz) recibe los eventos por memoria, sin TCP."""
    from cuerpo import bus
    q = bus.escuchar_local()
    m = bus.publicar("oido/evento", tipo="habla_inicio", turno="t1")
    assert q.get(timeout=1) == m and m["t"] == m["t_pub"]
