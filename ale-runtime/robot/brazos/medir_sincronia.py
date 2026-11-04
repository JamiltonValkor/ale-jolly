"""Mide cuánto tarda el brazo en recibir su orden frente a la cara (BR-013).

.venv/bin/python medir_sincronia.py carpeta   (con cara.jsonl de --registro, bus.jsonl de cuerpo.grabar y
brazos.jsonl de ALE_BRAZOS_REGISTRO). Momentos: primer M del gesto − primer cuadro de la cara con el momento nuevo.
Reposo: primer M − t de cara/micro. Criterio: p95 ≤ 50 ms con ≥ 30 gestos. No incluye la respuesta física del servo.
"""
import json, os, sys

POR_MOMENTO = {"saludo_corto": "escucha", "saludo_si": "escucha", "atenta": "escucha", "barbilla": "pensando",
               "mmm": "pensando_largo", "teclear": "trabajando", "leer": "trabajando", "encoger": "problema",
               "reposo": "reposo"}
POR_MICRO = {"balanceo_giro": "giro_jolly", "estirarse": "bostecito"}
VENTANA = 0.5


def leer(ruta):
    with open(ruta, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def p95(v):
    s = sorted(v)
    return s[min(len(s) - 1, int(0.95 * len(s)))]


def medir(carpeta):
    cara = leer(os.path.join(carpeta, "cara.jsonl"))
    bus = leer(os.path.join(carpeta, "bus.jsonl"))
    brazos = leer(os.path.join(carpeta, "brazos.jsonl"))
    cambios, previo = [], None
    for c in cara:
        if c["momento"] != previo:
            cambios.append((c["t_cuadro"], c["momento"]))
            previo = c["momento"]
    micros = [(m["t"], m["nombre"]) for m in bus if m.get("tema") == "cara/micro"]
    r = {"momento": [], "reposo": [], "fuera": []}
    for i, e in enumerate(brazos):
        n = e.get("gesto")
        if not n or e.get("espero"):       # momento que esperó a que terminara otro gesto: es la regla, no un retraso
            continue
        orden = next((x for x in brazos[i + 1:] if str(x.get("orden", "")).startswith("M")), None)
        if not orden:
            continue
        if n in POR_MICRO:
            ref = [t for t, nom in micros if nom == POR_MICRO[n] and abs(orden["t"] - t) < VENTANA]
            clave = "reposo"
        elif n in POR_MOMENTO:
            ref = [t for t, m in cambios if m == POR_MOMENTO[n] and abs(orden["t"] - t) < VENTANA]
            clave = "momento"
        else:
            continue
        if ref:
            r[clave].append((orden["t"] - min(ref, key=lambda t: abs(orden["t"] - t))) * 1000)
        else:
            r["fuera"].append(n)            # sin cambio de cara cerca: gesto pendiente que salió al terminar otro
    return r


def main():
    r = medir(sys.argv[1] if len(sys.argv) > 1 else ".")
    total = 0
    for clave in ("momento", "reposo"):
        v = r[clave]
        total += len(v)
        if v:
            a = [abs(x) for x in v]
            print(f"{clave}: n={len(v)} · mediana {sorted(a)[len(a) // 2]:.0f} ms · p95 {p95(a):.0f} ms · máx {max(a):.0f} ms · media con signo {sum(v) / len(v):+.0f} ms")
    print(f"sin referencia de cara: {len(r['fuera'])} {sorted(set(r['fuera']))}")
    print("OK" if total >= 30 and all(p95([abs(x) for x in r[c]]) <= 50 for c in ("momento", "reposo") if r[c]) else "NO CUMPLE")


if __name__ == "__main__":
    main()
