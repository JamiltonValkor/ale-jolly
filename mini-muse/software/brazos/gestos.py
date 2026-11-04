"""gestos.yaml: cargar, validar, guardar (atómico con .bak) y reproducir gestos pose a pose sobre los límites reales."""
import os, shutil, tempfile, threading, time

import yaml

AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA = os.environ.get("ALE_GESTOS_YAML", os.path.join(AQUI, "gestos.yaml"))
NO_TOCAR = 999


class GestoInvalido(ValueError):
    pass


def validar(nombre: str, g: dict):
    poses = g.get("poses")
    if not poses:
        raise GestoInvalido(f"{nombre}: sin poses")
    for p in poses:
        if len(p) != 3 or not isinstance(p[0], (int, float)) or not 40 <= p[0] <= 5000:
            raise GestoInvalido(f"{nombre}: cada pose es [ms 40–5000, der%, izq%]")
        for v in p[1:]:
            if v is not None and not -100 <= v <= 100:
                raise GestoInvalido(f"{nombre}: los % van de −100 a 100 (o vacío = no tocar)")


def cargar(ruta: str = RUTA) -> dict:
    with open(ruta, encoding="utf-8") as f:
        datos = yaml.safe_load(f)
    for n, g in datos["gestos"].items():
        validar(n, g)
    for clave, lista in datos.get("complementos", {}).items():
        for n in lista:
            if n not in datos["gestos"]:
                raise GestoInvalido(f"complemento {clave} usa un gesto que no existe: {n}")
    return datos


def guardar_gesto(nombre: str, gesto: dict, ruta: str = RUTA):
    validar(nombre, gesto)
    datos = cargar(ruta)
    datos["gestos"][nombre] = gesto
    with open(ruta, encoding="utf-8") as f:
        cabecera = "".join(l for l in f if l.startswith("#"))
    shutil.copy2(ruta, ruta + ".bak")
    fd, tmp = tempfile.mkstemp(prefix="gestos.", suffix=".yaml", dir=os.path.dirname(ruta) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(cabecera)
        yaml.safe_dump({"gestos": datos["gestos"], "complementos": datos.get("complementos", {})}, f,
                       allow_unicode=True, sort_keys=False, default_flow_style=None, width=140)
    os.replace(tmp, ruta)


def escalar(p, intensidad: float):
    return NO_TOCAR if p is None else max(-100.0, min(100.0, p * intensidad))


class Reproductor:
    """Reproduce un gesto en un hilo, cancelable. `b` = arduino.Brazos (o simulado); `lock` protege el puerto."""

    def __init__(self, b, lock=None):
        self.b, self.lock = b, lock or threading.Lock()
        self._parar = threading.Event()
        self._hilo = None
        self.actual = None

    def reproducir(self, gesto: dict, intensidad: float = 1.0, velocidad: float = 1.0, nombre: str = ""):
        self.detener()
        self._parar = threading.Event()
        self.actual = nombre
        self._hilo = threading.Thread(target=self._correr, args=(gesto, intensidad, velocidad, self._parar), daemon=True)
        self._hilo.start()

    def detener(self):
        self._parar.set()
        if self._hilo and self._hilo is not threading.current_thread():
            self._hilo.join(timeout=0.5)
        self.actual = None

    def ocupado(self) -> bool:
        return bool(self._hilo and self._hilo.is_alive())

    def _correr(self, g, intensidad, velocidad, parar):
        while True:
            for ms, d, i in g["poses"]:
                if parar.is_set():
                    return
                dur = max(40, int(ms / max(velocidad, 0.1)))
                with self.lock:
                    self.b.mover(escalar(d, intensidad), escalar(i, intensidad), dur)
                if parar.wait(dur / 1000):
                    return
            if not g.get("bucle"):
                return
