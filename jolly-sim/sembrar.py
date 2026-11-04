"""Siembra el inventario de Masquebella (demo) con la credencial de Jolly, como hace el banco del robot real.

Uso: python sembrar.py [--esperar SEGUNDOS] [--vincular]
  Lee ALE_RUNTIME_URL y ALE_DEVICE_TOKEN de robot/voz-hermes/.env (los deja `start.sh` al vincular).
  --esperar: espera hasta N segundos a que aparezca la credencial (start.sh lo lanza junto a Jolly, antes de vincular).
  --vincular: sin credencial (o con una que el servidor ya no reconoce), vincula a Jolly solo con la terminal: muestra
    el código, el dueño lo escribe en la web y la credencial queda en .env. Sin cara, micrófono ni voz: sirve en Windows.

Reusa `sembrar` de ale-runtime/robot/banco/banco.py: catálogo, proveedores, costos, conteo inicial y 8 semanas de
ventas, todo por `bench_seed` y las reglas reales de Stock. La corrida tiene un id fijo por negocio y las llaves de
idempotencia salen de él, así que volver a correrlo no duplica nada. Queda marcado en jolly-sim/.banco/estado.json.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
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


def runtime_url(env: dict[str, str]) -> str:
    return (env.get("ALE_RUNTIME_URL") or os.environ.get("ALE_RUNTIME_URL", "http://localhost:8060")).rstrip("/")


def guardar_credencial(token: str, device_id: str) -> None:
    """Como `guardar_env` del robot: cambia solo la credencial y deja el resto de .env."""
    lineas = [l for l in (ENV_ROBOT.read_text().splitlines() if ENV_ROBOT.exists() else [])
              if l.split("=", 1)[0] not in ("ALE_DEVICE_TOKEN", "ALE_DEVICE_ID")]
    ENV_ROBOT.write_text("\n".join(lineas + [f"ALE_DEVICE_TOKEN={token}", f"ALE_DEVICE_ID={device_id}"]) + "\n")
    try:
        ENV_ROBOT.chmod(0o600)
    except OSError:
        pass


def _post(base: str, ruta: str, cuerpo: dict, token: str | None = None) -> tuple[int, dict]:
    cabeceras = {"Content-Type": "application/json", "User-Agent": "ale-robot/1.0 jolly-sim"}
    if token:
        cabeceras["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + ruta, data=json.dumps(cuerpo).encode(), method="POST", headers=cabeceras)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def credencial_valida(base: str, token: str) -> bool:
    """401 = el servidor ya no reconoce la credencial (otra base, o desvinculado). Cualquier otra respuesta la acepta."""
    estado, _ = _post(base, "/devices/me/stream", {"op": "bench_state", "run_id": str(uuid.uuid4())}, token)
    return estado != 401


def vincular(base: str, nombre: str = "Jolly") -> None:
    """El mismo emparejamiento del robot (canal_robot.emparejar), en la terminal. Bloquea hasta que el dueño lo reclame."""
    while True:
        estado, p = _post(base, "/devices/pairing", {"name": nombre})
        if estado != 200:
            raise SystemExit(f"no pude pedir el código de vinculación (HTTP {estado}): ¿está arriba ./local/demo.sh up?")
        print("\n" + "=" * 46, flush=True)
        print(f"  Vincula a Jolly en la web (Hoy → Compañero físico → Vincular) con el código:\n\n        {p['code']}\n", flush=True)
        print("=" * 46 + "\n", flush=True)
        while True:
            time.sleep(2)
            estado, r = _post(base, f"/devices/pairing/{p['pairing_id']}/poll", {"poll_secret": p["poll_secret"]})
            if estado == 404:
                print("El código venció; pido otro…", flush=True)
                break
            if estado == 200 and r.get("status") == "paired":
                guardar_credencial(r["device_token"], r["device_id"])
                print("✓ Jolly vinculado", flush=True)
                return


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
    ap.add_argument("--vincular", action="store_true")
    a = ap.parse_args()

    fin = time.time() + a.esperar
    env = leer_env()
    while not env.get("ALE_DEVICE_TOKEN") and time.time() < fin:
        time.sleep(3)
        env = leer_env()
    base = runtime_url(env)
    if a.vincular and not (env.get("ALE_DEVICE_TOKEN") and credencial_valida(base, env["ALE_DEVICE_TOKEN"])):
        vincular(base)
        env = leer_env()
    if not env.get("ALE_DEVICE_TOKEN"):
        raise SystemExit("Jolly aún no está vinculado: corre ./start.sh --sembrar y escribe el código en la web")

    # devlab (lo importa banco) lee estas variables al importarse.
    os.environ["SIM_GATEWAY"] = base
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
