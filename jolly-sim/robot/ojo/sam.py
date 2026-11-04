"""Cliente de SAM 3.1. Pide `stream:true`, lee deltas de texto y se queda solo con las cajas: las máscaras nunca salen de
aquí. Cero resultados es válido: el stream completa sin deltas. Formato: dev.meta.ai/docs/sam/reading-segmentation."""
import base64, json, re, socket, time, urllib.error, urllib.request

URL = "https://api.meta.ai/v1/responses"
UA = "Mozilla/5.0 (X11; Linux) ale-robot/1.0"
MODELO = "sam-3.1"
TIEMPO_S = 30
REINTENTOS = 1
_CAJA = re.compile(r"(?:^|,|<\d+f>)\s*(\d+)<\|box;([^|]*)\|>")


class ErrorSam(Exception):
    pass


def leer_stream(lineas) -> str:
    """Acumula `response.output_text.delta`. Un stream sin `response.completed` está cortado y no vale como cero."""
    texto, nombre, completo = [], None, False
    for crudo in lineas:
        linea = (crudo.decode("utf-8") if isinstance(crudo, bytes) else crudo).rstrip("\r\n")
        if linea.startswith("event:"):
            nombre = linea[6:].strip()
        elif linea.startswith("data:"):
            try:
                dato = json.loads(linea[5:].strip())
            except ValueError:
                continue
            tipo = dato.get("type") or nombre
            if tipo == "response.output_text.delta":
                texto.append(dato.get("delta", ""))
            elif tipo == "response.completed":
                completo = True
            elif tipo in ("response.failed", "error"):
                raise ErrorSam("SAM reportó un error")
    if not completo:
        raise ErrorSam("stream sin response.completed")
    return "".join(texto)


def parsear(texto: str) -> list[dict]:
    """Registros `id<|box;…|><|mask;…|>`. Campos por clave; `c` solo viene con include_confidence."""
    objetos = []
    for ident, campos in _CAJA.findall(texto):
        kv = dict(par.split("=", 1) for par in campos.split(";") if "=" in par)
        objetos.append({"id": int(ident), "caja": [float(kv[k]) for k in ("x1", "y1", "x2", "y2")],
                        "confianza": float(kv["c"]) if "c" in kv else None})
    return objetos


def cuerpo(imagen: bytes, concepto: str) -> dict:
    url = "data:image/jpeg;base64," + base64.b64encode(imagen).decode()
    return {"model": MODELO, "stream": True, "metadata": {"include_confidence": "true", "mask_encoding": "one_bit"},
            "input": [{"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": concepto}, {"type": "input_image", "image_url": url}]}]}


def contar(imagen: bytes, concepto: str, clave: str, url: str = URL, tiempo_s: float = TIEMPO_S, espera_s: float = 1.0) -> dict:
    """Devuelve {objetos, ms}. Con la red caída, reintenta una vez y sale con ErrorSam: nunca bloquea el proceso."""
    datos = json.dumps(cuerpo(imagen, concepto)).encode()
    t0, ultimo = time.monotonic(), None
    for intento in range(REINTENTOS + 1):
        if intento:
            time.sleep(espera_s)
        req = urllib.request.Request(url, data=datos, method="POST", headers={
            "Authorization": f"Bearer {clave}", "Content-Type": "application/json", "Accept": "text/event-stream", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=tiempo_s) as r:
                return {"objetos": parsear(leer_stream(r)), "ms": round((time.monotonic() - t0) * 1000)}
        except urllib.error.HTTPError as e:
            ultimo = f"HTTP {e.code}"
            if e.code < 500 and e.code != 429:
                break
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ErrorSam) as e:
            ultimo = type(e).__name__
    raise ErrorSam(ultimo or "sin respuesta")
