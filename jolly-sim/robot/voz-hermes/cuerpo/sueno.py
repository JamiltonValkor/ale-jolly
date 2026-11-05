"""Dormir de verdad: mientras Jolly duerme no hay sesión con Muse ni micrófono abierto, así no se gasta cuota de Meta.

La voz decide. Pedidos: cara/toque {accion} (botón o tecla) y las señales SIGUSR1 (dormir) y SIGUSR2 (despertar), que
usa ale-robot/jolly.sh para hacerlo por SSH. La respuesta es cuerpo/sueno {orden}: la cara anima y avisa con cara/sueno.
Dormido se recuerda en disco: un reinicio del servicio o de la Pi no lo despierta ni vuelve a gastar Meta.
"""
import pathlib, queue, signal, threading, time

from cuerpo import bus

MARCA = pathlib.Path(__file__).resolve().parent.parent / "grabaciones" / "dormido"


class Sueno:
    def __init__(self, marca: pathlib.Path = MARCA):
        self.marca = marca
        self.dormido = marca.exists()
        self.pedidos: queue.SimpleQueue = queue.SimpleQueue()
        self.al_cambiar = None                   # canal_robot le avisa al servidor con HiloEventos.avisar_estado

    def pedir(self, accion: str):
        self.pedidos.put(accion)                 # SimpleQueue: se puede llamar desde un manejador de señal

    def aplicar(self, accion: str):
        if accion not in ("dormir", "despertar") or self.dormido == (accion == "dormir"):
            return
        self.dormido = accion == "dormir"
        self.marca.touch() if self.dormido else self.marca.unlink(missing_ok=True)
        bus.publicar("cuerpo/sueno", orden=accion)
        if self.al_cambiar:
            self.al_cambiar(self.dormido)
        print("😴 Jolly duerme: sin micrófono ni Meta" if self.dormido else "☀️  Jolly despierta", flush=True)

    def _atender(self, sub):
        prox = 0.0
        while True:
            for m in sub.recibir(100):
                self.pedir(m.get("accion"))
            while not self.pedidos.empty():
                self.aplicar(self.pedidos.get())
            if self.dormido and time.monotonic() >= prox:    # la cara puede arrancar después: se le repite
                bus.publicar("cuerpo/sueno", orden="dormir")
                prox = time.monotonic() + 1.0

    def escuchar(self):
        sub = bus.Suscriptor(("cara/toque",), bus.DIRECCION_CARA)
        threading.Thread(target=self._atender, args=(sub,), daemon=True, name="sueno").start()
        if hasattr(signal, "SIGUSR1"):                   # Windows no tiene SIGUSR1/2: ahí se duerme solo con la cara
            signal.signal(signal.SIGUSR1, lambda *_: self.pedir("dormir"))
            signal.signal(signal.SIGUSR2, lambda *_: self.pedir("despertar"))

    def esperar_despierto(self):
        while self.dormido:
            time.sleep(0.2)
