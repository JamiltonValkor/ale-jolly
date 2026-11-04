"""Pantalla de conteo (IVB-011, R13). Cada prueba nombra la regla que garantiza.
SDL_VIDEODRIVER=dummy python -m pytest pruebas_conteo.py -q"""
import json, os, socket, subprocess, sys, time
from pathlib import Path
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame
import pytest
import zmq

from conteo import PantallaConteo
from controlador import Controlador

pygame.init()
pygame.display.set_mode((64, 64))
ROJO, AZUL = (200, 0, 0), (0, 0, 200)


def es(pixel, color):
    """Escalar redondea unos valores: se compara con tolerancia."""
    return all(abs(a - b) <= 8 for a, b in zip(pixel[:3], color))


@pytest.fixture
def imagen(tmp_path):
    """Mitad izquierda roja, derecha azul: permite ver el giro."""
    s = pygame.Surface((1280, 720))
    s.fill(ROJO)
    s.fill(AZUL, (640, 0, 640, 720))
    ruta = tmp_path / "pantalla.png"
    pygame.image.save(s, str(ruta))
    return ruta


def msg(ruta, sid="s1", expira=100.0):
    return {"solicitud_id": sid, "ruta_pantalla": str(ruta), "total": 16, "expira": expira}


def contando(veces):
    def cargar(ruta):
        veces.append(ruta)
        return pygame.image.load(ruta)
    return cargar


def test_republicar_la_misma_solicitud_no_vuelve_a_leer_disco(imagen):
    veces = []
    p = PantallaConteo(cargar=contando(veces))
    for i in range(10):
        p.actualizar(msg(imagen, expira=100.0 + i))
    assert len(veces) == 1 and p.expira == 109.0
    p.actualizar(msg(imagen, sid="s2"))
    assert len(veces) == 2


def test_ruta_inexistente_se_registra_una_vez_y_sigue_la_cara(tmp_path, capsys):
    p = PantallaConteo()
    for _ in range(5):
        p.actualizar(msg(tmp_path / "nada.png"))
    assert capsys.readouterr().out.count("no pude abrir") == 1
    assert not p.activa(0.0)


def test_al_vencer_vuelve_sola_sin_mensajes_nuevos(imagen):
    p = PantallaConteo()
    p.actualizar(msg(imagen, expira=15.0))
    assert p.activa(14.9) and not p.activa(15.0)


@pytest.mark.parametrize("tam", [(480, 320), (1280, 720), (960, 640)])
def test_reescala_contra_la_superficie_real(imagen, tam):
    p, sup = PantallaConteo(), pygame.Surface(tam)
    p.actualizar(msg(imagen))
    p.dibujar(sup)
    assert p.lista.get_size() == tam
    y = tam[1] // 2
    assert es(sup.get_at((tam[0] // 4, y)), ROJO) and es(sup.get_at((3 * tam[0] // 4, y)), AZUL)


def test_cada_cuadro_es_un_blit_sin_reescalar(imagen, monkeypatch):
    p, sup = PantallaConteo(), pygame.Surface((960, 640))
    p.actualizar(msg(imagen))
    p.dibujar(sup)
    llamadas = []
    monkeypatch.setattr(pygame.transform, "smoothscale", lambda *a: llamadas.append(a))
    for _ in range(30):
        p.dibujar(sup)
    assert llamadas == []


def test_cambiar_de_ventana_reajusta(imagen):
    p = PantallaConteo()
    p.actualizar(msg(imagen))
    p.dibujar(pygame.Surface((480, 320)))
    p.dibujar(pygame.Surface((1280, 720)))
    assert p.lista.get_size() == (1280, 720)


def test_emparejamiento_tiene_prioridad_sobre_el_conteo(imagen):
    c, sup = Controlador(1), pygame.Surface((480, 320))
    c.conteo.actualizar(msg(imagen))
    c.pantalla_encima(sup, 1.0)
    assert es(sup.get_at((120, 160)), ROJO)                            # par: sin vincular pendiente, se ve el conteo
    sup.fill((0, 0, 0))
    c.emparejamiento({"estado": "mostrando", "codigo": "K7QM-3XPA", "url": "https://x.test/v", "expira": 100.0}, 1.0)
    c.pantalla_encima(sup, 1.0)
    assert not es(sup.get_at((120, 160)), ROJO) and sup.get_at((120, 160))[:3] != (0, 0, 0)


def test_el_controlador_sigue_calculando_debajo(imagen):
    c = Controlador(1)
    c.conteo.actualizar(msg(imagen))
    c.momento("hablando", 1.0)
    assert c.cuadro(1.2) and c.nombre_momento == "hablando"


def _puerto():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cara:
    """main.py de verdad, con SDL dummy, y un `ojo` falso que publica en su puerto."""

    def __init__(self, tmp_path, **env):
        self.puertos = [_puerto() for _ in range(3)]
        self.ctx = zmq.Context.instance()
        self.pub = self.ctx.socket(zmq.PUB)
        self.pub.setsockopt(zmq.LINGER, 0)
        self.pub.bind(f"tcp://127.0.0.1:{self.puertos[2]}")
        self.voz = self.ctx.socket(zmq.PUB)
        self.voz.setsockopt(zmq.LINGER, 0)
        self.voz.bind(f"tcp://127.0.0.1:{self.puertos[0]}")
        self.salida = tmp_path / "cuadros"
        self.registro = tmp_path / "reg.jsonl"
        self.env = {**os.environ, "SDL_VIDEODRIVER": "dummy", "SDL_AUDIODRIVER": "dummy", "ALE_BUS": f"tcp://127.0.0.1:{self.puertos[0]}",
                    "ALE_BUS_CARA": f"tcp://127.0.0.1:{self.puertos[1]}", "ALE_BUS_OJO": f"tcp://127.0.0.1:{self.puertos[2]}", **env}
        self.lanzar()

    def lanzar(self):
        self.p = subprocess.Popen([sys.executable, "main.py", "--bus", "--duracion", "20", "--fps", "30", "--cuadro-conteo", str(self.salida), "--registro", str(self.registro)],
                                  cwd=Path(__file__).parent, env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def publicar(self, ruta, sid="s1", dur=30.0):
        m = {"tema": "ojo/conteo", "solicitud_id": sid, "ruta_pantalla": str(ruta), "total": 16, "expira": time.monotonic() + dur}
        self.pub.send_multipart([b"ojo/conteo", json.dumps(m).encode()])

    def empareja(self):
        m = {"tema": "robot/emparejamiento", "estado": "mostrando", "codigo": "K7QM-3XPA", "url": "https://x.test/v", "expira": time.monotonic() + 30}
        self.voz.send_multipart([b"robot/emparejamiento", json.dumps(m).encode()])

    def esperar(self, ruta, s=12):
        fin = time.monotonic() + s
        archivo = self.salida / f"{ruta}.png"
        while time.monotonic() < fin and not archivo.exists():
            self.publicar(self.fuente, ruta)
            time.sleep(0.1)
        time.sleep(0.1)
        return archivo

    def cerrar(self):
        self.p.kill()
        self.p.wait(5)
        self.pub.close(0)
        self.voz.close(0)


def test_respeta_el_giro_de_la_pantalla(tmp_path, imagen):
    cara = Cara(tmp_path, ALE_CARA_GIRO="180")
    cara.fuente = imagen
    try:
        archivo = cara.esperar("s1")
        s = pygame.image.load(str(archivo))
        w, h = s.get_size()
        assert es(s.get_at((w // 4, h // 2)), AZUL) and es(s.get_at((3 * w // 4, h // 2)), ROJO)
    finally:
        cara.cerrar()


def test_sin_giro_y_una_cara_reiniciada_vuelve_a_mostrar_el_conteo(tmp_path, imagen):
    cara = Cara(tmp_path)
    cara.fuente = imagen
    try:
        assert cara.esperar("s1").exists()
        cara.p.kill(); cara.p.wait(5)
        (cara.salida / "s1.png").unlink()
        cara.lanzar()
        archivo = cara.esperar("s1")                                 # la republicación de ojo la recupera
        s = pygame.image.load(str(archivo))
        assert es(s.get_at((s.get_width() // 4, s.get_height() // 2)), ROJO)
    finally:
        cara.cerrar()
