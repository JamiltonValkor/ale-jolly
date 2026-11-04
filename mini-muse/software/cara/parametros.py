"""Modelo de parámetros de la cara de Ale (fiel a Muse/Jolly). Una cara = dict plano {nombre: float}.

Plano y simple a propósito: se interpola, se le aplica jitter y se escribe en YAML sin clases.
Prefijos: `oi.` ojo izquierdo, `od.` ojo derecho (de la pantalla), `boca.`, y globales.
`ojos.X` en una expresión se aplica a los dos ojos (los ángulos se espejan para que sea simétrico).
"""

OJO = {
    "abierto": 1.0,      # 0 cerrado (línea) … 1 abierto (parpadeo escala esto)
    "escala": 1.0,       # tamaño del ojo
    "sup": 0.0,          # párpado superior: 0 no tapa … 1 tapa hasta el centro
    "sup_ang": 0.0,      # grados; + baja el lado de adentro (decidida) · − sube el de adentro (preocupada)
    "sup_curva": 0.0,    # + el borde del párpado se curva hacia abajo en el centro
    "inf": 0.0,          # párpado inferior: 0 no tapa … 1 tapa hasta el centro
    "inf_curva": 0.0,    # + el borde sube en el centro → ojito feliz ^ ^
}

GLOBAL = {
    "mirada_x": 0.0,     # −1 … 1  (±15 px)
    "mirada_y": 0.0,     # −1 … 1  (±10 px; + abajo)
    "giro": 0.0,         # −1 … 1  giro de Jolly simulado (la cara se desliza; el ojo del lado crece)
    "ladeo": 0.0,        # grados: la cara entera se inclina un poquito (curiosa)
    "subir": 0.0,        # px; respiración / rebote
    "rubor": 1.0,        # 0 … 1.6 intensidad del rubor
    "boca.sonrisa": 1.0,   # 0 recta … 1 sonrisa de referencia … 1.4 sonrisa grande (nunca negativa: D5)
    "boca.apertura": 0.0,  # 0 cerrada … 1 abierta (hablar / sorpresa)
    "boca.ancho": 1.0,     # factor de ancho
    "boca.lado": 0.0,      # −1 … 1 boca corrida a un lado ("mmm")
    "boca.tilt": 0.0,      # grados de inclinación de la boca
}

NEUTRA = {**GLOBAL, **{f"oi.{k}": v for k, v in OJO.items()}, **{f"od.{k}": v for k, v in OJO.items()}}

LIMITES = {
    "abierto": (0.0, 1.2), "escala": (0.6, 1.4), "sup": (0.0, 1.0), "inf": (0.0, 1.0),
    "sup_ang": (-30.0, 30.0), "sup_curva": (-1.0, 1.0), "inf_curva": (-0.5, 1.5),
    "mirada_x": (-1.0, 1.0), "mirada_y": (-1.0, 1.0), "giro": (-1.0, 1.0), "ladeo": (-15.0, 15.0),
    "subir": (-12.0, 12.0), "rubor": (0.0, 1.6), "boca.sonrisa": (0.0, 1.5), "boca.apertura": (0.0, 1.0),
    "boca.ancho": (0.5, 1.6), "boca.lado": (-1.0, 1.0), "boca.tilt": (-20.0, 20.0),
}


def _limite(k: str):
    return LIMITES.get(k) or LIMITES.get(k.split(".", 1)[-1])


def acotar(c: dict) -> dict:
    out = {}
    for k, v in c.items():
        lim = _limite(k)
        out[k] = min(max(v, lim[0]), lim[1]) if lim else v
    return out


def expandir(expr: dict) -> dict:
    """Pasa una expresión escrita con atajos (`ojos.sup_ang`) a la cara completa (sobre NEUTRA)."""
    c = dict(NEUTRA)
    for k, v in expr.items():
        if k.startswith("ojos."):
            p = k[5:]
            c[f"oi.{p}"] = v
            c[f"od.{p}"] = v          # el render espeja el lado "de adentro", así que el mismo valor es simétrico
        elif k in c:
            c[k] = float(v)
        else:
            raise KeyError(f"parámetro desconocido: {k}")
    return acotar(c)


def claves(expr: dict) -> dict:
    """Solo las claves que la expresión menciona (con `ojos.` expandido), sin rellenar con NEUTRA."""
    out = {}
    for k, v in expr.items():
        if k.startswith("ojos."):
            out[f"oi.{k[5:]}"] = out[f"od.{k[5:]}"] = float(v)
        elif k in NEUTRA:
            out[k] = float(v)
        else:
            raise KeyError(f"parámetro desconocido: {k}")
    return out


def mezclar(a: dict, b: dict, f: float) -> dict:
    return {k: a[k] + (b[k] - a[k]) * f for k in a}
