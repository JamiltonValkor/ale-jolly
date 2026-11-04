"""Bus de mensajes del cuerpo de Ale (ZeroMQ PUB/SUB). Contrato: cuerpo/CONTRATO.md.

- publicar(tema, **datos): no bloquea nunca. Lo envía un solo hilo emisor dueño del socket PUB (los sockets ZeroMQ no
  son thread-safe y en el proceso de voz publican varios hilos). Si el puerto está ocupado, queda en modo mudo.
- escuchar_local(): cola en memoria con todo lo que este proceso publica (así el director, que vive en el proceso de
  voz, recibe los eventos sin pasar por TCP).
- Suscriptor(temas): para otros procesos (cara, grabador). recibir() vacía lo pendiente sin bloquear.

Cada mensaje: dos partes [tema, JSON]. El JSON lleva tema, t (hora monotónica en que ocurre o DEBE ocurrir; puede ser
futura), t_pub (hora de envío), seq (por emisor) y los datos.
"""
import json, os, queue, socket, sys, threading, time

import zmq

DIRECCION = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
DIRECCION_CARA = os.environ.get("ALE_BUS_CARA", "tcp://127.0.0.1:5561")   # la cara publica cara/estado aquí
DIRECCION_OJO = os.environ.get("ALE_BUS_OJO", "tcp://127.0.0.1:5562")     # ojo publica ojo/* aquí, con su propio PUB

_cola: queue.SimpleQueue = queue.SimpleQueue()
_locales: list[queue.SimpleQueue] = []
_lock = threading.Lock()
_hilo = None
_seq = 0
mudo = False


def _emisor():
    global mudo
    ctx = zmq.Context.instance()
    pub = ctx.socket(zmq.PUB)
    pub.setsockopt(zmq.LINGER, 0)
    pub.setsockopt(zmq.SNDHWM, 10000)
    try:
        pub.bind(DIRECCION)
    except zmq.ZMQError as e:
        mudo = True
        print(f"   ⚠️ bus: no pude abrir {DIRECCION} ({e}); sigo sin publicar", file=sys.stderr, flush=True)
    while True:
        tema, cuerpo = _cola.get()
        if not mudo:
            try:
                pub.send_multipart([tema.encode(), cuerpo], flags=zmq.NOBLOCK)
            except zmq.ZMQError:
                pass                                  # sin oyentes o cola llena: se descarta, nunca se bloquea


def exigir_libre():
    """Sale con un error claro si otro robot ya es dueño del bus: un segundo proceso quedaría mudo y su código nunca
    llegaría a la cara. Se prueba con un socket normal porque cerrarlo libera el puerto al instante."""
    host, puerto = DIRECCION.removeprefix("tcp://").rsplit(":", 1)
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, int(puerto)))
        except OSError:
            sys.exit(f"❌ Ya hay otro robot corriendo en este equipo ({DIRECCION}). Ciérralo antes de arrancar este.")


def _arrancar():
    global _hilo
    with _lock:
        if _hilo is None:
            _hilo = threading.Thread(target=_emisor, daemon=True, name="bus-emisor")
            _hilo.start()


def publicar(tema: str, t: float | None = None, **datos) -> dict:
    """Publica un mensaje. `t` por defecto = ahora. Devuelve el mensaje (útil para registros/pruebas)."""
    global _seq
    _arrancar()
    ahora = time.monotonic()
    with _lock:
        _seq += 1
        seq = _seq
    msg = {"tema": tema, "t": ahora if t is None else t, "t_pub": ahora, "seq": seq, **datos}
    _cola.put((tema, json.dumps(msg, ensure_ascii=False).encode()))
    for q in list(_locales):
        q.put(msg)
    return msg


def escuchar_local() -> queue.SimpleQueue:
    """Cola en memoria que recibe todo lo que este proceso publique de aquí en adelante."""
    q: queue.SimpleQueue = queue.SimpleQueue()
    _locales.append(q)
    return q


class Suscriptor:
    """SUB de ZeroMQ. `temas` = prefijos ("" = todo). Conecta en el acto; usar recibir() en el bucle propio."""

    def __init__(self, temas=("",), direccion: str | list[str] = DIRECCION):
        self.sock = zmq.Context.instance().socket(zmq.SUB)
        self.sock.setsockopt(zmq.LINGER, 0)
        self.sock.setsockopt(zmq.RCVHWM, 10000)
        for t in temas:
            self.sock.setsockopt(zmq.SUBSCRIBE, t.encode())
        for d in ([direccion] if isinstance(direccion, str) else direccion):
            self.sock.connect(d)

    def recibir(self, espera_ms: int = 0, maximo: int = 1000) -> list[dict]:
        """Devuelve los mensajes pendientes (espera hasta `espera_ms` por el primero)."""
        out = []
        if espera_ms and not self.sock.poll(espera_ms):
            return out
        while len(out) < maximo:
            try:
                _, cuerpo = self.sock.recv_multipart(flags=zmq.NOBLOCK)
            except zmq.Again:
                break
            try:
                out.append(json.loads(cuerpo))
            except ValueError:
                continue
        return out

    def cerrar(self):
        self.sock.close(0)
