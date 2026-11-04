"""De dónde sale la foto. `ALE_CAMARA` la elige, y todo lo que sigue es igual en todas:

  v4l2:/dev/video0                 cámara USB en la Pi
  avfoundation:0                   webcam del Mac
  carpeta:/ruta/manifiesto.json    imágenes del banco, con sha256 congelado
  muse:/ruta/escenas.json          Muse Image genera la escena y entra como lectura de cámara

`carpeta` y `muse` salen marcadas `fuente: simulada` y se niegan con ALE_ENTORNO=produccion. Muse no respeta la cantidad
pedida: el conteo real de cada imagen se verifica mirándola. La escena se elige con el archivo `escena_actual` junto al
manifiesto, o con ALE_ESCENA; si no, la primera.
"""
import base64, hashlib, json, os, subprocess, tempfile, urllib.request
from dataclasses import dataclass
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux) ale-robot/1.0"
MUSE_URL = "https://api.meta.ai/v1/images/generations"


class ErrorCamara(Exception):
    pass


@dataclass
class Captura:
    datos: bytes
    fuente: str
    sha256: str


def _sha(datos: bytes) -> str:
    return hashlib.sha256(datos).hexdigest()


def _escena(manifiesto: Path, ids: list[str]) -> int:
    archivo = manifiesto.with_name("escena_actual")
    pedida = os.environ.get("ALE_ESCENA") or (archivo.read_text().strip() if archivo.exists() else "")
    if not pedida:
        return 0
    if pedida not in ids:
        raise ErrorCamara(f"escena desconocida: {pedida}")
    return ids.index(pedida)


class Carpeta:
    def __init__(self, ruta: str):
        self.ruta = Path(ruta)

    def capturar(self) -> Captura:
        try:
            lista = json.loads(self.ruta.read_text())["imagenes"]
            e = lista[_escena(self.ruta, [i["id"] for i in lista])]
            datos = (self.ruta.parent / e["archivo"]).read_bytes()
        except (OSError, ValueError, KeyError, IndexError) as error:
            raise ErrorCamara(f"manifiesto ilegible: {type(error).__name__}") from error
        if _sha(datos) != e["sha256"]:
            raise ErrorCamara("la imagen no coincide con el sha256 del manifiesto")
        return Captura(datos, "simulada", e["sha256"])


class Muse:
    """Una escena se genera una vez: la caché evita pagar otra imagen y deja un conteo verificado estable."""

    def __init__(self, ruta: str, clave, cache: Path, url: str = MUSE_URL):
        self.ruta, self.clave, self.cache, self.url = Path(ruta), clave, cache, url

    def capturar(self) -> Captura:
        try:
            lista = json.loads(self.ruta.read_text())["escenas"]
            e = lista[_escena(self.ruta, [i["id"] for i in lista])]
            prompt = e["prompt"]
        except (OSError, ValueError, KeyError, IndexError) as error:
            raise ErrorCamara(f"escenas ilegibles: {type(error).__name__}") from error
        archivo = self.cache / f"{_sha(prompt.encode())[:24]}.jpg"
        if not archivo.exists():
            cuerpo = {"model": "muse-image-1.0", "prompt": prompt, "n": 1, "size": e.get("size", "1792x1024"), "output_format": "jpeg"}
            req = urllib.request.Request(self.url, data=json.dumps(cuerpo).encode(), method="POST", headers={
                "Authorization": f"Bearer {self.clave()}", "Content-Type": "application/json", "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    b64 = json.loads(r.read())["data"][0]["b64_json"]
            except Exception as error:
                raise ErrorCamara(f"Muse no generó la escena: {type(error).__name__}") from error
            self.cache.mkdir(parents=True, exist_ok=True)
            archivo.write_bytes(base64.b64decode(b64))
        datos = archivo.read_bytes()
        return Captura(datos, "simulada", _sha(datos))


class Ffmpeg:
    def __init__(self, formato: str, dispositivo: str):
        self.formato, self.dispositivo = formato, dispositivo

    def capturar(self) -> Captura:
        with tempfile.TemporaryDirectory() as t:
            salida = Path(t) / "foto.jpg"
            orden = ["ffmpeg", "-loglevel", "error", "-y", "-f", self.formato]
            orden += ["-framerate", "30"] if self.formato == "avfoundation" else []
            orden += ["-i", self.dispositivo, "-frames:v", "1", str(salida)]
            try:
                subprocess.run(orden, check=True, timeout=15, capture_output=True)
                datos = salida.read_bytes()
            except (OSError, subprocess.SubprocessError) as error:
                raise ErrorCamara(f"no pude capturar: {type(error).__name__}") from error
        return Captura(datos, "camara", _sha(datos))


def abrir(spec: str | None = None, entorno: str | None = None, clave=lambda: "", cache: Path | None = None):
    spec = spec if spec is not None else os.environ.get("ALE_CAMARA", "")
    entorno = entorno if entorno is not None else os.environ.get("ALE_ENTORNO", "")
    tipo, _, valor = spec.partition(":")
    if tipo in ("carpeta", "muse") and entorno == "produccion":
        raise SystemExit(f"❌ ALE_CAMARA={tipo}: es una fuente simulada y ALE_ENTORNO=produccion no la admite.")
    if tipo == "carpeta" and valor:
        return Carpeta(valor)
    if tipo == "muse" and valor:
        return Muse(valor, clave, cache or Path(__file__).with_name("datos") / "muse")
    if tipo == "v4l2" and valor:
        return Ffmpeg("v4l2", valor)
    if tipo == "avfoundation" and valor:
        return Ffmpeg("avfoundation", f"{valor}:none")
    raise SystemExit("❌ ALE_CAMARA debe ser v4l2:/dev/video0, avfoundation:0, carpeta:/ruta.json o muse:/ruta.json")
