"""Proceso del robot que cuenta. Recibe órdenes de Stock (R11), toma la foto de la fuente elegida, llama a SAM, numera,
deja la pantalla y entrega JSON e imagen. Nunca decide cuándo contar ni interpreta el resultado (R12). Va en su propio
proceso y venv porque el audio pelea por el GIL: decodificar imagen en la voz cortaría a Jolly.

  ALE_CAMARA=carpeta:$PWD/pruebas/manifiesto-minimo.json python -m ojo --una-vez --concepto jar --etiqueta frascos
"""
import argparse, hashlib, http.client, io, json, os, queue, random, shutil, threading, time, urllib.error, urllib.request
from pathlib import Path

from PIL import Image

import camara as fuentes
import numerar
import sam as cliente_sam
from bus_ojo import BusOjo, exigir_libre

AQUI = Path(__file__).resolve().parent
LADO_LARGO = 1600
PANTALLA_S = float(os.environ.get("ALE_OJO_PANTALLA_S", "15"))
REPUBLICA_S = 1.5
RETENCION_DIAS = 7
UA = "Mozilla/5.0 (X11; Linux) ale-robot/1.0"
RUTA = "/devices/me/stream"
PANTALLA = tuple(int(n) for n in os.environ.get("ALE_OJO_PANTALLA", "1280x720").split("x"))   # modo real de la Pi
CONTENT_TYPE = "image/jpeg"
# La Pi sale por el hotspot de un teléfono que comparte con el Mac. Despierta, la voz sube audio sin parar a Muse y en
# los bajones del enlace móvil la cola crece: el RTT pasa de 5 ms a ~1 s y una subida suelta muere. Por eso cada paso
# se reintenta con espera creciente dentro de un plazo, y el tiempo de espera de cada intento crece con el tamaño.
PISO_BPS = 16_000                                    # peor subida que aún tiene sentido esperar (B/s)
TIEMPO_MIN_S = 15.0
PLAZO_SUBIDA_S = float(os.environ.get("ALE_OJO_PLAZO_SUBIDA_S", "150"))   # la URL firmada vive 300 s
ESPERAS_S = (1, 2, 4, 8, 15, 30)
NO_REINTENTAR = {400, 401, 404, 413}                 # pedido mal hecho, credencial o foto inexistente: repetir no ayuda
FALLOS_RED = (OSError, http.client.HTTPException, ValueError, KeyError)   # HTTPError y timeouts son OSError


class SinOriginal(Exception):
    pass


class ErrorSubida(Exception):
    pass


def tiempo_para(tam: int) -> float:
    """Tiempo de espera de un intento: lo que tardaría `tam` bytes al piso de subida, con margen."""
    return max(TIEMPO_MIN_S, 10.0 + tam / PISO_BPS)


def causa(error: BaseException) -> str:
    """Para el log: tipo y código HTTP. Nunca la URL, que lleva la firma."""
    return f"HTTP {error.code}" if isinstance(error, urllib.error.HTTPError) else type(error).__name__


def con_reintentos(paso: str, accion, plazo_s: float = PLAZO_SUBIDA_S, dormir=time.sleep, reloj=time.monotonic):
    """Repite `accion()` ante fallos de red o 5xx/408/409/429 hasta el plazo. 400/401/404/413 salen al primer intento."""
    fin, intento = reloj() + plazo_s, 0
    while True:
        try:
            return accion()
        except FALLOS_RED as error:
            if isinstance(error, urllib.error.HTTPError) and error.code in NO_REINTENTAR:
                raise
            espera = ESPERAS_S[min(intento, len(ESPERAS_S) - 1)] * random.uniform(0.8, 1.2)
            intento += 1
            if reloj() + espera >= fin:
                print(f"⚠️ ojo: {paso} falló {intento} veces ({causa(error)}); me rindo", flush=True)
                raise
            print(f"⚠️ ojo: {paso} falló ({causa(error)}); intento {intento + 1} en {espera:.0f} s", flush=True)
            dormir(espera)


def leer_env(ruta: Path) -> dict[str, str]:
    """Se lee en cada uso: el token cambia al reemparejar. Nada de esto va a logs."""
    valores = {}
    try:
        for linea in ruta.read_text().splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                k, v = linea.split("=", 1)
                valores[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return valores


class Nube:
    """Cliente propio: `ojo` es otro proceso y no tiene `_req` de la voz."""

    def __init__(self, env: Path, plazo_s: float | None = None, dormir=time.sleep):
        self.env, self.dormir = env, dormir
        self.plazo_s = PLAZO_SUBIDA_S if plazo_s is None else plazo_s

    def _valor(self, nombre: str) -> str:
        return leer_env(self.env).get(nombre) or os.environ.get(nombre, "")

    def _op1(self, cuerpo: dict) -> dict:
        req = urllib.request.Request(self._valor("ALE_RUNTIME_URL").rstrip("/") + RUTA, data=json.dumps(cuerpo).encode(), method="POST", headers={
            "Authorization": f"Bearer {self._valor('ALE_DEVICE_TOKEN')}", "Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")

    def op(self, cuerpo: dict) -> dict:
        """photo_done y photo_failed son idempotentes en el servidor: repetirlos tras un corte no duplica nada."""
        return con_reintentos(cuerpo.get("op", "op"), lambda: self._op1(cuerpo), self.plazo_s, self.dormir)

    def _subir1(self, rol: str, solicitud: str, datos: bytes):
        """Un intento: firma nueva (la anterior pudo vencer) y PUT con tiempo según el tamaño."""
        firma = self._op1({"op": "photo_url", "request_id": solicitud, "role": rol, "content_type": CONTENT_TYPE})
        req = urllib.request.Request(firma["url"], data=datos, method="PUT", headers={"Content-Type": firma["content_type"], "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=tiempo_para(len(datos))) as r:
            r.read()

    def subir(self, rol: str, solicitud: str, datos: bytes):
        t0 = time.monotonic()
        con_reintentos(f"subida {rol}", lambda: self._subir1(rol, solicitud, datos), self.plazo_s, self.dormir)
        print(f"📤 ojo: {rol} {len(datos) // 1024} KB en {time.monotonic() - t0:.1f} s", flush=True)

    def clave_meta(self) -> str:
        return self._valor("META_API_KEY")


def reducir(datos: bytes, lado: int = LADO_LARGO) -> bytes:
    with Image.open(io.BytesIO(datos)) as i:
        foto = i.convert("RGB")
    foto.thumbnail((lado, lado), Image.LANCZOS)
    salida = io.BytesIO()
    foto.save(salida, "JPEG", quality=85)
    return salida.getvalue()


def limpiar(datos: Path, dias: int = RETENCION_DIAS, ahora: float | None = None):
    """Retención local. Solo entra a `datos/`: grabaciones vive en voz-hermes y no se toca."""
    limite = (ahora or time.time()) - dias * 86400
    for hija in datos.glob("*"):
        if hija.is_dir() and hija.name != "muse" and hija.stat().st_mtime < limite:
            shutil.rmtree(hija, ignore_errors=True)


class Ojo:
    def __init__(self, bus, nube, camara, datos: Path, contar=cliente_sam.contar, pantalla=PANTALLA, reloj=time.monotonic):
        self.bus, self.nube, self.camara, self.datos = bus, nube, camara, datos
        self.contar, self.pantalla, self.reloj = contar, pantalla, reloj
        self.cola: queue.Queue = queue.Queue()
        self.vistas: set[str] = set()
        self.conteo: dict | None = None
        self.candado = threading.Lock()

    def estado(self, solicitud: str, estado: str, **extra):
        self.bus.publicar("ojo/estado", solicitud_id=solicitud, estado=estado, **extra)

    def orden(self, m: dict):
        """Llega en cualquier momento: confirma ya y hace cola. Una reentrega responde sin tomar otra foto."""
        solicitud = m.get("solicitud_id")
        if not solicitud:
            return
        self.estado(solicitud, "recibida")
        if solicitud in self.vistas:
            return
        self.vistas.add(solicitud)
        self.cola.put(m)

    def republicar(self):
        with self.candado:
            c = self.conteo
            if c and self.reloj() >= c["expira"]:
                self.conteo = c = None
        if c:
            self.bus.publicar("ojo/conteo", **c)

    def atender(self, m: dict):
        solicitud, t0, tiempos = m["solicitud_id"], time.monotonic(), {}
        marca = lambda nombre: tiempos.__setitem__(nombre, round((time.monotonic() - t0) * 1000))
        try:
            carpeta = self.datos / solicitud
            carpeta.mkdir(parents=True, exist_ok=True)
            self.estado(solicitud, "capturando")
            if m.get("foto_id"):
                base = self.datos / m["foto_id"]
                try:
                    meta = json.loads((base / "meta.json").read_text())
                    enviada = (base / "enviada.jpg").read_bytes()
                except (OSError, ValueError) as error:
                    raise SinOriginal from error
                fuente, sha = meta["fuente"], meta["sha256"]
            else:
                captura = self.camara.capturar()
                enviada = reducir(captura.datos)
                fuente, sha = captura.fuente, captura.sha256
                (carpeta / "enviada.jpg").write_bytes(enviada)
                (carpeta / "meta.json").write_text(json.dumps({"fuente": fuente, "sha256": sha}))
            marca("captura")
            self.estado(solicitud, "contando")
            crudo = self.contar(enviada, m["concepto"], self.nube.clave_meta())
            marca("sam")
            objetos = numerar.ordenar(numerar.filtrar(crudo["objetos"]))
            with Image.open(io.BytesIO(enviada)) as i:
                foto = i.convert("RGB")
            pantalla, numerada = numerar.salidas(foto, objetos, m["etiqueta"], carpeta, self.pantalla)
            marca("numerar")
            with self.candado:
                self.conteo = {"solicitud_id": solicitud, "estado": "mostrando", "ruta_pantalla": str(pantalla), "total": len(objetos), "expira": self.reloj() + PANTALLA_S}
            self.republicar()
            resultado = {"concepto": m["concepto"], "total": len(objetos), "objetos": objetos, "ms": crudo["ms"]}
            if self.nube:
                try:
                    if not m.get("foto_id"):
                        self.nube.subir("original", solicitud, enviada)
                    self.nube.subir("numerada", solicitud, numerada.read_bytes())
                    marca("subida")
                    self.nube.op({"op": "photo_done", "request_id": solicitud, "sam": resultado, "tiempos": tiempos, "fuente": fuente, "imagen_sha256": sha})
                except FALLOS_RED as error:
                    raise ErrorSubida(causa(error)) from error
            self.estado(solicitud, "subida", tiempos=tiempos)
            return resultado
        except Exception as error:
            motivo = {fuentes.ErrorCamara: "camara", cliente_sam.ErrorSam: "sam", ErrorSubida: "subida", SinOriginal: "sin_original"}.get(type(error), "desconocido")
            print(f"⚠️ ojo: {motivo} ({type(error).__name__}{': ' + str(error) if motivo == 'subida' else ''})", flush=True)
            self.estado(solicitud, "error", motivo=motivo)
            if self.nube:
                try:
                    self.nube.op({"op": "photo_failed", "request_id": solicitud, "motivo": motivo})
                except Exception as e:
                    print(f"⚠️ ojo: no pude reportar el fallo ({type(e).__name__})", flush=True)

    def trabajar(self):
        while True:
            self.atender(self.cola.get())

    def correr(self):
        threading.Thread(target=self.trabajar, daemon=True, name="ojo-trabajo").start()
        ultimo, limpio = 0.0, 0.0
        while True:
            m = self.bus.recibir(200)
            if m:
                self.orden(m)
            ahora = time.monotonic()
            if ahora - ultimo >= REPUBLICA_S:
                self.republicar()
                ultimo = ahora
            if ahora - limpio >= 3600:
                limpiar(self.datos)
                limpio = ahora


class BusNulo:
    def publicar(self, *a, **k):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--una-vez", action="store_true", help="cuenta una foto sin bus ni servidor e imprime el JSON")
    ap.add_argument("--concepto")
    ap.add_argument("--etiqueta", default="productos")
    ap.add_argument("--env", default=str(AQUI.parent / "voz-hermes" / ".env"))
    ap.add_argument("--datos", default=str(AQUI / "datos"))
    a = ap.parse_args()
    datos = Path(a.datos)
    datos.mkdir(parents=True, exist_ok=True)
    nube = Nube(Path(a.env))
    camara = fuentes.abrir(clave=nube.clave_meta, cache=datos / "muse")
    if a.una_vez:
        class SoloClave:
            clave_meta = staticmethod(nube.clave_meta)
            __bool__ = lambda self: False
        ojo = Ojo(BusNulo(), SoloClave(), camara, datos)
        print(json.dumps(ojo.atender({"solicitud_id": f"una-vez-{hashlib.sha1(str(time.time()).encode()).hexdigest()[:8]}", "concepto": a.concepto, "etiqueta": a.etiqueta}), ensure_ascii=False))
        return
    exigir_libre()
    limpiar(datos)
    Ojo(BusOjo(), nube, camara, datos).correr()


if __name__ == "__main__":
    main()
