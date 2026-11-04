"""Pruebas de dormir: el dinero de Meta se deja de gastar de verdad.   .venv/bin/python -m pytest cuerpo/pruebas_sueno.py -q
Sin red ni micrófono: Muse y la tarjeta son falsos, la sesión es la real.
"""
import asyncio, json, os, pathlib, signal, sys, tempfile, threading, time, types

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, AQUI)

import pytest                      # noqa: E402

import voz_hermes as vh            # noqa: E402
from cuerpo import bus             # noqa: E402
from cuerpo.sueno import Sueno     # noqa: E402

MARCA = pathlib.Path(tempfile.mkdtemp()) / "dormido"


@pytest.fixture(autouse=True)
def sin_marca():
    MARCA.unlink(missing_ok=True)


class Muse:
    def __init__(self):
        self.enviados, self.cerrada = 0, False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        self.cerrada = True

    async def send(self, b):
        if isinstance(b, bytes):
            self.enviados += 1

    async def recv(self):
        return json.dumps({"sessionId": "falsa"})

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(3600)


def correr(monkeypatch, sueno, locutor=None):
    muse, mic = Muse(), {"abierto": False}
    monkeypatch.setattr(vh.websockets, "connect", lambda *a, **k: muse)

    async def microfono(cola):
        mic["abierto"] = True
        try:
            while True:
                await cola.put(bytes(480)); await asyncio.sleep(0.01)
        finally:
            mic["abierto"] = False
    monkeypatch.setattr(vh, "fuente_microfono", microfono)
    args = types.SimpleNamespace(sin_palabra=True, palabra=[], keywords=[], archivo=None, locutor=locutor,
                                 webhook=None, cliente_hermes=None, ventana=20, sueno=sueno)
    hilo = threading.Thread(target=lambda: asyncio.run(vh.sesion(args, "x")), daemon=True)
    hilo.start()
    return muse, mic, hilo


def test_dormir_cierra_meta_y_microfono(monkeypatch):
    """Regla del dueño: dormido no se gasta Meta. Sale de la sesión, cierra el socket y no manda un byte más."""
    s = Sueno(MARCA)
    muse, mic, hilo = correr(monkeypatch, s)
    time.sleep(0.3)
    assert muse.enviados > 0 and mic["abierto"]
    s.aplicar("dormir")
    hilo.join(1.5)
    assert not hilo.is_alive() and muse.cerrada and not mic["abierto"]
    n = muse.enviados
    time.sleep(0.3)
    assert muse.enviados == n


def test_termina_de_hablar_antes_de_dormir(monkeypatch):
    """No se corta una respuesta a la mitad: cierra cuando el locutor queda libre."""
    loc = types.SimpleNamespace(oc=True, ocupado=lambda cola_s=0.6: loc.oc)
    s = Sueno(MARCA)
    _, _, hilo = correr(monkeypatch, s, loc)
    time.sleep(0.2)
    s.aplicar("dormir")
    hilo.join(0.6)
    assert hilo.is_alive()
    loc.oc = False
    hilo.join(1.5)
    assert not hilo.is_alive()


def test_ordenes_a_la_cara_una_sola_vez():
    q = bus.escuchar_local()
    s = Sueno(MARCA)
    for a in ("dormir", "dormir", "raro", "despertar", "despertar"):
        s.aplicar(a)
    time.sleep(0.05)
    msgs = []
    while not q.empty():
        msgs.append(q.get())
    assert [m["orden"] for m in msgs if m["tema"] == "cuerpo/sueno"] == ["dormir", "despertar"]


def test_senales_y_espera_para_jolly_sh():
    """Sin táctil, jolly.sh por SSH debe dormir y despertar; dormido, la voz no abre sesión hasta despertar."""
    s = Sueno(MARCA)
    s.escuchar()
    os.kill(os.getpid(), signal.SIGUSR1)
    time.sleep(0.4)
    assert s.dormido
    fin = threading.Event()
    threading.Thread(target=lambda: (s.esperar_despierto(), fin.set()), daemon=True).start()
    assert not fin.wait(0.3)
    os.kill(os.getpid(), signal.SIGUSR2)
    assert fin.wait(1)


def test_dormido_sobrevive_al_reinicio(tmp_path):
    """Regla del dueño: un reinicio no lo despierta ni vuelve a gastar Meta."""
    m = tmp_path / "dormido"
    s = Sueno(m)
    assert not s.dormido
    s.aplicar("dormir")
    assert Sueno(m).dormido
    s.aplicar("despertar")
    assert not Sueno(m).dormido
