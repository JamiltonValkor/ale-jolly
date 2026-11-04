"""Bus propio de `ojo`: PUB en 5562 y SUB a la voz en 5560. No importa `cuerpo/bus.py`: atar 5560 lo dejaría mudo, y con
ALE_BUS=…5562 su Suscriptor dejaría de oír la voz. Por eso declara las dos direcciones sin tocar esas variables.
Solo viajan rutas y números, nunca bytes de imagen."""
import json, os, socket, sys, threading, time

import zmq

BUS_VOZ = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
BUS_OJO = os.environ.get("ALE_BUS_OJO", "tcp://127.0.0.1:5562")


def exigir_libre(direccion: str = BUS_OJO):
    host, puerto = direccion.removeprefix("tcp://").rsplit(":", 1)
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, int(puerto)))
        except OSError:
            sys.exit(f"❌ Ya hay otro ojo corriendo en este equipo ({direccion}).")


class BusOjo:
    def __init__(self, pub: str = BUS_OJO, sub: str = BUS_VOZ):
        ctx = zmq.Context.instance()
        self.candado, self.seq = threading.Lock(), 0
        self.pub = ctx.socket(zmq.PUB)
        self.pub.setsockopt(zmq.LINGER, 0)
        self.pub.bind(pub)
        self.sub = ctx.socket(zmq.SUB)
        self.sub.setsockopt(zmq.LINGER, 0)
        self.sub.setsockopt(zmq.SUBSCRIBE, b"ojo/orden")
        self.sub.connect(sub)

    def publicar(self, tema: str, **datos):
        ahora = time.monotonic()
        with self.candado:
            self.seq += 1
            msg = {"tema": tema, "t": ahora, "t_pub": ahora, "seq": self.seq, **datos}
            try:
                self.pub.send_multipart([tema.encode(), json.dumps(msg, ensure_ascii=False).encode()], flags=zmq.NOBLOCK)
            except zmq.ZMQError:
                pass

    def recibir(self, espera_ms: int = 200) -> dict | None:
        if not self.sub.poll(espera_ms):
            return None
        _, cuerpo = self.sub.recv_multipart()
        try:
            return json.loads(cuerpo)
        except ValueError:
            return None

    def cerrar(self):
        self.pub.close(0)
        self.sub.close(0)
