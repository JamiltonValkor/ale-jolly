"""Siembra el inventario de Masquebella (demo) con la credencial de Jolly, como hace el banco del robot real.

Uso: python sembrar.py [--esperar SEGUNDOS]
  Lee ALE_RUNTIME_URL y ALE_DEVICE_TOKEN de robot/voz-hermes/.env (los deja `start.sh` al vincular).
  --esperar: espera hasta N segundos a que aparezca la credencial (start.sh lo lanza junto a Jolly, antes de vincular).

Reusa `sembrar` de ale-runtime/robot/banco/banco.py: catálogo, proveedores, costos, conteo inicial y 8 semanas de
ventas, todo por `bench_seed` y las reglas reales de Stock. La corrida tiene un id fijo por negocio y las llaves de
idempotencia salen de él, así que volver a correrlo no duplica nada. Queda marcado en jolly-sim/.banco/estado.json.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import uuid
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent
ENV_ROBOT = AQUI / "robot" / "voz-hermes" / ".env"
CORRIDA = AQUI / ".banco"
DEMO_DATA = RAIZ / "saleads-sim" / "src" / "demo-data.ts"
NEGOCIO = "a6b8e93d-386f-4141-96ff-4b49e137728a"   # DEMO_BUSINESS_ID de saleads-sim


def leer_env() -> dict[str, str]:
    if not ENV_ROBOT.exists():
        return {}
    pares = (l.split("=", 1) for l in ENV_ROBOT.read_text().splitlines() if "=" in l and not l.startswith("#"))
    return {k.strip(): v.strip() for k, v in pares}


def ofertas(patrones: dict[str, str]) -> dict[str, dict[str, str]]:
    """Casa `ofertas_por_nombre` de la semilla con las ofertas de saleads-sim (id y nombre en demo-data.ts)."""
    demo = re.findall(r"id: '([0-9a-f-]{36})', type: '(\w+)', name: '([^']+)'", DEMO_DATA.read_text())
    salida = {}
    for clave, patron in patrones.items():
        hallado = [{"type": tipo, "id": i} for i, tipo, nombre in demo if re.search(patron, nombre)]
        if len(hallado) != 1:
            raise SystemExit(f"la oferta «{clave}» casa con {len(hallado)} ofertas de saleads-sim (patrón {patron})")
        salida[clave] = hallado[0]
    return salida


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--esperar", type=int, default=0)
    a = ap.parse_args()

    fin = time.time() + a.esperar
    env = leer_env()
    while not env.get("ALE_DEVICE_TOKEN") and time.time() < fin:
        time.sleep(3)
        env = leer_env()
    if not env.get("ALE_DEVICE_TOKEN"):
        raise SystemExit("Jolly aún no está vinculado: vincúlalo en la web y vuelve a correr ./start.sh --sembrar")

    # devlab (lo importa banco) lee estas variables al importarse.
    os.environ["SIM_GATEWAY"] = env.get("ALE_RUNTIME_URL") or os.environ.get("ALE_RUNTIME_URL", "http://localhost:8060")
    os.environ["SIM_BANCO_ENV"] = str(ENV_ROBOT)
    os.environ["BANCO_NEGOCIO"] = NEGOCIO
    sys.path.insert(0, str(RAIZ / "ale-runtime" / "robot" / "banco"))
    import banco

    c = banco.Corrida(str(CORRIDA))
    if c.estado.get("semilla_lista"):
        print(f"✓ Inventario ya sembrado (corrida {c.run_id})")
        return
    if not c.estado.get("run_id"):
        c.estado = {"run_id": str(uuid.uuid5(uuid.UUID(NEGOCIO), "jolly-sim/masquebella-v1")), "creada": banco.ahora(),
                    "ofertas": ofertas(c.sc["ofertas_por_nombre"]), "lote": 0}
        c.guardar()
    print("Sembrando el inventario de Masquebella (demo) por el canal de Jolly…")
    banco.sembrar(c, argparse.Namespace(hasta=None, rotar=False))
    print("✓ Stock listo: abre la pestaña Stock en la web")


if __name__ == "__main__":
    main()
