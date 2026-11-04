"""¿Hay internet? La cara lo revisa sola: sin red la voz no puede arrancar y por el bus no llegaría ningún aviso."""
import os, socket, threading, time

DESTINO = os.environ.get("ALE_RED_DESTINO", "api.cartesia.ai:443")
CADA_S, ESPERA_S, FALLOS = 5.0, 3.0, 2        # dos fallos seguidos: un bache de wifi no asusta a nadie


class Red:
    def __init__(self, destino: str = DESTINO):
        self.host, puerto = destino.rsplit(":", 1)
        self.puerto = int(puerto)
        self.fallos = 0

    @property
    def caida(self) -> bool:
        return self.fallos >= FALLOS

    def revisar(self):
        try:
            socket.create_connection((self.host, self.puerto), ESPERA_S).close()
            self.fallos = 0
        except OSError:
            self.fallos += 1

    def vigilar(self):
        def bucle():
            while True:
                self.revisar()
                time.sleep(CADA_S)
        threading.Thread(target=bucle, daemon=True, name="red").start()
