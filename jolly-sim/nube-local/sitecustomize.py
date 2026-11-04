"""Solo para el ojo de Jolly contra la pila local (start.sh lo pone en su PYTHONPATH).

ale-runtime firma las subidas de fotos para `storage.googleapis.com`, como en producción. Dentro de Docker ese nombre
llega a cloud-sim por Caddy; el ojo corre en este computador, así que aquí ese nombre va a Caddy (ALE_STORAGE_LOCAL,
por defecto 127.0.0.1:8443) y se confía en la CA local (ALE_CA_CERT). El resto del tráfico (SAM, Muse) no cambia.
"""
import os
import socket
import ssl

_HOST = "storage.googleapis.com"
_destino = os.environ.get("ALE_STORAGE_LOCAL", "127.0.0.1:8443").rsplit(":", 1)
_IP, _PUERTO = _destino[0], int(_destino[1])
_CA = os.environ.get("ALE_CA_CERT", "")
_original = socket.getaddrinfo


def _getaddrinfo(host, port, *args, **kwargs):
    if host == _HOST:
        return _original(_IP, _PUERTO, *args, **kwargs)
    return _original(host, port, *args, **kwargs)


def _contexto(*args, **kwargs):
    contexto = ssl.create_default_context(*args, **kwargs)
    if _CA and os.path.isfile(_CA):
        contexto.load_verify_locations(_CA)
    return contexto


socket.getaddrinfo = _getaddrinfo
ssl._create_default_https_context = _contexto
