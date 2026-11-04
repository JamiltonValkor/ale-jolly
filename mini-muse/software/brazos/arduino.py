"""Cliente USB del firmware de los brazos v2 (ver firmware_brazos.ino). Al conectar le envía los límites de
brazos.yaml (el Arduino no guarda nada). Posiciones en % de elevación: 0 reposo, 100 máximo, −100 mínimo."""
import glob, threading, time

import serial

import calibracion

NO_TOCAR = 999
LETRA = {"derecho": "d", "izquierdo": "i"}


class PuertoOcupado(RuntimeError):
    pass


def buscar_puerto() -> str | None:
    puertos = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*") + glob.glob("/dev/ttyACM*")
                     + glob.glob("/dev/ttyUSB*"))
    return puertos[0] if puertos else None


class Brazos:
    def __init__(self, puerto: str | None = None, al_leer=None, ruta_yaml: str = calibracion.RUTA):
        self.puerto = puerto or buscar_puerto()
        if not self.puerto:
            raise RuntimeError("no encuentro el Arduino (¿está conectado por USB?)")
        try:
            self.s = serial.Serial(self.puerto, 115200, timeout=0.1, exclusive=True)
        except serial.SerialException as e:
            raise PuertoOcupado("el Arduino lo está usando otro programa (cierra ./ale.sh, brazos.py o la web)") from e
        self.al_leer = al_leer
        self.lock = threading.Lock()
        self.respuestas: list[tuple[int, str]] = []   # (número de línea, texto); se guardan las últimas 200
        self.n_lineas = 0
        inicio, buf = time.time(), b""
        while time.time() - inicio < 4:                       # abrir el puerto reinicia el UNO: esperar "LISTO"
            buf += self.s.read(200)
            if b"LISTO" in buf:
                break
        self.version = buf.decode(errors="ignore").strip().splitlines()[-1] if buf else "?"
        self.vivo = True
        threading.Thread(target=self._leer, daemon=True).start()
        self.cargar_limites(ruta_yaml)

    def _leer(self):
        while self.vivo:
            try:
                linea = self.s.readline().decode(errors="ignore").strip()
            except (serial.SerialException, OSError, TypeError):
                self.vivo = False                          # USB desconectado: quien use esto debe reconectar
                return
            if linea:
                self.n_lineas += 1
                self.respuestas = (self.respuestas + [(self.n_lineas, linea)])[-200:]
                if self.al_leer:
                    self.al_leer(linea)

    def enviar(self, orden: str):
        if not self.vivo:
            raise serial.SerialException("el Arduino se desconectó")
        with self.lock:
            try:
                self.s.write((orden.strip() + "\n").encode())
            except (serial.SerialException, OSError) as e:
                self.vivo = False
                raise serial.SerialException("el Arduino se desconectó") from e

    def preguntar(self, orden: str, prefijo: str, espera: float = 0.6) -> str | None:
        n = self.n_lineas
        self.enviar(orden)
        fin = time.time() + espera
        while time.time() < fin:
            for i, r in self.respuestas:
                if i > n and (r.startswith(prefijo) or r.startswith("ERR")):
                    return r
            time.sleep(0.01)
        return None

    def cargar_limites(self, ruta_yaml: str = calibracion.RUTA):
        self.calib = calibracion.cargar(ruta_yaml)
        self.sin_limites = []
        for nombre, letra in LETRA.items():
            b = self.calib["brazos"][nombre]
            try:
                calibracion.validar_orden(nombre, b)
            except calibracion.CalibracionInvalida:
                self.sin_limites.append(nombre)          # a medio alinear: solo se mueve con pulsos crudos (U)
                continue
            r = self.preguntar(f"L {letra} {b['minimo_us']} {b['reposo_us']} {b['maximo_us']}", "OK L")
            if not r or r.startswith("ERR"):
                raise RuntimeError(f"el Arduino no aceptó los límites de {nombre}: {r}")

    def mover(self, der: float = NO_TOCAR, izq: float = NO_TOCAR, ms: int = 500):
        self.enviar(f"M {int(round(der))} {int(round(izq))} {int(ms)}")

    def pulso(self, brazo: str, us: int):
        self.enviar(f"U {LETRA[brazo]} {int(us)}")

    def soltar(self):
        self.enviar("X")

    def estado(self) -> dict | None:
        r = self.preguntar("E", "E ")
        if not r or not r.startswith("E "):
            return None
        d_us, i_us, d_p, i_p, en = (int(x) for x in r.split()[1:6])
        return {"derecho": {"us": d_us, "pct": d_p}, "izquierdo": {"us": i_us, "pct": i_p}, "energizado": bool(en)}

    def cerrar(self, reposo: bool = True):
        try:
            if reposo:
                self.mover(0, 0, 700); time.sleep(0.75)
            self.soltar(); time.sleep(0.05)
        finally:
            self.vivo = False
            self.s.close()
