"""Recorta una traza del bus (salida de `cuerpo/grabar.py`, a menudo >100 MB) a un fragmento corto y redactado.

  python recortar.py bus.jsonl salida.jsonl --ventana 29985 30100 --ventana 30690 30772 \
      --fecha 2026-11-02 --descripcion "..." --pantalla /path/pantalla.png

- Deja solo lo que oye la cara (`cuerpo/*`, `voz/*`, `ojo/*`, `robot/emparejamiento`) y `ale/evento`. `cara/*` es la
  salida de la propia cara y `oido/*` lleva habla de la sala: ambos se descartan.
- Dentro de cada ventana corta los tramos quietos (solo latidos): cada segundo que queda está a pocos segundos de algo
  que el robot dijo, mostró o contó. Los tiempos se trasladan de forma monótona, así `t0`, `expira` y `abierta_hasta`
  siguen cuadrando.
- Redacta lo que dijo la dueña en la sala (`ale/evento` de tipo `pregunta`), los ids de turno, contexto y solicitud, y
  las rutas de la Pi en `ruta_pantalla` (se cambian por un archivo junto al fragmento).
"""
import argparse, json, shutil
from pathlib import Path

TEMAS = ("cuerpo/", "voz/", "ojo/", "robot/emparejamiento", "ale/evento")
EVENTOS = ("voz/", "ojo/", "ale/evento", "cuerpo/emocion", "cuerpo/gesto")   # lo que hace que un segundo valga la pena
ANTES_S, DESPUES_S, PAUSA_S = 2.0, 4.0, 1.0
TIEMPOS = ("t", "t_pub", "t0", "abierta_hasta", "expira")
REDACTADO = "[habla de la sala redactada]"


def tramos(msgs, ventanas):
    """Intervalos del tiempo original que se conservan, unidos y en orden."""
    puntos = sorted((m["t_pub"] - ANTES_S, max(m["t_pub"], m.get("t", 0), m.get("expira", 0)) + DESPUES_S)
                    for m in msgs if m["tema"].startswith(EVENTOS))
    out = []
    for a, b in puntos:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(max(a, va), min(b, vb)) for a, b in out for va, vb in ventanas if a < vb and b > va]


def mapeador(tramos_):
    """Tiempo original → tiempo del fragmento (empieza en 0). Un tiempo dentro de un corte cae al inicio del tramo siguiente."""
    inicio, acc = [], 0.0
    for a, b in tramos_:
        inicio.append(acc)
        acc += (b - a) + PAUSA_S

    def mover(x):
        for (a, b), s in zip(tramos_, inicio):
            if x < a:
                return round(s, 4)
            if x <= b:
                return round(s + x - a, 4)
        return round(acc, 4)
    return mover


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("origen"); ap.add_argument("salida")
    ap.add_argument("--ventana", nargs=2, type=float, action="append", required=True, metavar=("DESDE", "HASTA"))
    ap.add_argument("--fecha", required=True)
    ap.add_argument("--descripcion", default="")
    ap.add_argument("--pantalla", action="append", default=[], help="PNG de la pantalla de ojo, en el orden del primer ojo/conteo de cada foto")
    a = ap.parse_args()
    ventanas = [tuple(v) for v in a.ventana]
    msgs = []
    with open(a.origen, encoding="utf-8") as f:
        for linea in f:
            m = json.loads(linea)
            if any(x <= m["t_pub"] <= y for x, y in ventanas) and m["tema"].startswith(TEMAS):
                msgs.append(m)
    msgs.sort(key=lambda m: m["t_pub"])
    keep = tramos(msgs, ventanas)
    mover = mapeador(keep)
    alias: dict[tuple[str, str], str] = {}
    pantallas: dict[str, str] = {}
    salida = Path(a.salida)

    def apodo(tipo, valor):
        if valor is None:
            return None
        return alias.setdefault((tipo, valor), f"{tipo}-{sum(1 for k in alias if k[0] == tipo) + 1}")

    out = []
    for m in msgs:
        if not any(x <= m["t_pub"] <= y for x, y in keep):
            continue
        m = {k: v for k, v in m.items() if k not in ("seq", "t_rec")}
        for k in TIEMPOS:
            if isinstance(m.get(k), (int, float)):
                m[k] = mover(m[k])
        for k, tipo in (("turno", "turno"), ("contexto", "contexto"), ("solicitud_id", "foto")):
            if k in m:
                m[k] = apodo(tipo, m[k])
        if m["tema"] == "ale/evento" and m.get("tipo") == "pregunta":
            m["texto"] = REDACTADO
        if "ruta_pantalla" in m:
            sid = m["solicitud_id"]
            if sid not in pantallas:
                origen = a.pantalla[len(pantallas)] if len(pantallas) < len(a.pantalla) else None
                nombre = f"pantalla-{sid}.png"
                if origen:
                    shutil.copyfile(origen, salida.with_name(nombre))
                pantallas[sid] = nombre
            m["ruta_pantalla"] = pantallas[sid]
        out.append(m)
    meta = {"tema": "_meta", "fecha": a.fecha, "descripcion": a.descripcion, "mensajes": len(out),
            "duracion_s": round(mover(keep[-1][1]), 1) if keep else 0}
    with open(salida, "w", encoding="utf-8") as f:
        for m in [meta] + out:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"{len(out)} mensajes, {meta['duracion_s']} s, {len(keep)} tramos → {salida}")


if __name__ == "__main__":
    main()
