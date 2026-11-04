#!/usr/bin/env python3
"""Operador del banco E2E de 9 pasos (IVB-024). Mueve lo simulado y guarda evidencia; las puertas humanas no las toca.

Lo que hace: crear la corrida y sembrar (`bench_seed`), mover el reloj (`bench_clock`) con las ventas del salto, disparar
el tick (`bench_tick`), prender la campaña simulada (`bench_campaign`), poner la escena en la Pi, leer estado y SQL de
solo lectura, entregar factura y pantallazo por el canal `banco` y cerrar (`bench_close`). Todo queda en `<corrida>/banco.jsonl`.

Lo que no hace, por diseño: decidir propuestas. No llama ninguna ruta web de decisión ni usa la sesión web del dueño; su única
credencial es la del dispositivo (la Pi), leída de `~/.config/inventario-vivo/banco-pi.env` y nunca impresa.
`pruebas_banco.py` lo verifica leyendo este archivo.

Uso (guion completo en mini-muse/docs/tasks/inventario-vivo-v1/evidencia/e2e/guion-e2e-9-pasos.md):
  python banco.py iniciar  --corrida DIR --ofertas OFERTAS.json
  python banco.py digests  --corrida DIR                               # al empezar y al terminar
  python banco.py sembrar  --corrida DIR [--hasta p2] [--rotar]        # --hasta p2: arranca en el P3; --rotar: sesión nueva
  python banco.py escena   --corrida DIR --paso p2
  python banco.py salto    --corrida DIR --paso p3   (p5b pide --previstas N)
  python banco.py tick     --corrida DIR --paso p3
  python banco.py campana  --corrida DIR --paso p4 --propuesta ID --previstas N
  python banco.py documento --corrida DIR --paso p1|p5                  # factura / pantallazo, canal banco
  python banco.py estado   --corrida DIR --paso p2 [--movimiento ID]
  python banco.py sql      --corrida DIR --paso p2 saldo|cruce-confirmaciones|escrituras-sin-confirmacion
  python banco.py traer    --corrida DIR --paso p2                       # bus.jsonl, cara.jsonl y pantalla del conteo
  python banco.py turno    --corrida DIR --paso p2 --texto "..."        # solo ensayo: texto en vez de voz, marcado
  python banco.py proveedor --corrida DIR --paso p7 --texto "..."      # solo ensayo 7b, canal banco
  python banco.py puerta   --corrida DIR --paso p1 --tipo entrada --que "..."   # para y deja el mensaje para el owner
  python banco.py esperar  --corrida DIR --paso p1 --tipo entrada               # hasta que el owner decida en pantalla
  python banco.py cerrar   --corrida DIR
  python banco.py barrido  DIR
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

AQUI = Path(__file__).resolve().parent
REPO = AQUI.parents[1]
SEMILLA = AQUI / "semillas" / "masquebella-v1.yaml"
CONSULTAS = AQUI / "consultas"
NEGOCIO = os.environ.get("BANCO_NEGOCIO", "a6b8e93d-386f-4141-96ff-4b49e137728a")   # Masquebella COPIA DE PRUEBA
PI = os.environ.get("BANCO_PI", "jolly-pi-1")
ESCENA_PI = "~/ale/ojo/banco/escena_actual"
MANIFIESTO_PI = "/home/pi/ale/ojo/banco/manifiesto.json"
BOGOTA = timezone(timedelta(hours=-5))
DIA = 86400
os.environ.setdefault("SIM_BANCO_ENV", str(Path.home() / ".config/inventario-vivo/banco-pi.env"))
sys.path.insert(0, str(REPO / "stock-sim"))


def clave(paso: str) -> str:
    """`p1`, `p01` y `1` son el mismo paso: la semilla usa `p1`, las carpetas `p01`."""
    m = re.fullmatch(r"p?0*(\d+)", paso)
    return f"p{int(m.group(1))}" if m else paso


def carpeta_paso(paso: str) -> str:
    m = re.fullmatch(r"p?0*(\d+)", paso)
    return f"p{int(m.group(1)):02d}" if m else paso


def ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Corrida:
    def __init__(self, carpeta: str):
        self.dir = Path(carpeta)
        self.estado_ruta = self.dir / "estado.json"
        self.estado: dict[str, Any] = json.loads(self.estado_ruta.read_text()) if self.estado_ruta.exists() else {}
        self.sc = yaml.safe_load(SEMILLA.read_text())
        self._banco = None

    # ---- transporte ---------------------------------------------------------------------------------------------
    @property
    def banco(self):
        if self._banco is None:
            import devlab   # importa tarde: `iniciar` y `barrido` no tocan la red
            self._banco = devlab.Banco()
        return self._banco

    @property
    def run_id(self) -> str:
        return self.estado["run_id"]

    def guardar(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.estado_ruta.write_text(json.dumps(self.estado, ensure_ascii=False, indent=1) + "\n")

    def bitacora(self, fila: dict[str, Any]) -> None:
        import devlab
        with open(self.dir / "banco.jsonl", "a") as f:
            f.write(devlab.redact(json.dumps({"t": ahora(), **fila}, ensure_ascii=False)) + "\n")

    def paso_dir(self, paso: str) -> Path:
        d = self.dir / carpeta_paso(paso)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def op(self, cuerpo: dict[str, Any], paso: str = "p00") -> Any:
        status, resp = self.banco.op({**cuerpo, "run_id": self.run_id})
        self.bitacora({"paso": paso, "op": cuerpo["op"], "status": status, "resp": resp if cuerpo["op"] not in ("bench_seed",) else
                       {k: resp.get(k) for k in ("aplicadas", "pendientes", "lote")} if isinstance(resp, dict) else resp})
        if status != 200:
            raise SystemExit(f"{cuerpo['op']} respondió {status}: {str(resp)[:300]}")
        return resp

    def sql(self, nombre: str) -> list[dict[str, Any]]:
        import devlab
        texto = (CONSULTAS / f"{nombre}.sql").read_text()
        return devlab.retry(lambda: devlab.Sql().query(texto, [self.run_id, NEGOCIO]))

    # ---- semilla ------------------------------------------------------------------------------------------------
    def sembrar_lote(self, nombre: str, aplicar=(), proveedores=(), presupuestos=None, costos=(), paso: str = "p00") -> Any:
        lote = int(self.estado.get("lote", 0))
        semilla = {"negocio_id": NEGOCIO, "nombre": f"IVB-024 {self.sc['nombre']}"[:80], "semilla": f"{self.sc['semilla']}-{lote}-{nombre}"[:80],
                   "proveedores": list(proveedores), "aplicar": list(aplicar), "propuestas": [], "presupuestos": presupuestos or {},
                   **({"costos": list(costos)} if costos else {})}
        resp = self.op({"op": "bench_seed", "semilla": semilla, "lote": lote, "ultimo": False}, paso)
        with open(self.dir / "semillas.jsonl", "a") as f:
            f.write(json.dumps({"t": ahora(), "paso": paso, "lote": lote, "nombre": nombre, "semilla": semilla, "resp": resp}, ensure_ascii=False) + "\n")
        self.estado["lote"] = lote + 1
        self.guardar()
        return resp

    def reloj(self, offset: int, paso: str) -> str:
        r = self.op({"op": "bench_clock", "offset_seconds": int(offset)}, paso)
        self.estado["offset"] = int(offset)
        self.guardar()
        return r["ahora"]

    def variantes(self) -> dict[str, str]:
        st = self.op({"op": "bench_state"})
        por_nombre = {(v["producto"], v["variante"]): v["id"] for v in st["variantes"]}
        return {p["key"]: por_nombre.get((p["nombre"], p["variante"])) for p in self.sc["productos"]}

    def ventas(self, por_producto: dict[str, int], nombre: str, paso: str) -> None:
        var = self.estado["variantes"]
        items = [{"idempotency_key": f"{self.run_id[:8]}-{nombre}-{k}", "kind": "venta",
                  "detalle": {"variante_id": var[k], "cantidad": int(n), "nota": "venta simulada del banco"}}
                 for k, n in por_producto.items() if int(n) > 0]
        if items:
            self.sembrar_lote(nombre, aplicar=items, paso=paso)


# ---- órdenes ----------------------------------------------------------------------------------------------------

def iniciar(c: Corrida, a) -> None:
    if c.estado.get("run_id"):
        raise SystemExit(f"ya hay corrida en {c.dir}: {c.run_id}")
    ofertas = json.loads(Path(a.ofertas).read_text())
    faltan = [p["oferta"] for p in c.sc["productos"] if p["oferta"] not in ofertas]
    if faltan:
        raise SystemExit(f"faltan ofertas: {faltan}")
    try:
        git = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except FileNotFoundError:
        git = None
    c.estado = {"run_id": str(uuid.uuid4()), "creada": ahora(), "ofertas": {p["oferta"]: ofertas[p["oferta"]] for p in c.sc["productos"]}, "lote": 0}
    c.guardar()
    manifiesto = {"run_id": c.run_id, "negocio": NEGOCIO, "creada": c.estado["creada"], "rama_sha": git,
                  "semilla_sha256": hashlib.sha256(SEMILLA.read_bytes()).hexdigest(),
                  "digests": {"ale-runtime": None, "sa-mcp-server": None, "sa-domain-client": None},
                  "nota": "digests: anotar con `banco.py digests` al empezar y al terminar; si cambian, la corrida no vale (veredicto)."}
    (c.dir / "manifiesto.json").write_text(json.dumps(manifiesto, ensure_ascii=False, indent=1) + "\n")
    print(c.run_id)


def digests(c: Corrida, a) -> None:
    """Solo lectura del clúster: imagen de cada despliegue. Si ya estaban anotadas y cambiaron, falla."""
    m = json.loads((c.dir / "manifiesto.json").read_text())
    vistos = {}
    for nombre, deploy in (("ale-runtime", "sa-meta-assistant-service"), ("sa-mcp-server", "sa-mcp-server"), ("sa-domain-client", "sa-domain-client")):
        out = subprocess.run(["kubectl", "-n", "saleads", "get", "deploy", deploy, "-o", "jsonpath={.spec.template.spec.containers[0].image}"],
                             capture_output=True, text=True)
        vistos[nombre] = out.stdout.strip() or None
    cambiados = {k: (m["digests"][k], v) for k, v in vistos.items() if m["digests"].get(k) and m["digests"][k] != v}
    if cambiados:
        raise SystemExit(f"digest cambió durante la corrida: {cambiados}")
    m["digests"] = vistos
    (c.dir / "manifiesto.json").write_text(json.dumps(m, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps(vistos, indent=1))


def sembrar(c: Corrida, a) -> None:
    """Catálogo y presupuestos, proveedores, conteo inicial e historia de 8 semanas. El día 0 queda en `offset_base`.
    Con `--rotar` (apagado por defecto), antes rota la sesión del negocio con `rotar_sesion.py`. Decisión del owner (3-nov):
    la oficial corre sobre la sesión con historia, como una dueña real; rotar es solo una opción explícita de diagnóstico.
    Si se usa, debe correr antes de cualquier turno de voz de la corrida (el pod cachea la sesión 3 h)."""
    if c.estado.get("semilla_lista"):
        raise SystemExit("la semilla ya está")
    if getattr(a, "rotar", False) and not c.estado.get("sesion"):
        import rotar_sesion
        r = rotar_sesion.rotar(c.paso_dir("p00") / "sesion")
        c.estado["sesion"] = {"vieja": r["vieja"], "nueva": r["nueva"], "rotada": ahora()}
        c.guardar()
        c.bitacora({"paso": "p00", "op": "rotar_sesion", **c.estado["sesion"]})
    sc = c.sc
    cat = [{"idempotency_key": f"{c.run_id[:8]}-cat-{p['key']}", "kind": "catalogo",
            "detalle": {"producto": p["nombre"], "variantes": [{"nombre": p["variante"]}], "oferta": c.estado["ofertas"][p["oferta"]]}}
           for p in sc["productos"]]
    c.sembrar_lote("catalogo", aplicar=cat, presupuestos=sc["presupuestos"])   # crea la corrida: antes no hay reloj
    c.reloj(0, "p00")
    var = c.variantes()
    if None in var.values():
        raise SystemExit(f"variantes sin crear (¿oferta inexistente?): {var}")
    c.estado["variantes"] = var
    provs = []
    for pv in sc["proveedores"]:
        pid = str(uuid.uuid5(uuid.UUID(c.run_id), pv["id_clave"]))
        c.estado.setdefault("proveedores", {})[pv["id_clave"]] = pid
        provs.append({"id": pid, "nombre": pv["nombre"], "dias_entrega": pv["dias_entrega"],
                      "cotizaciones": [{"variante_id": var[q["producto"]], "precio": q["precio"], "flete": q["flete"], "minimo": q["minimo"],
                                        "plazo_pago_dias": q["plazo_pago_dias"], "garantia": q["garantia"], "prueba_equivalencia": None,
                                        "moneda": q["moneda"]} for q in pv["cotizaciones"]]})
    inicial = [{"idempotency_key": f"{c.run_id[:8]}-c0-{p['key']}", "kind": "conteo", "causa": "otra",
                "detalle": {"variante_id": var[p["key"]], "contado": p["stock_final_historia"] + sum(p["historia"]), "origen": "voz"}}
               for p in sc["productos"] if p["stock_final_historia"] + sum(p["historia"]) > 0]
    # 1.0.4: el producto estancado necesita costo para que Stock lo pase a marketing. Sin factura, lo pone la semilla.
    costos = [{"variante_id": var[p["key"]], "costo_unitario": p["costo"], "moneda": sc["moneda"]} for p in sc["productos"] if p.get("costo")]
    c.sembrar_lote("conteo-inicial", aplicar=inicial, proveedores=provs, costos=costos)
    semanas = int(sc["historia_semanas"])
    for w in range(semanas):
        c.reloj(w * 7 * DIA + 3 * DIA, "p00")
        c.ventas({p["key"]: p["historia"][w] for p in sc["productos"]}, f"historia-s{w}", "p00")
    real = datetime.now(timezone.utc)
    inicio = (real.astimezone(BOGOTA) + timedelta(days=semanas * 7)).replace(hour=int(sc["hora_inicio"]), minute=0, second=0, microsecond=0)
    c.estado["offset_base"] = int((inicio - real).total_seconds())
    c.estado["dia"] = 0
    c.reloj(c.estado["offset_base"], "p00")
    if getattr(a, "hasta", None) == "p2":   # prueba corta: el estado del final del P2, sin repetir P1 y P2
        ar = sc["arranque_p3"]
        conteos = [{"idempotency_key": f"{c.run_id[:8]}-arr-{k}", "kind": "conteo", "causa": "otra",
                    "detalle": {"variante_id": var[k], "contado": int(n), "origen": "voz"}} for k, n in ar["conteos"].items()]
        costos = [{"variante_id": var[k], "costo_unitario": v, "moneda": sc["moneda"]} for k, v in ar["costos"].items()]
        c.sembrar_lote("arranque-p3", aplicar=conteos, costos=costos)
        c.estado["arranque"] = "p3"
    c.estado["semilla_lista"] = True
    c.guardar()
    print(f"semilla lista: corrida {c.run_id}, día 0 simulado {inicio.isoformat()}"
          + (" (arranque en el P3: mascarilla 22 con costo)" if c.estado.get("arranque") else ""))


def escena(c: Corrida, a) -> None:
    e = c.sc["escenas"][clave(a.paso)]
    if not re.fullmatch(r"[A-Za-z0-9-]+", e["id"]):
        raise SystemExit("escena inválida")
    py = (f"import json,hashlib;m=json.load(open('{MANIFIESTO_PI}'));i=[x for x in m['imagenes'] if x['id']=='{e['id']}'][0];"
          f"import pathlib;b=(pathlib.Path('{MANIFIESTO_PI}').parent/i['archivo']).read_bytes();print(i['sha256'],hashlib.sha256(b).hexdigest(),i['conteo_real'])")
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", PI, f"python3 -c \"{py}\""], capture_output=True, text=True, timeout=60)
    partes = out.stdout.split()
    if len(partes) != 3 or not (partes[0] == partes[1] == e["sha256"]) or int(partes[2]) != e["conteo"]:
        raise SystemExit(f"la escena {e['id']} en la Pi no coincide con la semilla: {out.stdout.strip()} {out.stderr.strip()[:200]}")
    subprocess.run(["ssh", "-o", "BatchMode=yes", PI, f"echo {e['id']} > {ESCENA_PI}"], check=True, timeout=60)
    c.bitacora({"paso": a.paso, "op": "escena", "escena": e["id"], "conteo_mirado": e["conteo"], "sha256": e["sha256"]})
    print(f"{a.paso}: repisa = {e['id']} ({e['conteo']} mirados, sha256 verificado en la Pi)")


def salto(c: Corrida, a) -> None:
    s = c.sc["saltos"][clave(a.paso)]
    if s["dias"] == "entrega" and a.dias is None:
        raise SystemExit("el salto del paso 8 pide --dias (los días de entrega del proveedor elegido, de la pantalla de Pedidos)")
    dias = int(a.dias if a.dias is not None else s["dias"])
    ventas = dict(s["ventas"])
    if s.get("pega"):   # 1.0.4: la pauta pega a mitad de semana; la cantidad sale de la previsión aprobada
        previo = c.sc["saltos"][s["pega"]["tras"]]["ventas"][s["pega"]["producto"]]
        ventas[s["pega"]["producto"]] = ventas_que_pegan(c.sc, a.previstas, previo)
    if clave(a.paso) == "p8":   # cuadre: la repisa (33) es el esperado si llegó todo el pedido
        cu = c.sc["cuadre_p8"]
        saldo = {r["variante_id"]: r["saldo"] for r in c.sql("saldo")}[c.estado["variantes"][cu["producto"]]]
        pedido = int(a.pedido) if a.pedido else None
        if pedido is None:
            raise SystemExit("el paso 8 pide --pedido (cantidad del pedido aprobado en el paso 6, de la pantalla de Pedidos)")
        ventas[cu["producto"]] = max(0, saldo + pedido - c.sc["escenas"][cu["escena"]]["conteo"])
        c.bitacora({"paso": a.paso, "op": "cuadre", "saldo": saldo, "pedido": pedido, "ventas_mascarilla": ventas[cu["producto"]]})
    # Ventas topadas por el saldo: en la oficial del 2-nov el Tónico tenía 1 y la semilla pedía vender 4 (STOCK_NEGATIVE).
    saldo = {r["variante_id"]: r["saldo"] for r in c.sql("saldo")}
    topadas = {k: min(int(n), max(0, saldo.get(c.estado["variantes"][k], 0))) for k, n in ventas.items()}
    if topadas != {k: int(n) for k, n in ventas.items()}:
        c.bitacora({"paso": a.paso, "op": "ventas_topadas", "pedidas": ventas, "aplicadas": topadas})
    ventas = topadas
    c.estado["dia"] = int(c.estado.get("dia", 0)) + dias
    hora = c.reloj(c.estado["offset_base"] + c.estado["dia"] * DIA, a.paso)
    c.ventas(ventas, f"{a.paso}-ventas", a.paso)
    (c.paso_dir(a.paso) / "salto.json").write_text(json.dumps({"dias": dias, "dia_simulado": c.estado["dia"], "ahora_simulado": hora,
                                                              "ventas_simuladas": ventas, "simulado": True}, ensure_ascii=False, indent=1) + "\n")
    print(f"{a.paso}: +{dias} días → {hora} (simulado). Ventas simuladas: {ventas}")


def tick(c: Corrida, a) -> None:
    r = c.op({"op": "bench_tick"}, a.paso)
    print(f"{a.paso}: tick → {r}")


def _previstas(previstas: float | None) -> float:
    if previstas is None or previstas <= 0:
        raise SystemExit("la pauta que pega pide --previstas (unidades por semana de la pauta aprobada, de la pantalla de Stock)")
    return float(previstas)


def senales_campana(sc: dict, previstas: float | None) -> dict:
    """1.0.4: la pauta de la Mascarilla «pega». Las ventas atribuidas por día son `factor` veces la previsión de la pauta
    aprobada, que la decide marketing en la corrida: por eso entra con --previstas (de la pantalla de Stock)."""
    s = dict(sc["campana_senales"])
    pega = sc.get("campana_pega")
    if pega:
        s["ventas_atribuidas_dia"] = math.ceil(pega["factor"] * _previstas(previstas) / 7)
    return s


def ventas_que_pegan(sc: dict, previstas: float | None, ya_en_ventana: int) -> int:
    """Unidades del salto `p5b` para que el servidor marque `pegando` (rotation.ts `hotSignal`): el ritmo de los últimos
    `ventana_dias` (las ventas del salto p5 más estas, por 7 ÷ ventana) llega a `factor` × la previsión. Mínimo 1."""
    pega, n = sc["campana_pega"], _previstas(previstas)
    k = 1
    while round((ya_en_ventana + k) * 7 / pega["ventana_dias"], 1) < pega["factor"] * n:
        k += 1
    return k


def campana(c: Corrida, a) -> None:
    r = c.op({"op": "bench_campaign", "proposal_id": a.propuesta, "senales": senales_campana(c.sc, a.previstas)}, a.paso)
    print(f"{a.paso}: campaña simulada {r}")


def documento(c: Corrida, a) -> None:
    """Factura (p1) o pantallazo (p5) por el canal `banco` (simulado), mientras no haya canal real (Telegram, R8b).
    Mismo camino que IVB-027 caso 7: el PDF va en el turno y Ale lo registra con `document_register`."""
    d = c.sc["documentos"][clave(a.paso)]
    if d.get("generada"):   # paso 8: la factura del pedido sale de lo acordado, que no se conoce antes de la corrida
        if not (a.cantidad and a.precio):
            raise SystemExit("esta factura pide --cantidad y --precio (los del pedido acordado, de la pantalla de Pedidos)")
        sys.path.insert(0, str(AQUI / "facturas"))
        import generar
        f = {"proveedor": d["proveedor"], "nit": d["nit"], "numero": d["numero"], "fecha": c.estado.get("ahora_simulado", "")[:10] or "2026-10-29",
             "moneda": "COP", "lineas": [(d["descripcion"], int(a.cantidad), int(a.precio))]}
        f["total_impreso"] = int(a.cantidad) * int(a.precio)
        datos = generar.pdf(generar.paginas(f))
        archivo = c.paso_dir(a.paso) / "factura-pedido.pdf"
        archivo.write_bytes(datos)
        d = {**d, "archivo": str(archivo), "sha256": hashlib.sha256(datos).hexdigest()}
    else:
        datos = (REPO / d["archivo"]).read_bytes()
    if hashlib.sha256(datos).hexdigest() != d["sha256"]:
        raise SystemExit(f"el {d['tipo']} no coincide con la semilla")
    art = "la" if d["tipo"] == "factura" else "el"
    texto = (f"Te mando {art} {d['tipo']} por aquí (canal banco, simulado). Es un PDF en base64; guárdalo, regístralo como "
             f"{d['tipo']} con canal banco y pásalo a Stock. Nombre: {Path(d['archivo']).name}\n" + base64.b64encode(datos).decode())
    if len(texto) > 2000:   # el servidor guarda la frase en stock_owner_utterances (1 a 2000 caracteres)
        raise SystemExit(f"el {d['tipo']} no cabe en un turno del canal robot")
    r = c.banco.turn(texto)
    (c.paso_dir(a.paso) / f"{d['tipo']}-turno.json").write_text(json.dumps({"enviado": ahora(), "archivo": d["archivo"], "sha256": d["sha256"],
                                                                         "canal": "banco", "simulado": True, "respuesta": r}, ensure_ascii=False, indent=1) + "\n")
    c.bitacora({"paso": a.paso, "op": d["tipo"], "canal": "banco", "status": r.get("status"), "ms": r.get("ms")})
    print(f"{a.paso}: {d['tipo']} entregado ({r.get('status')}, {r.get('ms')} ms): {(r.get('texto') or '')[:200]}")


def turno(c: Corrida, a) -> None:
    """Solo ensayo en el Mac: un turno por texto en vez de la voz de una persona. Queda marcado `inyectado`."""
    r = c.banco.turn(a.texto)
    nombre = f"turno-{datetime.now().strftime('%H%M%S')}.json"
    (c.paso_dir(a.paso) / nombre).write_text(json.dumps({"inyectado": True, "dice": a.texto, "respuesta": r}, ensure_ascii=False, indent=1) + "\n")
    c.bitacora({"paso": a.paso, "op": "turno", "inyectado": True, "status": r.get("status"), "ms": r.get("ms")})
    print(f"{a.paso} (inyectado): {(r.get('texto') or r.get('error') or '')[:300]}")


def traer(c: Corrida, a) -> None:
    """Evidencia de la Pi: el bus y la cara de la sesión de `ale` en curso (bus.jsonl, cara.jsonl) y la pantalla del último conteo."""
    reg = "~/ale/voz-hermes/grabaciones"
    for tipo in ("bus", "cara"):
        ultimo = subprocess.run(["ssh", "-o", "BatchMode=yes", PI, f"ls -t {reg}/{tipo}-*.jsonl | head -1"], capture_output=True, text=True, timeout=60).stdout.strip()
        if ultimo:
            subprocess.run(["scp", "-q", f"{PI}:{ultimo}", str(c.dir / f"{tipo}.jsonl")], check=True, timeout=120)
    ruta = None
    if (c.dir / "bus.jsonl").exists():
        for linea in (c.dir / "bus.jsonl").read_text(errors="replace").splitlines():
            if '"ojo/conteo"' in linea and "ruta_pantalla" in linea:
                ruta = re.search(r'"ruta_pantalla":\s*"([^"]+)"', linea)
    if ruta:
        destino = c.paso_dir(a.paso) / f"pantalla-{datetime.now().strftime('%H%M%S')}.png"
        subprocess.run(["scp", "-q", f"{PI}:{ruta.group(1)}", str(destino)], check=True, timeout=120)
        print(f"{a.paso}: bus.jsonl, cara.jsonl y {destino.name}")
    else:
        print(f"{a.paso}: bus.jsonl y cara.jsonl (sin conteo en el bus todavía)")


def estado(c: Corrida, a) -> None:
    cuerpo = {"op": "bench_state", **({"movement_id": a.movimiento} if a.movimiento else {})}
    r = c.op(cuerpo, a.paso)
    nombre = f"estado-{datetime.now().strftime('%H%M%S')}.json"
    (c.paso_dir(a.paso) / nombre).write_text(json.dumps(r, ensure_ascii=False, indent=1) + "\n")
    print(f"{a.paso}: {nombre} — ahora {r.get('ahora')}, {r.get('movimientos')} movimientos, presupuestos {r.get('presupuestos')}")


def sql(c: Corrida, a) -> None:
    filas = c.sql(a.consulta)
    nombre = f"{a.consulta}-{datetime.now().strftime('%H%M%S')}.json"
    (c.paso_dir(a.paso) / nombre).write_text(json.dumps(filas, ensure_ascii=False, indent=1, default=str) + "\n")
    print(f"{a.paso}: {nombre}, {len(filas)} filas")
    if a.consulta == "escrituras-sin-confirmacion" and filas:
        raise SystemExit(f"FALLA: {len(filas)} escrituras sin confirmación válida")


def puerta(c: Corrida, a) -> None:
    """Puerta humana: el banco para aquí. Deja la puerta pendiente y escribe el mensaje para el owner, que hace el clic.
    El operador lo manda al coordinador (SendMessage a main) y corre `esperar`. El banco nunca hace el clic."""
    st = c.op({"op": "bench_state"}, a.paso)
    pend = [p for p in st["propuestas"] if p["kind"] == a.tipo and p["status"] == "pendiente"]
    if not pend:
        raise SystemExit(f"{a.paso}: no hay propuesta {a.tipo} pendiente; la puerta no se abre")
    g = c.sc["puertas"][a.tipo]   # los textos de la pantalla viven en la semilla: este archivo no nombra decisiones
    msg = c.sc["mensaje_puerta"].format(paso=carpeta_paso(a.paso).upper(), tarjeta=g["tarjeta"], que=a.que, boton=g["boton"],
                                        causa=f" Causa: «{a.causa}»." if a.causa else "")
    c.estado.setdefault("puertas", {})[pend[0]["id"]] = {"paso": carpeta_paso(a.paso), "tipo": a.tipo, "abierta": ahora(), "mensaje": msg}
    c.guardar()
    c.bitacora({"paso": a.paso, "op": "puerta", "tipo": a.tipo, "propuesta": pend[0]["id"]})
    print(msg)


def esperar(c: Corrida, a) -> None:
    """Espera a que la persona resuelva la propuesta en pantalla y anota en la bitácora cuándo y cómo quedó."""
    import time
    abiertas = {pid: g for pid, g in c.estado.get("puertas", {}).items() if g["tipo"] == a.tipo and "cerrada" not in g}
    if not abiertas:
        raise SystemExit(f"{a.paso}: no hay puerta {a.tipo} abierta")
    t0 = time.time()
    while time.time() - t0 < a.max_s:
        status, st = c.banco.op({"op": "bench_state", "run_id": c.run_id})   # sin bitácora: se anota solo la decisión
        if status != 200:
            raise SystemExit(f"bench_state respondió {status}")
        hechas = {p["id"]: p["status"] for p in st["propuestas"] if p["id"] in abiertas and p["status"] != "pendiente"}
        if hechas:
            for pid, status in hechas.items():
                c.estado["puertas"][pid].update({"cerrada": ahora(), "estado": status})
                with open(c.dir / "bitacora-humana.md", "a") as f:
                    f.write(f"| {abiertas[pid]['paso'].upper()} | {datetime.now(BOGOTA).strftime('%H:%M:%S')} | {a.quien} | pantalla | "
                            f"{a.tipo} {status} (propuesta {pid[:8]}) | capturas en {abiertas[pid]['paso']}/ | {a.tipo} web |\n")
            c.guardar()
            c.bitacora({"paso": a.paso, "op": "puerta_resuelta", "tipo": a.tipo, "decisiones": hechas})
            print(f"{a.paso}: {a.tipo} {', '.join(hechas.values())}")
            return
        time.sleep(15)
    raise SystemExit(f"{a.paso}: la puerta {a.tipo} sigue abierta tras {a.max_s} s")


def herramientas(c: Corrida, a) -> None:
    """Qué herramientas llamó Ale (sesiones `api_server` del dueño y ticks `cron`) desde una hora: prueba quién propuso.
    En la oficial del 2-nov el pedido y la apuesta salían `created_by=mcp` igual desde Ale que desde Stock (F-P6e)."""
    import calendar
    import devlab
    vm = devlab.Vm(os.environ.get("BANCO_VM", "sa-assistant-cd75ff1da23bfbf2c1ff79fc256b3189"))
    desde = calendar.timegm(time.strptime(a.desde, "%Y-%m-%dT%H:%M:%SZ"))
    sesiones = [s for s in vm.sessions(desde) if s["source"] in ("api_server", "cron")]
    llamadas = vm.tool_calls([s["id"] for s in sesiones])
    filas = [{"sesion": sid[:48], "propose": sum(1 for t in ts if t and t.endswith("saleads_stock_propose")),
              "herramientas": sorted({t for t in ts if t})} for sid, ts in llamadas.items()]
    nombre = f"herramientas-ale-{datetime.now().strftime('%H%M%S')}.json"
    (c.paso_dir(a.paso) / nombre).write_text(json.dumps({"desde": a.desde, "sesiones": filas}, ensure_ascii=False, indent=1) + "\n")
    total = sum(f["propose"] for f in filas)
    print(f"{a.paso}: {nombre} — Ale llamó saleads_stock_propose {total} veces desde {a.desde}")


def proveedor(c: Corrida, a) -> None:
    r = c.op({"op": "bench_supplier_reply", "texto": a.texto}, a.paso)
    print(f"{a.paso}: respuesta simulada del proveedor entregada {r}")


def cerrar(c: Corrida, a) -> None:
    r = c.op({"op": "bench_close"}, "cierre")
    c.estado["cerrada"] = ahora()
    c.guardar()
    print(f"corrida cerrada: {r}")


# ---- barrido de secretos -----------------------------------------------------------------------------------------
PATRONES = {
    "token de dispositivo": r"ale_dev_[A-Za-z0-9_-]{8,}",
    "token de Meta": r"\bEAA[A-Za-z0-9]{30,}",
    "llave de GCP": r"\bAIza[0-9A-Za-z_-]{35}\b|\bya29\.[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "URL firmada": r"X-Goog-Signature",
    "token de Cloudflare": r"(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET)\s*[=:]\s*\S{20,}",
    "teléfono en claro": r"\+?57[\s-]?3\d{2}[\s-]?\d{3}[\s-]?\d{4}",
}


def valores_locales() -> list[str]:
    """Valores de los .env locales (credenciales y números): se buscan literales sin imprimirlos nunca."""
    vals = []
    for env in (Path.home() / ".config/inventario-vivo").glob("*.env"):
        for linea in env.read_text().splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                v = linea.split("=", 1)[1].strip().strip('"')
                if len(v) >= 8:
                    vals.append(v)
    return vals


def barrer(carpeta: Path, literales: list[str] | None = None) -> list[str]:
    literales = valores_locales() if literales is None else literales
    hallazgos = []
    for ruta in sorted(carpeta.rglob("*")):
        if not ruta.is_file() or ruta.suffix.lower() in (".jpg", ".jpeg", ".png", ".mp4", ".pdf"):
            continue
        texto = ruta.read_text(errors="replace")
        for nombre, patron in PATRONES.items():
            if re.search(patron, texto, re.I if nombre == "URL firmada" else 0):
                hallazgos.append(f"{ruta}: {nombre}")
        if any(v in texto for v in literales):
            hallazgos.append(f"{ruta}: valor de un .env local")
    return hallazgos


def barrido(a) -> None:
    h = barrer(Path(a.carpeta))
    print("\n".join(h) if h else "barrido limpio")
    if h:
        raise SystemExit(1)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="orden", required=True)
    for nombre in ("iniciar", "digests", "sembrar", "escena", "salto", "tick", "campana", "documento", "turno", "traer", "estado", "sql", "proveedor", "cerrar", "puerta", "esperar", "herramientas"):
        p = sub.add_parser(nombre)
        p.add_argument("--corrida", required=True)
        p.add_argument("--paso", default="p00")
        if nombre == "iniciar":
            p.add_argument("--ofertas", required=True)
        if nombre == "sembrar":
            p.add_argument("--hasta", choices=["p2"], help="deja el estado del final del P2 (prueba corta del tramo P3–P6)")
            p.add_argument("--rotar", action="store_true", help="rota la sesión del negocio antes de sembrar (apagado: la oficial va con la sesión con historia)")
        if nombre == "salto":
            p.add_argument("--dias", type=int)
            p.add_argument("--previstas", type=float)
            p.add_argument("--pedido", type=int)
        if nombre == "campana":
            p.add_argument("--propuesta", required=True)
            p.add_argument("--previstas", type=float)
        if nombre == "documento":
            p.add_argument("--cantidad", type=int)
            p.add_argument("--precio", type=int)
        if nombre == "estado":
            p.add_argument("--movimiento")
        if nombre == "sql":
            p.add_argument("consulta", choices=sorted(x.stem for x in CONSULTAS.glob("*.sql")))
        if nombre in ("puerta", "esperar"):
            p.add_argument("--tipo", required=True, choices=["apuesta", "autonomia", "conteo", "entrada", "kit", "pedido"])
        if nombre == "puerta":
            p.add_argument("--que", default="")
            p.add_argument("--causa")
        if nombre == "esperar":
            p.add_argument("--max-s", dest="max_s", type=int, default=3600)
            p.add_argument("--quien", default="owner", help="quién hace el clic, tal como se anota en la bitácora")
        if nombre == "herramientas":
            p.add_argument("--desde", required=True, help="hora UTC, AAAA-MM-DDTHH:MM:SSZ")
        if nombre in ("proveedor", "turno"):
            p.add_argument("--texto", required=True)
    b = sub.add_parser("barrido")
    b.add_argument("carpeta")
    a = ap.parse_args(argv)
    if a.orden == "barrido":
        return barrido(a)
    c = Corrida(a.corrida)
    if a.orden != "iniciar" and not c.estado.get("run_id"):
        raise SystemExit(f"sin corrida en {a.corrida}: primero `iniciar`")
    globals()[a.orden](c, a)


if __name__ == "__main__":
    main()
