"""Reloj del simulador en modo Stock: N ticks por día simulado, contra la VM real de dev.

Procedencia: `docs/tasks/saleads-agente-marketing-loop-v1/pruebas/e2e/sim/clock.py` (sale -ads, sha en README). Se
conserva la idea (el reloj comprime el tiempo, el dueño con personaje contesta cada mensaje de Ale, cada vuelta deja
bitácoras) y se cambia todo lo demás:

- Exactamente `ticks_por_dia` ticks por día simulado. No hereda `MAX_TICKS=4` ni el corte tras 2 silencios.
- El tiempo lo mueve `bench_clock` del banco (reloj por negocio), no la fecha de Hermes.
- Hermes, Kanban, MCP, Stock y las reglas de `src/stock` son los reales de dev. Simulados: la dueña (Muse), las ventas
  (`bench_seed`, método `semilla`), el proveedor (`bench_supplier_reply`), la campaña (`bench_campaign`) y la repisa
  (imágenes de IVB-022 con `robot/ojo` real y SAM real).
- Lo que implica plata se aprueba en pantalla. Con `--web manual` el reloj deja la decisión de la dueña en
  `web/pendiente-<id>.json` y espera `web/hecho-<id>.json`, que escribe quien hizo clic en la pantalla de Stock real.

Uso: python clock.py scenarios/masquebella.yaml --dias 1 --out <dir> [--ticks 1] [--web manual|no] [--desde-dia N]
Entorno: SIM_NEGOCIO, SIM_VM, SIM_OFERTAS (json fuera del repo), META_API_KEY, SIM_RUN_ID (opcional, para reanudar).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import devlab  # noqa: E402
import judge as juez  # noqa: E402
import meter  # noqa: E402
from owner import Owner  # noqa: E402
from world import Supplier, World  # noqa: E402

BOGOTA = timezone(timedelta(hours=-5))
QUIET_S = int(os.environ.get("SIM_QUIET_S", "100"))
TICK_MAX_S = int(os.environ.get("SIM_TICK_MAX_S", "900"))
OWNER_MAX_EXCHANGES = 3


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Log:
    def __init__(self, out: Path):
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def write(self, name: str, row: dict[str, Any]) -> None:
        row = {"t": now_iso(), **row}
        with self.lock, open(self.out / f"{name}.jsonl", "a", encoding="utf-8") as f:
            f.write(devlab.redact(json.dumps(row, ensure_ascii=False, default=str)) + "\n")

    def say(self, msg: str) -> None:
        print(f"{datetime.now().strftime('%H:%M:%S')} {devlab.redact(msg)}", flush=True)


class Robot(threading.Thread):
    """Robot simulado: hilo de eventos real del canal robot. `foto` la atiende `robot/ojo` real (SAM real); `decir` pasa
    a la cola de la dueña, que lo oye. Basado en el `robot_sim.py` de IVB-027."""

    def __init__(self, banco: devlab.Banco, log: Log, out: Path, manifest: Path):
        super().__init__(daemon=True)
        self.banco, self.log, self.out = banco, log, out
        self.decir: queue.Queue = queue.Queue()
        self.cursor = int((out / "cursor").read_text()) if (out / "cursor").exists() else 0
        self.busy = threading.Event()
        self.stop = threading.Event()
        self.fotos: list[dict[str, Any]] = []
        sys.path.insert(0, str(HERE.parent / "robot" / "ojo"))
        os.environ.setdefault("ALE_RUNTIME_URL", devlab.GATEWAY)
        os.environ["ALE_DEVICE_TOKEN"] = banco.token
        import camara  # noqa: E402
        import ojo  # noqa: E402
        self.nube = ojo.Nube(out / "no-existe.env")
        cam = camara.abrir("carpeta:" + str(manifest), "")
        self.ojo = ojo.Ojo(ojo.BusNulo(), self.nube, cam, out / "ojo-datos")
        self.manifest = manifest

    def scene(self, scene_id: str) -> None:
        self.manifest.with_name("escena_actual").write_text(scene_id)

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                for ev in self.banco.events(self.cursor):
                    if ev["id"] <= self.cursor:
                        continue
                    self.log.write("eventos_robot", {"id": ev["id"], "kind": ev["kind"], "payload": ev["payload"]})
                    if ev["kind"] == "foto":
                        self.busy.set()
                        p = ev["payload"]
                        self.nube.op({"op": "event_ack", "event_id": ev["id"], "estado": "recibido"})
                        escena = self.manifest.with_name("escena_actual").read_text().strip()
                        try:
                            res = self.ojo.atender({"solicitud_id": p["solicitud_id"], "concepto": p["concepto"], "etiqueta": p["etiqueta"], "foto_id": p.get("foto_id")})
                            total = res and res.get("total")
                        except Exception as e:  # noqa: BLE001 — el robot reporta y sigue
                            total = f"error {type(e).__name__}"
                        self.fotos.append({"solicitud_id": p["solicitud_id"], "escena": escena, "concepto": p["concepto"], "foto_id": p.get("foto_id"), "total": total})
                        self.log.write("fotos_robot", self.fotos[-1])
                        self.busy.clear()
                    else:
                        self.nube.op({"op": "event_ack", "event_id": ev["id"], "estado": "hecho" if ev["kind"] == "decir" else "descartado"})
                        if ev["kind"] == "decir":
                            self.decir.put(ev)
                    self.cursor = ev["id"]
                    (self.out / "cursor").write_text(str(self.cursor))
            except Exception as e:  # noqa: BLE001 — reconecta
                if self.stop.is_set():
                    return
                time.sleep(3)


class PiRobot:
    """La Pi pareada es el robot: ella abre el hilo de eventos, toma la foto (cámara `carpeta:`, SAM real) y habla. El Mac
    no abre `op:events` (la conexión más nueva cerraría la de la Pi): elige la escena por SSH y oye los `decir` en la base."""

    def __init__(self, sim: "Sim"):
        self.sim = sim
        self.decir: queue.Queue = queue.Queue()
        self.busy = threading.Event()
        self.stop = threading.Event()
        self.fotos: list[dict[str, Any]] = []
        # Desde el último evento que ya existe: los `decir` de corridas anteriores no son de este día (el primer intento del
        # 2-nov los leyó todos y la dueña contestó avisos viejos).
        self.seen = int(sim.state.get("pi_evento_visto") or 0) or int(devlab.retry(lambda: sim.sql.query(
            "SELECT coalesce(max(id), 0)::bigint AS m FROM assistant.stock_robot_events WHERE business_id = $1", [sim.negocio]))[0]["m"])
        self.host = os.environ.get("SIM_PI_HOST", "jolly-pi-1")
        self.scene_file = os.environ.get("SIM_PI_ESCENA", "/home/pi/ale/ojo/banco/escena_actual")
        self.escena = sim.state.get("escena") or "S5-a"

    def start(self) -> None:
        self.scene(self.escena)

    def scene(self, scene_id: str) -> None:
        import subprocess
        if not scene_id.replace("-", "").isalnum():
            raise ValueError("escena inválida")
        for intento in range(4):   # la Pi va por Tailscale: un corte de SSH no debe tumbar el día
            try:
                subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.host, f"echo {scene_id} > {self.scene_file}"], check=True, timeout=40)
                break
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
                if intento == 3:
                    raise
                time.sleep(15)
        self.escena = scene_id
        self.sim.state["escena"] = scene_id

    def poll(self) -> None:
        rows = devlab.retry(lambda: self.sim.sql.query(
            "SELECT id, kind, payload, status, recorded_at FROM assistant.stock_robot_events WHERE business_id = $1 AND id > $2 ORDER BY id",
            [self.sim.negocio, self.seen]))
        for ev in rows:
            self.seen = max(self.seen, int(ev["id"]))
            self.sim.log.write("eventos_robot", {"id": ev["id"], "kind": ev["kind"], "payload": ev["payload"], "status": ev["status"]})
            if ev["kind"] == "decir":
                self.decir.put(ev)
            elif ev["kind"] == "foto":
                p = ev["payload"] or {}
                self.fotos.append({"solicitud_id": p.get("solicitud_id"), "escena": self.escena, "concepto": p.get("concepto"), "foto_id": p.get("foto_id"), "t": now_iso()})
                self.sim.log.write("fotos_robot", self.fotos[-1])
        self.sim.state["pi_evento_visto"] = self.seen


class Sim:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.sc = yaml.safe_load(Path(args.escenario).read_text(encoding="utf-8"))
        self.out = Path(args.out)
        self.log = Log(self.out)
        self.state_path = self.out / "estado.json"
        self.state: dict[str, Any] = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.negocio = os.environ["SIM_NEGOCIO"]
        self.ofertas: dict[str, Any] = self.state.get("ofertas") or {}
        self.world = World.from_scenario(self.sc)
        self.banco = devlab.Banco()
        self.sql = devlab.Sql()
        self.vm = devlab.Vm(os.environ["SIM_VM"])
        self.owner = Owner(HERE / "duenos" / f"{self.sc['dueno']}.yaml")
        self.owner.keep_history(self.out / "dueno-historial.json")
        ps = self.sc["proveedor_sintetico"]
        self.supplier = Supplier(lista=ps["lista"], piso=ps["piso"], paso=ps["paso"], presion=ps["presion"])
        self.run_id = self.state.get("run_id") or os.environ.get("SIM_RUN_ID") or str(uuid.uuid4())
        self.state["run_id"] = self.run_id
        self.lote = int(self.state.get("lote", 0))
        self.seeded: list[str] = list(self.state.get("semillas_propuestas", []))
        self.ticks: list[dict[str, Any]] = list(self.state.get("ticks", []))
        self.supplier_seen: set[str] = set(self.state.get("proveedor_visto", []))
        self.proposal_seen: set[str] = set(self.state.get("propuestas_vistas", []))
        self.started_epoch = float(self.state.get("inicio_epoch") or time.time())
        self.state["inicio_epoch"] = self.started_epoch
        if "base_sesiones" not in self.state:
            self.state["base_sesiones"] = devlab.retry(lambda: meter.baseline(self.vm))
        self.save()

    def save(self) -> None:
        self.state.update({"lote": self.lote, "semillas_propuestas": self.seeded, "ticks": self.ticks, "proveedor_visto": sorted(self.supplier_seen),
                           "propuestas_vistas": sorted(self.proposal_seen), "dueno_uso": self.owner.usage})
        self.state_path.write_text(json.dumps(self.state, ensure_ascii=False, indent=1))

    # ---- banco -------------------------------------------------------------------------------------------------------

    def op(self, body: dict[str, Any]) -> Any:
        status, out = self.banco.op({**body, "run_id": self.run_id})
        self.log.write("banco", {"op": body["op"], "status": status, "resp": out if body["op"] != "bench_state" else {"ahora": (out or {}).get("ahora") if isinstance(out, dict) else out}})
        if status != 200:
            raise RuntimeError(f"{body['op']} {status} {str(out)[:300]}")
        return out

    def seed(self, aplicar: list[dict] | None = None, propuestas: list[dict] | None = None, proveedores: list[dict] | None = None,
             presupuestos: dict[str, int] | None = None, nombre: str = "lote") -> dict[str, Any]:
        semilla = {"negocio_id": self.negocio, "nombre": f"IVB-023 {self.sc['nombre']}"[:80], "semilla": f"{self.sc['semilla']}-{self.lote}-{nombre}"[:80],
                   "proveedores": proveedores or [], "aplicar": aplicar or [], "propuestas": propuestas or [], "presupuestos": presupuestos or {}}
        out = self.op({"op": "bench_seed", "semilla": semilla, "lote": self.lote, "ultimo": False})
        self.log.write("semillas", {"lote": self.lote, "nombre": nombre, "aplicar": aplicar or [], "propuestas": propuestas or [], "proveedores": proveedores or [], "resp": out})
        self.lote += 1
        self.save()
        return out

    def set_clock(self, offset: int) -> str:
        out = self.op({"op": "bench_clock", "offset_seconds": int(offset)})
        return out["ahora"]

    def variants(self) -> dict[str, str]:
        st = self.op({"op": "bench_state"})
        by = {(v["producto"], v["variante"]): v["id"] for v in st["variantes"]}
        return {p.key: by.get((p.nombre, p.variante)) for p in self.world.products.values()}

    # ---- semilla: catálogo, historia de 8 semanas y presupuestos ------------------------------------------------------

    def resolve_offers(self) -> dict[str, Any]:
        """Ofertas vigentes del negocio, leídas al sembrar: los ids cambian si el dueño reconecta el negocio (2-nov, 14:15Z).
        Se piden por el canal robot, de solo lectura, y se casan por nombre con el escenario."""
        import re as _re
        # Solo el canal robot trae vínculo de negocio autenticado: la API de Hermes sin sesión del dueño se niega (bien).
        r = self.banco.turn("Prueba IVB-023, solo lectura: lista todas las ofertas del negocio seleccionado, una por línea, "
                            "con este formato exacto: id | tipo | nombre. Sin comentarios.")
        items = []
        for line in (r.get("texto") or "").splitlines():
            parts = [x.strip() for x in line.split("|")]
            if len(parts) >= 3 and _re.fullmatch(r"[0-9a-f-]{36}", parts[0]):
                items.append({"id": parts[0], "type": parts[1], "name": parts[2]})
        if not items:
            raise RuntimeError("no pude leer las ofertas: " + (r.get("texto") or str(r))[:200])
        found, ambiguas = {}, {}
        for key, pattern in self.sc["ofertas_por_nombre"].items():
            match = [o for o in items if _re.search(pattern, o["name"], _re.I)]
            if not match:
                self.log.write("ofertas", {"leidas": items, "sin_coincidencia": key})
                raise RuntimeError(f"oferta {key}: sin coincidencia para {pattern!r}")
            if len(match) > 1:   # duplicadas tras reconectar: se usa la primera que lista SaleADS, y se anota
                ambiguas[key] = [o["id"] for o in match]
            found[key] = {"type": match[0]["type"], "id": match[0]["id"]}
        self.log.write("ofertas", {"leidas": items, "resueltas": {k: v["id"] for k, v in found.items()}, "ambiguas": ambiguas})
        return found

    def bootstrap(self) -> None:
        if self.state.get("semilla_lista"):
            return
        if not self.ofertas:
            self.ofertas = json.loads(Path(os.environ["SIM_OFERTAS"]).read_text()) if os.environ.get("SIM_OFERTAS") else self.resolve_offers()
            self.state["ofertas"] = self.ofertas
            self.save()
        real = datetime.now(timezone.utc)
        budgets = self.sc["presupuestos"]["dia" if self.args.dias <= 1 else "semana"]
        # El reloj se mueve después de la primera semilla: `bench_clock` exige corrida activa, y la crea `bench_seed`.
        grupos: dict[str, list] = {}
        for p in self.world.products.values():
            grupos.setdefault(p.nombre, []).append(p)
        cat = []
        for nombre, ps in grupos.items():
            cat.append({"idempotency_key": f"{self.run_id[:8]}-cat-{ps[0].key}", "kind": "catalogo",
                        "detalle": {"producto": nombre, "variantes": [{"nombre": p.variante} for p in ps], "oferta": self.ofertas[ps[0].oferta]}})
        self.seed(aplicar=cat, presupuestos=budgets, nombre="catalogo")
        self.set_clock(0)
        var = self.variants()
        if None in var.values():
            raise RuntimeError(f"variantes sin crear: {var}")
        self.state["variantes"] = var
        provs = []
        for pv in self.sc["proveedores"]:
            pid = str(uuid.uuid5(uuid.UUID(self.run_id), pv["id_clave"]))
            self.state.setdefault("proveedores", {})[pv["id_clave"]] = pid
            provs.append({"id": pid, "nombre": pv["nombre"], "dias_entrega": pv["dias_entrega"],
                          "cotizaciones": [{"variante_id": var[q["producto"]], "precio": q["precio"], "flete": q["flete"], "minimo": q["minimo"],
                                            "plazo_pago_dias": q["plazo_pago_dias"], "garantia": q["garantia"], "prueba_equivalencia": None, "moneda": q["moneda"]}
                                           for q in pv["cotizaciones"]]})
        weeks = int(self.sc["historia_semanas"])
        hist = {k: self.world.weekly_history(k, weeks) for k in self.world.products}
        self.state["historia"] = hist
        inicial = [{"idempotency_key": f"{self.run_id[:8]}-c0-{k}", "kind": "conteo", "causa": "otra",
                    "detalle": {"variante_id": var[k], "contado": p.stock_inicial + sum(hist[k]), "origen": "voz"}}
                   for k, p in self.world.products.items() if p.stock_inicial + sum(hist[k]) > 0]
        self.seed(aplicar=inicial, proveedores=provs, nombre="conteo-inicial")
        for w in range(weeks):
            self.set_clock(w * 7 * 86400 + 3 * 86400)
            ventas = [{"idempotency_key": f"{self.run_id[:8]}-h{w}-{k}", "kind": "venta", "detalle": {"variante_id": var[k], "cantidad": hist[k][w], "nota": "historia simulada"}}
                      for k in self.world.products if hist[k][w] > 0]
            if ventas:
                self.seed(aplicar=ventas, nombre=f"historia-s{w}")
        start_local = (real.astimezone(BOGOTA) + timedelta(days=weeks * 7)).replace(hour=int(self.sc["hora_primer_tick"]), minute=0, second=0, microsecond=0)
        self.state["offset_base"] = int((start_local - real).total_seconds())
        self.state["reloj_inicio"] = start_local.isoformat()
        self.state["semilla_lista"] = True
        self.save()
        self.log.say(f"semilla lista: run {self.run_id}, {len(var)} variantes, inicio simulado {start_local.isoformat()}")

    # ---- dueña ------------------------------------------------------------------------------------------------------

    def hechos(self, dia: int) -> list[str]:
        h = [f"Hoy es el día {dia} de la semana simulada."]
        for f in self.world.unreported(dia):
            h.append(f"Le fiaste {f['cantidad']} de {self.world.products[f['producto']].nombre} a {f['a']} y no lo anotaste.")
        return h

    def owner_turn(self, text: str, dia: int, tick: int, regla: list[str], hechos: list[str]) -> str:
        r = self.banco.turn(text)
        jolly = r.get("texto") or ""
        tools = [e.get("name") for e in r.get("eventos", []) if e.get("t") == "tool_start"]
        self.log.write("dueno", {"tipo": "turno", "dia": dia, "tick": tick, "regla": regla, "dueno": text, "jolly": jolly, "status": r.get("status"),
                                 "ms": r.get("ms"), "herramientas": tools, "hechos": hechos})
        self.log.say(f"  dueña: {text[:110]}")
        self.log.say(f"  jolly: {jolly[:160]} [{','.join(t for t in tools if t)}]")
        return jolly

    def converse(self, first_text: str, dia: int, tick: int, regla: list[str], hechos: list[str]) -> None:
        jolly = self.owner_turn(first_text, dia, tick, regla, hechos)
        for _ in range(OWNER_MAX_EXCHANGES - 1):
            if not jolly:
                return
            asks = self.owner.read(jolly)
            if not (asks.get("pregunta") or asks.get("pide_confirmar_conteo") or asks.get("pide_causa") or asks.get("pide_variante")):
                return
            jolly = self.owner_turn(self.owner.say(jolly, hechos), dia, tick, regla, hechos)

    def hear(self, dia: int, tick: int) -> None:
        """Avisos `decir` del robot: la dueña los oye y contesta si le preguntan algo."""
        if isinstance(self.robot, PiRobot):
            self.robot.poll()
        while True:
            try:
                ev = self.robot.decir.get_nowait()
            except queue.Empty:
                return
            texto = (ev.get("payload") or {}).get("texto", "")
            self.log.write("dueno", {"tipo": "oye", "dia": dia, "tick": tick, "jolly": texto, "evento": ev["id"]})
            asks = self.owner.read(texto)
            if asks.get("pregunta") or asks.get("pide_confirmar_conteo") or asks.get("pide_causa") or asks.get("pide_variante"):
                self.converse(self.owner.say(texto, self.current_hechos), dia, tick, [], self.current_hechos)

    # ---- pantalla ---------------------------------------------------------------------------------------------------

    def screen(self, dia: int, tick: int) -> None:
        rows = devlab.retry(lambda: self.sql.query(
            "SELECT id, kind, title, reason, payload, status, revision, effects_yes, recorded_at FROM assistant.stock_proposals "
            "WHERE run_id = $1 AND status = 'pendiente' AND created_by <> 'banco' ORDER BY recorded_at", [self.run_id]))
        for p in rows:
            if p["id"] in self.proposal_seen or p["kind"] == "conteo":
                continue
            self.proposal_seen.add(p["id"])
            texto = f"{p['title']}\n{p['reason']}\nDetalle: {json.dumps(p['payload'], ensure_ascii=False)[:1500]}\nSi apruebas: {p.get('effects_yes')}"
            dec = self.owner.decide(texto, self.current_hechos)
            self.log.write("dueno", {"tipo": "decision", "dia": dia, "tick": tick, "proposal_id": p["id"], "kind": p["kind"], **dec})
            self.log.say(f"  pantalla: {p['kind']} {p['id'][:8]} -> {dec['decision']} ({dec['motivo'][:80]})")
            if dec["decision"] in ("aprobar", "rechazar") and self.args.web == "manual":
                web = self.out / "web"
                web.mkdir(exist_ok=True)
                (web / f"pendiente-{p['id']}.json").write_text(json.dumps({"proposal_id": p["id"], "kind": p["kind"], "decision": dec["decision"],
                                                                         "causa": None, "titulo": p["title"]}, ensure_ascii=False))
                self.log.say(f"  ESPERA CLIC WEB: {dec['decision']} {p['kind']} {p['id']}")
                deadline = time.time() + int(os.environ.get("SIM_WEB_WAIT_S", "1500"))
                while time.time() < deadline and not (web / f"hecho-{p['id']}.json").exists():
                    time.sleep(10)
                hecho = (web / f"hecho-{p['id']}.json")
                self.log.write("web", {"proposal_id": p["id"], "decision": dec["decision"], "hecho": json.loads(hecho.read_text()) if hecho.exists() else None})
        self.save()

    # ---- proveedor --------------------------------------------------------------------------------------------------

    def supplier_step(self) -> None:
        rows = devlab.retry(lambda: self.sql.query(
            "SELECT m.id, m.order_id, m.direction, m.body, m.sent_at, m.blocked_reason, m.recorded_at FROM assistant.stock_supplier_messages m "
            "JOIN assistant.stock_orders o ON o.id = m.order_id WHERE o.run_id = $1 ORDER BY m.recorded_at", [self.run_id]))
        for m in rows:
            if m["id"] in self.supplier_seen:
                continue
            self.supplier_seen.add(m["id"])
            if m["direction"] != "saliente" or not m.get("sent_at"):
                continue
            reply = self.supplier.reply(m["body"])
            self.log.write("proveedor", {"stock": m["body"], "proveedor": reply, "ronda": self.supplier.rondas})
            self.log.say(f"  proveedor <- {m['body'][:100]} | -> {str(reply)[:100]}")
            if reply:
                self.op({"op": "bench_supplier_reply", "texto": reply})
        self.save()

    # ---- tick -------------------------------------------------------------------------------------------------------

    def sales(self, dia: int, slot: int) -> None:
        """Ventas del tramo. El mundo no vende lo que no hay: la demanda que pasa el saldo del libro es quiebre, no venta
        (la semana del 2-nov cayó con `STOCK_NEGATIVE` al vender mascarillas por encima del saldo)."""
        var = self.state["variantes"]
        fijas = (self.sc.get("ventas_fijas") or {}).get(str(dia), {})
        spd = int(self.sc["ticks_por_dia"])
        rows = devlab.retry(lambda: self.sql.query("SELECT variant_id, sum(delta)::int AS saldo FROM assistant.stock_movements WHERE run_id = $1 GROUP BY 1", [self.run_id]))
        saldo = {r["variant_id"]: int(r["saldo"]) for r in rows}
        items, quiebres = [], []
        for k in self.world.products:
            demanda = fijas[k][slot] if k in fijas and slot < len(fijas[k]) else self.world.sales(k, dia, slot, spd)
            n = min(demanda, max(0, saldo.get(var[k], 0)))
            if demanda > n:
                quiebres.append({"producto": k, "demanda": demanda, "vendido": n})
            if n > 0:
                items.append({"idempotency_key": f"{self.run_id[:8]}-v{dia}-{slot}-{k}", "kind": "venta", "detalle": {"variante_id": var[k], "cantidad": n, "nota": "venta simulada"}})
        if quiebres:
            self.log.write("quiebres", {"dia": dia, "tramo": slot + 1, "quiebres": quiebres})
        if items:
            self.seed(aplicar=items, nombre=f"ventas-d{dia}-t{slot + 1}")

    def quiet_wait(self, dia: int, tick: int) -> dict[str, Any]:
        t0 = time.time()
        last_change, last_sig = time.time(), None
        while time.time() - t0 < TICK_MAX_S:
            time.sleep(20)
            self.hear(dia, tick)
            self.supplier_step()
            self.screen(dia, tick)
            ses = devlab.retry(lambda: self.vm.sessions(t0 - 5))
            sig = json.dumps(sorted((s["id"], s.get("last_active"), s.get("input_tokens")) for s in ses))
            if sig != last_sig or self.robot.busy.is_set() or not self.robot.decir.empty():
                last_sig, last_change = sig, time.time()
            elif time.time() - last_change >= QUIET_S:
                return {"quieto": True, "s": int(time.time() - t0), "sesiones": len(ses)}
        return {"quieto": False, "s": int(time.time() - t0)}

    def fallback(self, dia: int, tick: int) -> None:
        rb = self.sc.get("respaldo") or {}
        var = self.state["variantes"]
        props = devlab.retry(lambda: self.sql.query("SELECT kind, status FROM assistant.stock_proposals WHERE run_id = $1", [self.run_id]))
        pa = rb.get("pedido_aceite")
        if pa and dia == pa["dia"] and tick == pa["tick"] and not any(p["kind"] == "pedido" and p["status"] == "aprobada" for p in props):
            self.seed(aplicar=[{"idempotency_key": f"{self.run_id[:8]}-resp-pedido", "kind": "pedido",
                                "detalle": {"variante_id": var["aceite"], "proveedor_id": self.state["proveedores"]["prov_aceite"], "cantidad": pa["cantidad"],
                                            "mandato": self.sc["mandato"]}}], nombre="respaldo-pedido")
            self.log.write("respaldo", {"que": "pedido", "dia": dia, "tick": tick})
        ap = rb.get("apuesta")
        if ap and dia == ap["dia"] and tick == ap["tick"] and not any(p["kind"] == "apuesta" and p["status"] == "aprobada" for p in props):
            self.seed(aplicar=[{"idempotency_key": f"{self.run_id[:8]}-resp-apuesta", "kind": "apuesta",
                                "detalle": {"variante_id": var[ap["producto"]], "presupuesto_diario": ap["presupuesto_diario"], "tope": ap["tope"],
                                            "duracion_dias": ap["duracion_dias"], "unidades_semana_previstas": ap["unidades_semana_previstas"], "fuente_prevision": "supuesto"}}],
                      nombre="respaldo-apuesta")
            self.log.write("respaldo", {"que": "apuesta", "dia": dia, "tick": tick})

    def campaigns(self, dia: int, tick: int) -> None:
        rows = devlab.retry(lambda: self.sql.query(
            "SELECT p.id, p.payload FROM assistant.stock_proposals p WHERE p.run_id = $1 AND p.kind = 'apuesta' AND p.status = 'aprobada' "
            "AND NOT EXISTS (SELECT 1 FROM assistant.stock_sim_campaigns c WHERE c.run_id = p.run_id AND c.variant_id = (p.payload->>'variante_id')::uuid)", [self.run_id]))
        for p in rows:
            out = self.op({"op": "bench_campaign", "proposal_id": p["id"], "senales": self.sc.get("campana_senales") or {}})
            self.log.write("campanas", {"proposal_id": p["id"], "payload": p["payload"], "resp": out, "dia": dia, "tick": tick})

    def tick(self, dia: int, slot: int) -> None:
        tick = slot + 1
        spd = int(self.sc["ticks_por_dia"])
        offset = self.state["offset_base"] + (dia - 1) * 86400 + slot * (86400 // spd)
        ahora = self.set_clock(offset)
        self.log.say(f"día {dia} tick {tick} reloj {ahora}")
        # Los hechos se acumulan en el día: un aviso de la tarde sobre el conteo de la mañana debe encontrar lo que ella sabía.
        if self.state.get("hechos_dia") != dia:
            self.state["hechos_dia"], self.state["hechos"] = dia, self.hechos(dia)
        self.current_hechos = list(self.state["hechos"])
        if slot > 0:
            self.sales(dia, slot - 1)
        self.fallback(dia, tick)
        self.campaigns(dia, tick)
        for paso in (self.sc.get("dias") or {}).get(str(dia), []):
            if paso["tick"] != tick:
                continue
            if paso.get("si") == "pedido_acordado" and not self.sql.query("SELECT 1 FROM assistant.stock_orders WHERE run_id=$1 AND status='acordado'", [self.run_id]):
                self.log.write("guion", {"dia": dia, "tick": tick, "omitido": paso.get("regla"), "motivo": "sin pedido acordado"})
                continue
            if paso.get("escena"):
                self.robot.scene(paso["escena"])
                self.log.write("guion", {"dia": dia, "tick": tick, "escena": paso["escena"], "regla": paso.get("regla")})
            hechos = self.current_hechos + [h for h in paso.get("hechos", []) if h not in self.current_hechos]
            self.current_hechos = hechos
            self.state["hechos"] = hechos
            self.converse(self.owner.opener(paso["dice"], hechos), dia, tick, paso.get("regla") or [], hechos)
            self.state.setdefault("guion_hecho", []).append([dia, tick, paso.get("regla")])
        wake = self.op({"op": "bench_tick"})
        espera = self.quiet_wait(dia, tick)
        gasto = meter.spend(self.vm, self.started_epoch, self.owner, self.sql, self.run_id, self.state.get("base_sesiones"))
        row = {"dia": dia, "tick": tick, "reloj": ahora, "wake": wake.get("status"), **espera, "gasto_usd": gasto["total_usd"], "gasto": gasto}
        self.ticks.append(row)
        self.log.write("ticks", row)
        self.save()
        hechos_total = len(self.ticks)
        objetivo = self.args.dias * spd if not self.args.ticks else self.args.ticks
        proy = gasto["total_usd"] / max(1, hechos_total) * objetivo
        self.log.say(f"  tick listo: wake={wake.get('status')} {espera} gasto US$ {gasto['total_usd']:.2f} (proyección {proy:.2f})")
        if gasto["total_usd"] > float(self.sc["tope_usd"]) or proy > float(self.sc["tope_usd"]):
            self.log.write("parada", {"motivo": "proyección sobre el tope", "gasto": gasto["total_usd"], "proyeccion": proy})
            raise SystemExit(f"PARADA: gasto {gasto['total_usd']:.2f}, proyección {proy:.2f} sobre US$ {self.sc['tope_usd']}")

    def run(self) -> None:
        self.bootstrap()
        manifest = self.out / "repisa" / "manifiesto.json"
        build_manifest(manifest)
        self.robot = PiRobot(self) if self.args.robot == "pi" else Robot(self.banco, self.log, self.out, manifest)
        self.robot.start()
        self.current_hechos = []
        spd = int(self.sc["ticks_por_dia"])
        done = {(t["dia"], t["tick"]) for t in self.ticks}
        count = 0
        for dia in range(self.args.desde_dia, self.args.dias + 1):
            for slot in range(spd):
                if (dia, slot + 1) in done:
                    continue
                self.tick(dia, slot)
                count += 1
                if self.args.ticks and count >= self.args.ticks:
                    break
            if self.args.ticks and count >= self.args.ticks:
                break
        # cierre: deja que termine lo que quedó en curso y junta los datos
        final = self.quiet_wait(self.args.dias, spd)
        self.log.write("cierre", final)
        self.robot.stop.set()
        datos = collect(self)
        (self.out / "datos.json").write_text(devlab.redact(json.dumps(datos, ensure_ascii=False, indent=1, default=str)))
        veredicto = juez.judge(datos)
        (self.out / "veredicto.json").write_text(json.dumps(veredicto, ensure_ascii=False, indent=1, default=str))
        self.log.say(f"VEREDICTO {veredicto['veredicto']} fallas={veredicto['fallas']}")


def build_manifest(path: Path) -> None:
    """Repisa: las imágenes verificadas de IVB-022 con su sha256, con ruta absoluta (fuera del repo)."""
    src = Path(os.environ.get("SIM_IMAGENES", ""))
    m = json.loads((src / "manifiesto.json").read_text())
    path.parent.mkdir(parents=True, exist_ok=True)
    imgs = [{**i, "archivo": str(src / i["archivo"])} for i in m["imagenes"]]
    path.write_text(json.dumps({"version": 1, "nota": "IVB-023: repisa simulada con imágenes de IVB-022", "imagenes": imgs}, ensure_ascii=False))
    if not path.with_name("escena_actual").exists():
        path.with_name("escena_actual").write_text("S5-a")


def collect(sim: Sim) -> dict[str, Any]:
    """Todo lo que el juez necesita, leído de la base (solo lectura) y de las bitácoras."""
    q, run = sim.sql.query, sim.run_id
    rd = lambda name: [json.loads(l) for l in (sim.out / f"{name}.jsonl").read_text().splitlines()] if (sim.out / f"{name}.jsonl").exists() else []
    semillas = rd("semillas")
    claves = {i["idempotency_key"] for s in semillas for i in s.get("aplicar", []) + s.get("propuestas", [])}
    props = q("SELECT id, kind, status, title, reason, payload, idempotency_key, created_by, occurred_at, recorded_at, simulated FROM assistant.stock_proposals WHERE run_id=$1", [run])
    inicio = datetime.fromtimestamp(sim.started_epoch, timezone.utc).isoformat()
    mcp = devlab.mcp_calls(inicio)
    products = sim.world.products
    var = sim.state["variantes"]
    dias = sim.args.dias
    return {
        "run_id": run, "reloj_inicio": sim.state.get("reloj_inicio"), "ticks_por_dia": int(sim.sc["ticks_por_dia"]),
        "propuestas": props, "semillas_propuestas": [p["id"] for p in props if p["idempotency_key"] in claves],
        "confirmaciones": q("SELECT id, proposal_id, method, actor, utterance_id, decision, reason, recorded_at, simulated FROM assistant.stock_confirmations WHERE run_id=$1", [run]),
        "movimientos": q("SELECT id, variant_id, kind, delta, origin, cause, confirmation_id, proposal_id, order_id, occurred_at, recorded_at FROM assistant.stock_movements WHERE run_id=$1", [run]),
        "conteos": q("SELECT id, proposal_id, variant_id, expected, counted, difference, photo_id, cause, confirmation_id, origin FROM assistant.stock_counts WHERE run_id=$1", [run]),
        "fotos": q("SELECT id, status, concept, label, parent_photo_id, total, fuente, recorded_at FROM assistant.stock_photos WHERE run_id=$1", [run]),
        "mensajes_proveedor": q("SELECT m.id, m.direction, m.body, m.sent_at, m.blocked_reason, m.recorded_at, n.max_price, n.target_price FROM assistant.stock_supplier_messages m "
                                "JOIN assistant.stock_orders o ON o.id=m.order_id LEFT JOIN assistant.stock_negotiations n ON n.order_id=o.id WHERE o.run_id=$1", [run]),
        "pedidos": q("SELECT o.id, o.status, o.quantity, o.agreed_cost, o.saving_confirmed, n.state, n.round, n.last_offer FROM assistant.stock_orders o LEFT JOIN assistant.stock_negotiations n ON n.order_id=o.id WHERE o.run_id=$1", [run]),
        "eventos": q("SELECT id, kind, payload, status, recorded_at FROM assistant.stock_robot_events WHERE business_id=$1 AND recorded_at >= $2", [sim.negocio, inicio]),
        "frases": q("SELECT id, text, recorded_at FROM assistant.stock_owner_utterances WHERE user_id=$1 AND recorded_at >= $2", ["2df0d9e4-36b1-4194-b7d4-80f8e5f9065f", inicio]),
        "presupuestos": q("SELECT metric, limit_value, used FROM assistant.stock_run_budgets WHERE run_id=$1", [run]),
        "campanas": [{"t": c["t"], "id": c["proposal_id"], "presupuesto_diario": (c["payload"] or {}).get("presupuesto_diario"),
                      "unidades_previstas": (c["payload"] or {}).get("unidades_semana_previstas") or 0,
                      "saldo": juez.saldo_a({"movimientos": q("SELECT variant_id, delta, occurred_at FROM assistant.stock_movements WHERE run_id=$1", [run])},
                                            (c["payload"] or {}).get("variante_id"), "9999")} for c in rd("campanas")],
        "dueno": rd("dueno"), "ticks": sim.ticks, "mcp": mcp, "guion": rd("guion"), "fotos_robot": rd("fotos_robot"),
        "fotos_r15": [f["solicitud_id"] for f in sim.robot.fotos if f["escena"] == "V-etiquetas-1"],
        "sanos_sin_ventas": [k for k, p in products.items() if p.historia == "sano" and p.semana_sim == "cero" and dias >= 7],
        "lentos": [k for k, p in products.items() if p.historia == "lento"],
        "nombres": {k: p.nombre for k, p in products.items()}, "variantes": var,
        "tope_avisos": 3,
        "exigidas": ["R6", "R14", "R15", "R18", "R19", "R22", "R27"] if dias >= 7 else ["R6", "R14", "R15", "R8/R8b"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("escenario")
    ap.add_argument("--dias", type=int, default=1)
    ap.add_argument("--ticks", type=int, default=0, help="humo: corta tras N ticks")
    ap.add_argument("--desde-dia", type=int, default=1)
    ap.add_argument("--out", required=True)
    ap.add_argument("--web", choices=["manual", "no"], default="manual")
    ap.add_argument("--robot", choices=["pi", "mac"], default="mac", help="pi: la Pi pareada es el robot; mac: robot simulado local")
    Sim(ap.parse_args()).run()


if __name__ == "__main__":
    main()
