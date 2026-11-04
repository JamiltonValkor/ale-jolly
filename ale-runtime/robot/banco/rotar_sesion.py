#!/usr/bin/env python3
"""Rotación de la sesión de a6b8e93d a una sesión limpia (procedimiento de ../sesion-3, en un script).

Por defecto solo lee y muestra el plan (`--aplicar` lo ejecuta). Pasos, en este orden:
  1. Lee: `first_loop_flows` (1 fila), `managed_job_intents` (9) y `scheduled_job_bindings` (9) del negocio, y la
     metadata `hermes-continuous-contexts` de la VM con su fingerprint. Guarda la vuelta atrás en esta carpeta.
  2. Hermes: `POST /api/sessions {id, title}` con título único, desde el pod (la red interna llega; el Mac no).
  3. Base: una transacción, con el número exacto de filas (1 + 9 + 9) o ROLLBACK.
  4. Metadata: `setMetadata` con la fingerprint leída como candado; solo cambian los contextos y trabajos de a6b8e93d.
Correrlo DESPUÉS del reset y ANTES del primer turno de voz: chat.service guarda el contexto del dispositivo 3 h en
memoria del pod, y un turno previo fijaría la sesión vieja hasta reiniciar el pod.
Sin SSH. Secretos (llave de Hermes, token de GCP) solo en memoria; `devlab.redact` los tapa.

Uso: uv run --no-project python rotar_sesion.py [--aplicar] [--evidencia DIR] [--a saleads-flow-…]
Desde IVB-024 (3-nov) corre dentro de `banco.py sembrar --hasta …`: cada corrida empieza con sesión limpia.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parents[1] / "stock-sim"))
import devlab  # noqa: E402

USUARIO = "2df0d9e4-36b1-4194-b7d4-80f8e5f9065f"
NEGOCIO = "a6b8e93d-386f-4141-96ff-4b49e137728a"
VM, PROYECTO, ZONA = "sa-assistant-cd75ff1da23bfbf2c1ff79fc256b3189", "saleads-dev", "us-central1-a"
LLAVE = "hermes-continuous-contexts"


def leer() -> dict:
    q = devlab.Sql().query
    flow = q("SELECT id, session_id FROM assistant.first_loop_flows WHERE user_id = $1 AND business_id = $2", [USUARIO, NEGOCIO])
    intents = q("SELECT base_name, job_name, session_id, phase, native_job_id, instance_generation FROM assistant.managed_job_intents "
                "WHERE owner_id = $1 AND business_id = $2 ORDER BY base_name", [USUARIO, NEGOCIO])
    bindings = q("SELECT job_id, session_id FROM assistant.scheduled_job_bindings WHERE owner_id = $1 AND business_id = $2 ORDER BY job_id",
                 [USUARIO, NEGOCIO])
    d = json.loads(subprocess.check_output(["gcloud", "compute", "instances", "describe", VM, "--project", PROYECTO, "--zone", ZONA,
                                            "--format=json(metadata)"]))
    md = d["metadata"]
    valor = next(i["value"] for i in md["items"] if i["key"] == LLAVE)
    return {"flow": flow, "intents": intents, "bindings": bindings, "fingerprint": md["fingerprint"], "items": md["items"], "registro": valor}


def plan(e: dict, nueva: str) -> dict:
    if len(e["flow"]) != 1 or len(e["intents"]) != 9 or len(e["bindings"]) != 9:
        raise SystemExit(f"esperaba 1 flujo, 9 intents y 9 bindings: {len(e['flow'])}, {len(e['intents'])}, {len(e['bindings'])}")
    vieja = e["flow"][0]["session_id"]
    otras = {i["session_id"] for i in e["intents"]} | {b["session_id"] for b in e["bindings"]}
    if otras != {vieja}:
        raise SystemExit(f"intents o bindings no están en la sesión del flujo: {sorted(otras)}")
    reg = json.loads(e["registro"])
    n_ctx = sum(1 for c in reg["contexts"] if c["business_id"] == NEGOCIO)
    n_jobs = sum(1 for j in reg["jobs"] if j["business_id"] == NEGOCIO)
    for c in reg["contexts"] + reg["jobs"]:
        if c["business_id"] == NEGOCIO:
            c["session_id"] = nueva
    return {"vieja": vieja, "nueva": nueva, "flow_id": e["flow"][0]["id"], "contextos": n_ctx, "trabajos_metadata": n_jobs,
            "registro_nuevo": json.dumps(reg, separators=(",", ":"))}


def crear_sesion(nueva: str) -> str:
    vm = devlab.Vm(VM)
    titulo = f"SaleADS {NEGOCIO[:8]} {nueva.split('-')[2]}"
    out = vm.js("const r=await api('/api/sessions',{method:'POST',body:JSON.stringify({id:%s,title:%s})});console.log(r.status)"
                % (json.dumps(nueva), json.dumps(titulo)))
    if out.strip() not in ("200", "201", "409"):
        raise SystemExit(f"Hermes no creó la sesión: {out.strip()[:200]}")
    return titulo


def escribir_base(p: dict) -> None:
    """Una transacción; cada UPDATE con su número exacto de filas o ROLLBACK. Rol del runtime: es una operación de
    mantenimiento ya hecha en sesion-3 con OK del coordinador, no el SQL de solo lectura del banco (S-44)."""
    js = ("const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();"
          "try{await c.query('BEGIN');"
          "const a=await c.query('UPDATE assistant.first_loop_flows SET session_id=$1, updated_at=now() WHERE id=$2 AND user_id=$3 AND business_id=$4 AND session_id=$5',[%(n)s,%(f)s,%(u)s,%(b)s,%(v)s]);"
          "const i=await c.query('UPDATE assistant.managed_job_intents SET session_id=$1, updated_at=now() WHERE owner_id=$2 AND business_id=$3 AND session_id=$4',[%(n)s,%(u)s,%(b)s,%(v)s]);"
          "const s=await c.query('UPDATE assistant.scheduled_job_bindings SET session_id=$1, updated_at=now() WHERE owner_id=$2 AND business_id=$3 AND session_id=$4',[%(n)s,%(u)s,%(b)s,%(v)s]);"
          "if(a.rowCount!==1||i.rowCount!==9||s.rowCount!==9){await c.query('ROLLBACK');process.stdout.write(JSON.stringify({rollback:[a.rowCount,i.rowCount,s.rowCount]}));}"
          "else{await c.query('COMMIT');process.stdout.write(JSON.stringify({ok:[a.rowCount,i.rowCount,s.rowCount]}));}}"
          "catch(e){await c.query('ROLLBACK').catch(()=>{});process.stdout.write(JSON.stringify({error:e.message}))}finally{await c.end()}})()"
          ) % {k: json.dumps(v) for k, v in {"n": p["nueva"], "f": p["flow_id"], "u": USUARIO, "b": NEGOCIO, "v": p["vieja"]}.items()}
    out = devlab._node(js)
    if '"ok"' not in out:
        raise SystemExit(f"base sin cambios: {out[:300]}")
    print("base:", out.strip())


def escribir_metadata(e: dict, p: dict) -> None:
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    devlab._SECRETS.append(token)
    items = [{"key": i["key"], "value": p["registro_nuevo"] if i["key"] == LLAVE else i["value"]} for i in e["items"]]
    url = f"https://compute.googleapis.com/compute/v1/projects/{PROYECTO}/zones/{ZONA}/instances/{VM}/setMetadata"
    req = urllib.request.Request(url, data=json.dumps({"fingerprint": e["fingerprint"], "items": items}).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print("metadata:", r.status, json.loads(r.read()).get("status"))
    except urllib.error.HTTPError as err:   # 412: alguien cambió la metadata entretanto; nada se escribió
        raise SystemExit(devlab.redact(f"setMetadata {err.code}: {(err.read() or b'')[:300].decode(errors='replace')}"))


def rotar(evidencia: Path, aplicar: bool = True, destino: str | None = None) -> dict:
    """Rota la sesión y deja la vuelta atrás en `evidencia`. Devuelve {vieja, nueva}. Sale con error si algo no cuadra.
    Con `destino`, vuelve a una sesión que ya existe (la vuelta atrás): Hermes responde 409 y no se crea nada."""
    e = leer()
    if destino is not None and not destino.startswith("saleads-flow-"):
        raise SystemExit("el destino debe ser una sesión saleads-flow-…")
    nueva = destino or f"saleads-flow-{uuid.uuid4()}"
    p = plan(e, nueva)
    print(json.dumps({k: v for k, v in p.items() if k != "registro_nuevo"}, indent=1))
    if not aplicar:
        print("solo lectura: nada se cambió (usa --aplicar)")
        return {"vieja": p["vieja"], "nueva": None}
    evidencia.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (evidencia / f"valores-anteriores-{stamp}.json").write_text(json.dumps({"flow": e["flow"], "sesion_vieja": p["vieja"], "sesion_nueva": nueva,
                                                                           "intents": e["intents"], "bindings": e["bindings"]}, indent=1) + "\n")
    (evidencia / f"metadata-anterior-{stamp}.json").write_text(json.dumps({"fingerprint": e["fingerprint"], "key": LLAVE, "value": e["registro"]}) + "\n")
    print("hermes: sesión creada,", crear_sesion(nueva))
    escribir_base(p)
    escribir_metadata(e, p)
    print("listo:", p["vieja"], "→", nueva)
    return {"vieja": p["vieja"], "nueva": nueva}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aplicar", action="store_true")
    ap.add_argument("--evidencia", default=str(AQUI))
    ap.add_argument("--a", dest="destino", help="sesión existente a la que volver (vuelta atrás)")
    a = ap.parse_args()
    rotar(Path(a.evidencia), a.aplicar, a.destino)


if __name__ == "__main__":
    main()
