"""Transporte del simulador hacia dev, sin secretos en la salida.

Tres puertas, todas de solo lectura salvo el banco:
- `Banco`: el dispositivo de banco del usuario de prueba, por `POST /devices/me/stream` (único canal con vínculo de negocio
  autenticado). Turnos del dueño por voz, órdenes `bench_*` y el hilo de eventos del robot.
- `Vm`: API de Hermes de la VM, desde el pod de ale-runtime con `kubectl exec` (sin SSH). Solo lee sesiones.
- `Sql`: Postgres de dev desde el pod, siempre dentro de `BEGIN READ ONLY ... ROLLBACK`.

La credencial del dispositivo vive en `~/.config/inventario-vivo/banco-dispositivo.env` (`ALE_DEVICE_TOKEN`) y la llave
de Hermes en la metadata de la VM: ninguna se imprime ni se escribe en la evidencia (`redact`).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterator

GATEWAY = os.environ.get("SIM_GATEWAY", "https://gateway-dev.saleads.ai/api/meta-assistant")
UA = "Mozilla/5.0 (X11; Linux) ale-robot/1.0"
NAMESPACE = "saleads"
PROJECT = os.environ.get("SIM_GCP_PROJECT", "saleads-dev")
ZONE = os.environ.get("SIM_GCP_ZONE", "us-central1-a")
ENV_FILE = Path(os.environ.get("SIM_BANCO_ENV", str(Path.home() / ".config/inventario-vivo/banco-dispositivo.env")))
_SECRETS: list[str] = []


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def redact(text: str) -> str:
    for s in _SECRETS:
        if s:
            text = text.replace(s, "[R]")
    return text


def guard_vm(name: str) -> str:
    """Las VMs `sa-assistant-sim-*` son de otra sesión y quedan fuera, por regla de la corrida."""
    if name.startswith("sa-assistant-sim-"):
        raise SystemExit("las VMs sa-assistant-sim-* no se usan en esta corrida")
    return name


class Banco:
    def __init__(self, token: str | None = None, base: str = GATEWAY):
        self.token = token or read_env(ENV_FILE)["ALE_DEVICE_TOKEN"]
        _SECRETS.append(self.token)
        self.base = base

    def _req(self, body: dict[str, Any], accept: str = "application/json") -> urllib.request.Request:
        return urllib.request.Request(self.base + "/devices/me/stream", data=json.dumps(body).encode(), method="POST", headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json", "User-Agent": UA, "Accept": accept})

    def op(self, body: dict[str, Any], timeout: int = 90) -> tuple[int, Any]:
        try:
            with urllib.request.urlopen(self._req(body), timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = (e.read() or b"")[:800].decode(errors="replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, redact(raw)

    def turn(self, text: str, timeout: int = 660) -> dict[str, Any]:
        """Turno del dueño por el canal robot: `captureUtterance` guarda la frase real que luego cita `confirm_count`."""
        t0 = time.time()
        chunks: list[str] = []
        events: list[dict[str, Any]] = []
        try:
            with urllib.request.urlopen(self._req({"text": text}, "text/event-stream"), timeout=timeout) as r:
                name = None
                for raw in r:
                    line = raw.decode().rstrip("\r\n")
                    if line.startswith("event:"):
                        name = line[6:].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    try:
                        e = json.loads(line[5:].strip() or "{}")
                    except ValueError:
                        continue
                    kind = e.get("type") or name
                    if kind == "token":
                        chunks.append(e.get("text", ""))
                    else:
                        events.append({"t": kind, **{k: v for k, v in e.items() if k != "type"}})
        except urllib.error.HTTPError as e:
            return {"status": e.code, "error": redact((e.read() or b"")[:400].decode(errors="replace")), "ms": int((time.time() - t0) * 1000)}
        except (TimeoutError, urllib.error.URLError) as e:
            return {"status": 0, "error": type(e).__name__, "ms": int((time.time() - t0) * 1000)}
        out = {"status": 200, "ms": int((time.time() - t0) * 1000), "texto": "".join(chunks).strip(), "eventos": events}
        return json.loads(redact(json.dumps(out, ensure_ascii=False)))

    def events(self, after: int, timeout: int = 45) -> Iterator[dict[str, Any]]:
        """Hilo de eventos del robot: `foto` y `decir`. Corta solo al vencer el tiempo de lectura."""
        req = self._req({"op": "events", "after": after, "device_state": "activo"}, "text/event-stream")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            name = data = None
            for raw in r:
                line = raw.decode().rstrip("\r\n")
                if line.startswith("event:"):
                    name = line[6:].strip()
                elif line.startswith("data:"):
                    data = line[5:].strip()
                elif not line:
                    if name == "stock" and data:
                        yield json.loads(data)
                    name = data = None


def _pod(prefix: str = "sa-meta-assistant-service-") -> str:
    out = subprocess.check_output(["kubectl", "-n", NAMESPACE, "get", "pods", "--no-headers", "-o", "custom-columns=N:.metadata.name,S:.status.phase"]).decode()
    pods = [l.split()[0] for l in out.splitlines() if l.startswith(prefix) and l.split()[1] == "Running"]
    if not pods:
        raise RuntimeError("sin pod de ale-runtime")
    return pods[0]


def _node(js: str, timeout: int = 90) -> str:
    r = subprocess.run(["kubectl", "-n", NAMESPACE, "exec", "-i", _pod(), "-c", "sa-meta-assistant-service", "--", "sh", "-c", "cd /app && node -"],
                       input=js.encode(), capture_output=True, timeout=timeout)
    return redact(r.stdout.decode(errors="replace")) + (("\nERR " + redact(r.stderr.decode(errors="replace")[-400:])) if r.returncode else "")


class Sql:
    """Solo lectura: cada lote corre en `BEGIN READ ONLY` y termina en `ROLLBACK`."""

    def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        js = ("const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();"
              "try{await c.query('BEGIN READ ONLY');const r=await c.query(%s,%s);process.stdout.write(JSON.stringify(r.rows))}"
              "catch(e){process.stdout.write(JSON.stringify({error:e.message}))}finally{await c.query('ROLLBACK').catch(()=>{});await c.end()}})()"
              % (json.dumps(sql), json.dumps(params or [])))
        out = _node(js)
        try:
            data = json.loads(out[out.find("["):] if out.lstrip().startswith("[") else out[out.find("{"):])
        except ValueError as e:
            raise RuntimeError("sql ilegible: " + out[:300]) from e
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError("sql: " + data["error"])
        return data


class Vm:
    """API de Hermes de la VM, leída desde el pod (la red interna llega; el Mac no)."""

    def __init__(self, name: str):
        self.name = guard_vm(name)
        d = json.loads(subprocess.check_output(["gcloud", "compute", "instances", "describe", self.name, "--project", PROJECT, "--zone", ZONE,
                                                "--format=json(metadata.items,networkInterfaces[0].networkIP,status)"]))
        self.key = [i["value"] for i in d["metadata"]["items"] if i["key"] == "hermes-api-key"][0]
        _SECRETS.append(self.key)
        self.ip = d["networkInterfaces"][0]["networkIP"]
        self.status = d.get("status")

    def js(self, body: str, timeout: int = 90) -> str:
        wrapped = ("const KEY=%s,BASE='http://%s:8642';const api=(p,o={})=>fetch(BASE+p,{...o,headers:{authorization:'Bearer '+KEY,"
                   "'content-type':'application/json',...(o.headers||{})},signal:AbortSignal.timeout(o.t||20000)});(async()=>{%s\n})()"
                   ".catch(e=>console.log(JSON.stringify({error:e.cause?.code||e.message})))") % (json.dumps(self.key), self.ip, body)
        return _node(wrapped, timeout)

    def sessions(self, since_epoch: float) -> list[dict[str, Any]]:
        out = self.js("const r=await api('/api/sessions?limit=500');const j=await r.json();"
                      "process.stdout.write(JSON.stringify((j.data||[]).filter(s=>(s.last_active||s.started_at)>=%d).map(s=>({id:s.id,source:s.source,"
                      "title:(s.title||'').slice(0,80),started_at:s.started_at,last_active:s.last_active,input_tokens:s.input_tokens||0,"
                      "output_tokens:s.output_tokens||0,cache_read_tokens:s.cache_read_tokens||0}))))" % int(since_epoch))
        try:
            return json.loads(out[out.find("["):])
        except ValueError:
            return []

    def tool_calls(self, session_ids: list[str]) -> dict[str, list[str]]:
        out = self.js("const ids=%s;const res={};for(const id of ids){const m=await (await api('/api/sessions/'+id+'/messages')).json();"
                      "res[id]=[];for(const x of m.data||[])for(const c of x.tool_calls||[])res[id].push(c.function?.name)}"
                      "process.stdout.write(JSON.stringify(res))" % json.dumps(session_ids), timeout=180)
        try:
            return json.loads(out[out.find("{"):])
        except ValueError:
            return {}


def mcp_calls(since_iso: str, until_iso: str = "9999", subject: str = "2df0d9e4") -> list[dict[str, str]]:
    """Llamadas del MCP del usuario de prueba, en los dos pods. Da nombre y resultado, no argumentos."""
    pods = [l.split("/")[-1] for l in subprocess.check_output(["kubectl", "-n", NAMESPACE, "get", "pods", "-o", "name"]).decode().split()
            if "sa-mcp-server-" in l]
    rows = []
    for p in pods:
        out = subprocess.run(["kubectl", "-n", NAMESPACE, "logs", p, "-c", "sa-mcp-server", "--since=24h"], capture_output=True).stdout.decode(errors="replace")
        for line in out.splitlines():
            if "mcp.tool_call" not in line or subject not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if since_iso <= d.get("time", "") <= until_iso:
                rows.append({"time": d["time"], "tool": d.get("tool", ""), "outcome": d.get("outcome", ""),
                             "client": str(d.get("clientId", ""))[-12:], "code": d.get("errorCode") or str(d.get("status") or "")})
    return sorted(rows, key=lambda r: r["time"])


def retry(fn: Callable[[], Any], tries: int = 3, wait: float = 5) -> Any:
    for i in range(tries):
        try:
            return fn()
        except Exception:  # noqa: BLE001 — transporte frágil (kubectl, red); el último intento propaga
            if i == tries - 1:
                raise
            time.sleep(wait)
