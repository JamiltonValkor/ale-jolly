"""brazos.yaml: cargar, validar y guardar de forma atómica con respaldo (como safe_write_config de HESed)."""
import os, shutil, tempfile

import yaml

AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA = os.environ.get("ALE_BRAZOS_YAML", os.path.join(AQUI, "brazos.yaml"))
CAMPOS = ("minimo_us", "reposo_us", "maximo_us")
BRAZOS = ("derecho", "izquierdo")


class CalibracionInvalida(ValueError):
    pass


def validar_brazo(nombre: str, b: dict):
    """Lo que SIEMPRE debe cumplirse (también a medio alinear): pulsos enteros dentro del rango físico."""
    for k in CAMPOS:
        if not isinstance(b.get(k), int) or not 100 <= b[k] <= 2900:
            raise CalibracionInvalida(f"{nombre}.{k} debe ser un entero entre 100 y 2900 µs")


def validar_orden(nombre: str, b: dict):
    """Para usar los límites (mover por %) y para marcar calibrado: el reposo entre mínimo y máximo."""
    validar_brazo(nombre, b)
    mn, rp, mx = (b[k] for k in CAMPOS)
    if not (min(mn, mx) <= rp <= max(mn, mx)):
        raise CalibracionInvalida(f"{nombre}: el reposo ({rp}) debe quedar entre mínimo ({mn}) y máximo ({mx})")
    if mx == rp:
        raise CalibracionInvalida(f"{nombre}: el máximo no puede ser igual al reposo")


def cargar(ruta: str = RUTA) -> dict:
    with open(ruta, encoding="utf-8") as f:
        datos = yaml.safe_load(f) or {}
    for n in BRAZOS:
        validar_brazo(n, datos["brazos"][n])
    return datos


def guardar(datos: dict, ruta: str = RUTA):
    for n in BRAZOS:
        validar_brazo(n, datos["brazos"][n])
    carpeta = os.path.dirname(ruta) or "."
    if os.path.exists(ruta):
        shutil.copy2(ruta, ruta + ".bak")
    with open(ruta, encoding="utf-8") as f:
        cabecera = "".join(l for l in f if l.startswith("#"))
    fd, tmp = tempfile.mkstemp(prefix="brazos.", suffix=".yaml", dir=carpeta)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(cabecera)
            f.write("brazos:\n")
            for n in BRAZOS:
                b = datos["brazos"][n]
                f.write(f"  {n + ':':<10} {{pin: {b.get('pin', 'A0')}, minimo_us: {b['minimo_us']}, reposo_us: {b['reposo_us']}, "
                        f"maximo_us: {b['maximo_us']}, calibrado: {str(bool(b.get('calibrado'))).lower()}}}\n")
        os.replace(tmp, ruta)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def fijar(nombre: str, campo: str, valor: int, ruta: str = RUTA) -> dict:
    """Guarda un punto (minimo_us / reposo_us / maximo_us) de un brazo; al cambiar un límite deja de estar calibrado."""
    if nombre not in BRAZOS or campo not in CAMPOS:
        raise CalibracionInvalida("brazo o campo desconocido")
    datos = cargar(ruta)
    datos["brazos"][nombre][campo] = int(valor)
    datos["brazos"][nombre]["calibrado"] = False
    guardar(datos, ruta)
    return datos


def marcar_calibrado(nombre: str, si: bool = True, ruta: str = RUTA) -> dict:
    datos = cargar(ruta)
    if si:
        validar_orden(nombre, datos["brazos"][nombre])
    datos["brazos"][nombre]["calibrado"] = bool(si)
    guardar(datos, ruta)
    return datos
