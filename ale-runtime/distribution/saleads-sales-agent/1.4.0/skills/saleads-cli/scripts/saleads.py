#!/usr/bin/env python3
"""CLI de SaleADS para el agente (ola saleads-api-agencial-v1, AAB-005). Solo biblioteca estándar.

Habla con la Agent API de SaleADS (`/agent/v1`) con el token del dueño que ya está en la VM. No es una frontera de
seguridad: permisos, propiedad del negocio, scopes y límites viven en el servidor. Aquí solo hay higiene:
- el token nunca se imprime ni va en argumentos; solo en `Authorization: Bearer`;
- el host lo fija el servicio (`skills/saleads-cli/config.json`); no existe `--url`;
- nunca refresca el token (lo renuevan Hermes y SaleADS); un 401 devuelve AUTH-EXPIRED;
- las escrituras llevan `client_request_id` y nunca se reintentan solas.

Uso:
  saleads.py ayuda [comando]           comandos disponibles (o el detalle de uno)
  saleads.py esquema <comando>         campos de entrada del comando
  saleads.py version
  saleads.py <alias|comando> [--archivo args.json] [--campo clave valor ...] [--campos a,b] [--completo]
                             [--id <client_request_id>] [--esperar N] [--transporte rest|mcp]

Salida: una línea JSON. Códigos: 0 ok, 2 uso, 3 negado, 4 transitorio, 5 sesión vencida.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

VERSION = "1.0.0"
CACHE_TTL_S = 3600
ALIASES = {
    "ctx": "saleads_get_business_bootstrap",
    "cuenta": "saleads_get_account_overview",
    "negocio": "saleads_get_business_profile",
    "ofertas": "saleads_list_offerings",
    "meta": "saleads_get_meta_status",
    "campanas": "saleads_list_campaigns",
    "cajas": "saleads_get_box_metrics",
    "anuncios": "saleads_get_campaign_ads",
    "salud": "saleads_get_campaign_health",
    "resultados": "saleads_get_results",
    "op": "saleads_get_operation",
    "lugares": "saleads_search_locations",
    "guia": "saleads_get_help",
}
EXIT_OK, EXIT_USAGE, EXIT_DENIED, EXIT_TRANSIENT, EXIT_AUTH = 0, 2, 3, 4, 5
DENIED_STATUS = {402, 403, 404, 409, 422, 429}
DENIED_CODES = {"MCP-E-BUSINESS-NOT-FOUND", "MCP-E-ACCESS-NOT-ENABLED", "MCP-E-SUBSCRIPTION-REQUIRED",
                "MCP-E-INSUFFICIENT-SCOPE", "MCP-E-RATE-LIMITED", "MCP-E-UNKNOWN-COMMAND"}
MAX_STR, MAX_LIST = 280, 20
COMPACT_BUDGET = 6000


class CliError(Exception):
    def __init__(self, exit_code: int, code: str, message: str, next_action: str = "", retryable: bool = False,
                 extra: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.exit_code, self.code, self.next_action, self.retryable = exit_code, code, next_action, retryable
        self.extra = extra or {}

    def payload(self) -> dict[str, Any]:
        out = {"ok": False, "code": self.code, "message": str(self), "retryable": self.retryable}
        if self.next_action:
            out["next_action"] = self.next_action
        out.update(self.extra)
        return out


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


# --- configuración (la escribe SaleADS; el agente no elige el host) ---------------------------------------------

def home() -> str:
    return os.environ.get("HERMES_HOME") or "/opt/data"


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.netloc:
        raise CliError(EXIT_USAGE, "CLI-CONFIG", "La URL de SaleADS configurada no es válida.",
                       "Avísale al dueño: la conexión con SaleADS necesita revisión.")
    return f"{parts.scheme}://{parts.netloc}"


def load_settings() -> dict[str, str]:
    """{rest, mcp, client_id}. Primero el archivo que escribe el servicio; en transición, el config de Hermes."""
    rest = mcp = client_id = ""
    own = os.path.join(home(), "skills", "saleads-cli", "config.json")
    if os.path.isfile(own):
        try:
            with open(own, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            raise CliError(EXIT_USAGE, "CLI-CONFIG", "No pude leer la configuración del CLI.",
                           "Avísale al dueño: la conexión con SaleADS necesita revisión.")
        if isinstance(data, dict) and isinstance(data.get("url"), str):
            rest = origin_of(data["url"])
            client_id = str(data.get("client_id") or "")
    cfg_path = os.path.join(home(), "config.yaml")
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as fh:
                cfg = json.load(fh)  # el watcher lo escribe como JSON (subconjunto de YAML)
        except (OSError, ValueError):
            cfg = None
        if isinstance(cfg, dict):
            cli = cfg.get("saleads_cli") if isinstance(cfg.get("saleads_cli"), dict) else {}
            server = (cfg.get("mcp_servers") or {}).get("saleads") if isinstance(cfg.get("mcp_servers"), dict) else None
            if not rest and isinstance(cli.get("url"), str):
                rest = origin_of(cli["url"])
                client_id = client_id or str(cli.get("client_id") or "")
            if isinstance(server, dict) and isinstance(server.get("url"), str):
                mcp = origin_of(server["url"])
                rest = rest or mcp
    if not rest:
        raise CliError(EXIT_USAGE, "CLI-CONFIG", "No encontré la configuración de SaleADS en esta máquina.",
                       "Avísale al dueño: la conexión con SaleADS necesita revisión.")
    return {"rest": rest, "mcp": mcp or rest, "client_id": client_id}


def read_token() -> str:
    path = os.path.join(home(), "mcp-tokens", "saleads.json")
    try:
        with open(path, encoding="utf-8") as fh:  # solo lectura: el CLI nunca escribe este archivo
            token = json.load(fh).get("access_token")
    except (OSError, ValueError, AttributeError):
        token = None
    if not isinstance(token, str) or not token:
        raise auth_expired()
    return token


def auth_expired() -> CliError:
    return CliError(EXIT_AUTH, "AUTH-EXPIRED", "La sesión con SaleADS venció o no está disponible.",
                    "Espera unos minutos y vuelve a intentar; si sigue, pídele al dueño que reconecte SaleADS desde la web.")


# --- HTTP ---------------------------------------------------------------------------------------------------------

def http(method: str, url: str, token: str, body: Any = None, headers: dict[str, str] | None = None,
         timeout: int = 90) -> tuple[int, bytes, dict[str, str]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"Authorization": "Bearer " + token, "Accept": "application/json", "x-saleads-cli-version": VERSION}
    if data is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    request = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        return error.code, error.read(), {k.lower(): v for k, v in (error.headers or {}).items()}
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b"", {}


def call(method: str, url: str, token: str, body: Any = None, *, read: bool, headers: dict[str, str] | None = None
         ) -> tuple[int, Any, dict[str, str]]:
    attempts = 2 if read else 1  # lecturas: un reintento ante 502/503/504; escrituras: nunca
    status, raw, resp_headers = 0, b"", {}
    for attempt in range(attempts):
        status, raw, resp_headers = http(method, url, token, body, headers)
        if status not in (0, 502, 503, 504) or attempt == attempts - 1:
            break
        time.sleep(1.5)
    if status == 401:
        raise auth_expired()
    if status == 0 or status >= 500:
        raise CliError(EXIT_TRANSIENT, "UPSTREAM-UNAVAILABLE", "SaleADS no respondió a tiempo.",
                       "Reintenta en un momento." if read else
                       "No repitas la escritura sin el mismo --id; consulta primero si ya se hizo.", retryable=read)
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError:
        raise CliError(EXIT_TRANSIENT, "UPSTREAM-INVALID", "SaleADS devolvió una respuesta ilegible.", retryable=read)
    return status, payload, resp_headers


def server_error(status: int, payload: dict[str, Any]) -> CliError:
    code = str(payload.get("code") or "UPSTREAM-ERROR")
    extra = {k: payload[k] for k in ("details", "action_url") if k in payload}
    denied = status in DENIED_STATUS or code in DENIED_CODES
    transient = not denied and (bool(payload.get("retryable")) or "UPSTREAM" in code or "TIMEOUT" in code)
    return CliError(EXIT_TRANSIENT if transient else EXIT_DENIED, code,
                    str(payload.get("message") or "SaleADS rechazó la operación."), str(payload.get("next_action") or ""),
                    bool(payload.get("retryable")), extra)


# --- catálogo ---------------------------------------------------------------------------------------------------

def cache_path() -> str:
    return os.path.join(home(), "cache", "saleads-cli", "commands.json")


def catalog(settings: dict[str, str], token: str, refresh: bool = False) -> list[dict[str, Any]]:
    path = cache_path()
    if not refresh:
        try:
            if time.time() - os.path.getmtime(path) < CACHE_TTL_S:
                with open(path, encoding="utf-8") as fh:
                    cached = json.load(fh)
                if cached.get("base") == settings["rest"] and isinstance(cached.get("commands"), list):
                    return cached["commands"]
        except (OSError, ValueError, AttributeError):
            pass
    status, payload, _ = call("GET", settings["rest"] + "/agent/v1/commands", token, read=True)
    if status != 200 or not payload.get("ok"):
        raise server_error(status, payload)
    commands = payload.get("data", {}).get("commands", [])
    try:  # sin token ni datos del negocio: solo nombres y resúmenes
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"base": settings["rest"], "commands": commands}, fh, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        pass
    return commands


# --- salida compacta para el modelo -------------------------------------------------------------------------------

def _shrink(value: Any, depth: int, max_depth: int, max_str: int, max_list: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= max_str else value[: max_str - 1] + "…"
    if isinstance(value, list):
        if depth >= max_depth:
            return {"_lista": len(value)}
        items = [_shrink(v, depth + 1, max_depth, max_str, max_list) for v in value[:max_list]]
        if len(value) > max_list:
            items.append({"_mas": len(value) - max_list})
        return items
    if isinstance(value, dict):
        if depth >= max_depth:
            return {"_campos": sorted(value.keys())[:15]}
        return {k: _shrink(v, depth + 1, max_depth, max_str, max_list) for k, v in value.items()}
    return value


def compact(value: Any) -> Any:
    """Proyección para el modelo: recorta textos, listas y anidamiento hasta caber en ~6 KB.

    Lo recortado se marca (`_mas`, `_lista`, `_campos`): con `--campos` o `--completo` se pide lo que falte.
    """
    for max_depth, max_str, max_list in ((6, MAX_STR, MAX_LIST), (4, 200, 10), (3, 120, 5), (2, 80, 3)):
        out = _shrink(value, 0, max_depth, max_str, max_list)
        if len(json.dumps(out, ensure_ascii=False)) <= COMPACT_BUDGET:
            return out
    return out


# --- argumentos ---------------------------------------------------------------------------------------------------

def parse(argv: list[str]) -> tuple[str, list[str], dict[str, Any]]:
    if not argv:
        raise CliError(EXIT_USAGE, "CLI-USAGE", "Falta el comando.", "Usa `saleads.py ayuda` para ver los comandos.")
    command, rest = argv[0], argv[1:]
    opts: dict[str, Any] = {"args": {}, "fields": None, "full": False, "id": None, "wait": 0, "transport": "rest"}
    positional: list[str] = []
    i = 0
    while i < len(rest):
        flag = rest[i]
        if flag == "--archivo" and i + 1 < len(rest):
            try:
                with open(rest[i + 1], encoding="utf-8") as fh:
                    loaded = json.load(fh)
            except (OSError, ValueError):
                raise CliError(EXIT_USAGE, "CLI-USAGE", "No pude leer el archivo de argumentos como JSON.",
                               "Escribe un objeto JSON válido en el archivo y vuelve a llamar.")
            if not isinstance(loaded, dict):
                raise CliError(EXIT_USAGE, "CLI-USAGE", "El archivo de argumentos debe ser un objeto JSON.")
            opts["args"].update(loaded)
            i += 2
        elif flag == "--campo" and i + 2 < len(rest):
            raw = rest[i + 2]
            try:
                opts["args"][rest[i + 1]] = json.loads(raw)
            except ValueError:
                opts["args"][rest[i + 1]] = raw
            i += 3
        elif flag == "--campos" and i + 1 < len(rest):
            opts["fields"] = [f for f in rest[i + 1].split(",") if f]
            i += 2
        elif flag == "--completo":
            opts["full"] = True
            i += 1
        elif flag == "--id" and i + 1 < len(rest):
            opts["id"] = rest[i + 1]
            i += 2
        elif flag == "--esperar" and i + 1 < len(rest) and rest[i + 1].isdigit():
            opts["wait"] = min(int(rest[i + 1]), 600)
            i += 2
        elif flag == "--transporte" and i + 1 < len(rest) and rest[i + 1] in ("rest", "mcp"):
            opts["transport"] = rest[i + 1]
            i += 2
        elif flag.startswith("--"):
            raise CliError(EXIT_USAGE, "CLI-USAGE", f"Opción no reconocida: {flag}.", "Usa `saleads.py ayuda`.")
        else:
            positional.append(flag)
            i += 1
    return command, positional, opts


# --- ejecución ----------------------------------------------------------------------------------------------------

def run_mcp(settings: dict[str, str], token: str, name: str, args: dict[str, Any], read: bool) -> dict[str, Any]:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": args, "_meta": {"io.modelcontextprotocol/clientInfo": {"name": "saleads-cli", "version": VERSION}}}}
    headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28",
               "Mcp-Method": "tools/call", "Mcp-Name": name}
    attempts = 2 if read else 1
    status, raw = 0, b""
    for attempt in range(attempts):
        status, raw, _ = http("POST", settings["mcp"] + "/mcp", token, body, headers)
        if status not in (0, 502, 503, 504) or attempt == attempts - 1:
            break
        time.sleep(1.5)
    if status == 401:
        raise auth_expired()
    if status != 200:
        raise CliError(EXIT_TRANSIENT if status in (0, 502, 503, 504) else EXIT_DENIED, "MCP-HTTP-" + str(status),
                       "El MCP de SaleADS rechazó la llamada.", retryable=read and status in (0, 502, 503, 504))
    text = raw.decode("utf-8", "replace")
    message = None
    if text.lstrip().startswith("{"):
        message = json.loads(text)
    else:
        for line in text.splitlines():
            if line.startswith("data:"):
                candidate = json.loads(line[5:].strip())
                if "result" in candidate or "error" in candidate:
                    message = candidate
    if not isinstance(message, dict) or "error" in message:
        raise CliError(EXIT_DENIED, "MCP-E-INVALID-INPUT", "El MCP rechazó los argumentos.",
                       "Revisa los campos con `saleads.py esquema <comando>`.")
    result = message.get("result") or {}
    structured = result.get("structuredContent") or {}
    if result.get("isError"):
        raise server_error(200, structured.get("error") or {})
    return structured


def execute(settings: dict[str, str], token: str, name: str, opts: dict[str, Any], entry: dict[str, Any] | None
            ) -> dict[str, Any]:
    read = bool(entry and entry.get("read_only"))
    args = dict(opts["args"])
    generated_id = None
    if not read:
        generated_id = opts["id"] or args.get("client_request_id") or str(uuid.uuid4())
        args["client_request_id"] = generated_id
    if opts["transport"] == "mcp":
        data = run_mcp(settings, token, name, args, read)
        operation_id = data.get("operation_id")
    else:
        status, payload, _ = call("POST", settings["rest"] + "/agent/v1/commands/" + urllib.parse.quote(name, safe=""),
                                  token, args, read=read)
        if status != 200 or not payload.get("ok"):
            error = server_error(status, payload)
            if generated_id:
                error.extra["client_request_id"] = generated_id
            raise error
        data = payload.get("data") or {}
        operation_id = payload.get("operation_id") or data.get("operation_id")
    if operation_id and opts["wait"] > 0:
        deadline, delay = time.time() + opts["wait"], 2.0
        while time.time() < deadline:
            time.sleep(min(delay, max(0.0, deadline - time.time())))
            status, payload, _ = call("POST", settings["rest"] + "/agent/v1/commands/saleads_get_operation", token,
                                      {"operation_id": operation_id}, read=True)
            if status == 200 and payload.get("ok"):
                op = payload.get("data") or {}
                if op.get("status") not in ("queued", "running"):
                    data = op
                    break
            delay = min(delay * 1.6, 15.0)
    out: dict[str, Any] = {"ok": True}
    if opts["fields"]:
        data = {k: data.get(k) for k in opts["fields"]}
    out["data"] = data if opts["full"] else compact(data)
    if generated_id:
        out["client_request_id"] = generated_id
    if operation_id:
        out["operation_id"] = operation_id
    nxt = data.get("next_action") if isinstance(data, dict) else None
    if isinstance(nxt, str) and nxt:
        out["next"] = nxt
    return out


def main(argv: list[str]) -> int:
    try:
        command, positional, opts = parse(argv)
        if command == "version":
            emit({"ok": True, "data": {"version": VERSION}})
            return EXIT_OK
        if command in ("-h", "--help", "help"):
            command = "ayuda"
        settings = load_settings()
        token = read_token()
        if command == "ayuda":
            commands = catalog(settings, token)
            if positional:
                target = ALIASES.get(positional[0], positional[0])
                entry = next((c for c in commands if c.get("name") == target), None)
                if not entry:
                    raise CliError(EXIT_DENIED, "MCP-E-UNKNOWN-COMMAND", "Ese comando no está disponible.",
                                   "Usa `saleads.py ayuda` para ver los comandos.")
                emit({"ok": True, "data": entry})
                return EXIT_OK
            reverse = {v: k for k, v in ALIASES.items()}
            emit({"ok": True, "data": {"commands": [
                {"name": c.get("name"), **({"alias": reverse[c["name"]]} if c.get("name") in reverse else {}),
                 "summary": c.get("summary"), "read_only": c.get("read_only")} for c in commands]}})
            return EXIT_OK
        if command == "esquema":
            if not positional:
                raise CliError(EXIT_USAGE, "CLI-USAGE", "Falta el comando.", "Usa `saleads.py esquema <comando>`.")
            name = ALIASES.get(positional[0], positional[0])
            status, payload, _ = call("GET", settings["rest"] + "/agent/v1/commands/" + urllib.parse.quote(name, safe=""),
                                      token, read=True)
            if status != 200 or not payload.get("ok"):
                raise server_error(status, payload)
            emit({"ok": True, "data": payload.get("data")})
            return EXIT_OK
        name = ALIASES.get(command, command)
        commands = catalog(settings, token)
        entry = next((c for c in commands if c.get("name") == name), None)
        if entry is None:
            commands = catalog(settings, token, refresh=True)
            entry = next((c for c in commands if c.get("name") == name), None)
        if entry is None and opts["transport"] == "rest":
            raise CliError(EXIT_DENIED, "MCP-E-UNKNOWN-COMMAND", "Ese comando no está disponible para el agente.",
                           "Usa `saleads.py ayuda` para ver los comandos.")
        emit(execute(settings, token, name, opts, entry))
        return EXIT_OK
    except CliError as error:
        emit(error.payload())
        return error.exit_code
    except KeyboardInterrupt:
        return EXIT_TRANSIENT


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
