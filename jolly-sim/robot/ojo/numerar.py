"""Filtra lo que devuelve SAM, lo numera en orden de lectura y dibuja dos salidas: `pantalla.png` para la cara y
`numerada.jpg` para Stock. La confianza y las cajas no se reinterpretan: quien entiende la escena es Stock (R12)."""
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MIN_CONF = float(os.environ.get("ALE_OJO_MIN_CONF", "0.5"))
IOU_DUPLICADA = 0.9
TOPE_NUMEROS = 40
FUENTES = [Path(__file__).with_name("DejaVuSans-Bold.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
           Path("/Library/Fonts/Arial Bold.ttf"), Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")]
FONDO, TINTA, DISCO, TEXTO = (250, 246, 240), (60, 45, 40), (214, 40, 87), (255, 255, 255)


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def filtrar(objetos: list[dict], minimo: float = MIN_CONF) -> list[dict]:
    """Sin confianza se conserva: filtrar lo que no trae el dato sería inventarlo. Casi idénticas cuentan una."""
    vivos = [o for o in objetos if o.get("confianza") is None or o["confianza"] >= minimo]
    vivos.sort(key=lambda o: -(o.get("confianza") or 0))
    salida: list[dict] = []
    for o in vivos:
        if all(iou(o["caja"], s["caja"]) <= IOU_DUPLICADA for s in salida):
            salida.append(o)
    return salida


def ordenar(objetos: list[dict]) -> list[dict]:
    """Filas por centro Y con tolerancia de media altura, luego X. Numera desde 1."""
    if not objetos:
        return []
    altos = sorted(o["caja"][3] - o["caja"][1] for o in objetos)
    tolerancia = altos[len(altos) // 2] / 2
    filas: list[list[dict]] = []
    for o in sorted(objetos, key=lambda o: (o["caja"][1] + o["caja"][3]) / 2):
        cy = (o["caja"][1] + o["caja"][3]) / 2
        if filas:
            fila = filas[-1]
            media = sum((x["caja"][1] + x["caja"][3]) / 2 for x in fila) / len(fila)
            if cy - media <= tolerancia:
                fila.append(o)
                continue
        filas.append([o])
    salida = []
    for fila in filas:
        for o in sorted(fila, key=lambda o: o["caja"][0]):
            salida.append({"n": len(salida) + 1, "caja": o["caja"], "confianza": o.get("confianza")})
    return salida


def fuente(tam: int):
    for ruta in FUENTES:
        if ruta.exists():
            return ImageFont.truetype(str(ruta), tam)
    return ImageFont.load_default(tam)


def _recorte(objetos: list[dict], tam: tuple[int, int], margen: float = 0.08) -> tuple[int, int, int, int]:
    """Unión de las cajas con margen, para que la foto gane escala. Sin objetos, la imagen entera."""
    w, h = tam
    if not objetos:
        return 0, 0, w, h
    x1, y1 = min(o["caja"][0] for o in objetos), min(o["caja"][1] for o in objetos)
    x2, y2 = max(o["caja"][2] for o in objetos), max(o["caja"][3] for o in objetos)
    mx, my = (x2 - x1) * margen + 8, (y2 - y1) * margen + 8
    return max(0, int(x1 - mx)), max(0, int(y1 - my)), min(w, int(x2 + mx)), min(h, int(y2 + my))


def dibujar(imagen: Image.Image, objetos: list[dict], etiqueta: str, tam: tuple[int, int], escala_base: float | None = None) -> Image.Image:
    """Lienzo de `tam`: encabezado «Conté N etiqueta» y foto recortada con discos numerados en el centro de cada caja."""
    w, h = tam
    k = escala_base or min(w / 480, h / 320)
    alto_titulo = round(36 * k)
    lienzo = Image.new("RGB", tam, FONDO)
    d = ImageDraw.Draw(lienzo)
    d.text((round(12 * k), alto_titulo / 2), f"Conté {len(objetos)} {etiqueta}", fill=TINTA, font=fuente(round(24 * k)), anchor="lm")
    x0, y0, x1, y1 = _recorte(objetos, imagen.size)
    factor = min(w / (x1 - x0), (h - alto_titulo) / (y1 - y0))
    vista = imagen.crop((x0, y0, x1, y1)).resize((max(1, round((x1 - x0) * factor)), max(1, round((y1 - y0) * factor))), Image.LANCZOS)
    ox, oy = (w - vista.width) // 2, alto_titulo + (h - alto_titulo - vista.height) // 2
    lienzo.paste(vista, (ox, oy))
    numeros = len(objetos) <= TOPE_NUMEROS
    # ~22 px de diámetro a 480×320; con pocos objetos crece, porque el panel mide 73,4 mm y se lee a 40 cm.
    celda = ((w * (h - alto_titulo)) / max(1, len(objetos))) ** 0.5
    radio = round(max(11 * k, min(20 * k, 0.22 * celda))) if numeros else round(4 * k)
    letra = fuente(round(radio * 1.15))
    for o in objetos:
        cx = ox + ((o["caja"][0] + o["caja"][2]) / 2 - x0) * factor
        cy = oy + ((o["caja"][1] + o["caja"][3]) / 2 - y0) * factor
        d.ellipse((cx - radio, cy - radio, cx + radio, cy + radio), fill=DISCO, outline=TEXTO, width=max(1, round(k)))
        if numeros:
            d.text((cx, cy), str(o["n"]), fill=TEXTO, font=letra, anchor="mm")
    return lienzo


def salidas(imagen: Image.Image, objetos: list[dict], etiqueta: str, carpeta: Path, pantalla: tuple[int, int]) -> tuple[Path, Path]:
    ruta_p, ruta_n = carpeta / "pantalla.png", carpeta / "numerada.jpg"
    dibujar(imagen, objetos, etiqueta, pantalla).save(ruta_p)
    ancho = max(1600, imagen.width)
    tam = (ancho, round(ancho * imagen.height / imagen.width) + round(36 * ancho / 480))
    dibujar(imagen, objetos, etiqueta, tam, escala_base=ancho / 960).save(ruta_n, quality=85)
    return ruta_p, ruta_n
