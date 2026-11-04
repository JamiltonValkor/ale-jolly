#!/usr/bin/env python3
"""CLI de SaleADS para el agente (ola saleads-api-agencial-v1, AAB-005; alias del agente AAB-023). Solo stdlib.

Habla con la Agent API de SaleADS (`/agent/v1`) con el token del dueño que ya está en la VM. No es una frontera de
seguridad: permisos, propiedad del negocio, scopes y límites viven en el servidor. Aquí solo hay higiene:
- el token nunca se imprime ni va en argumentos; solo en `Authorization: Bearer`;
- el host lo fija el servicio (`skills/saleads-cli/config.json`); no existe `--url`;
- nunca refresca el token (lo renuevan Hermes y SaleADS); un 401 devuelve AUTH-EXPIRED;
- las escrituras llevan `client_request_id` y nunca se reintentan solas;
- `business_id` según el esquema de cada comando: si lo pide y falta, va el último negocio usado con éxito; si no
  lo admite, se quita (en el laboratorio, 3 de cada 4 errores del agente eran ese campo);
- generar con un `quote_token` usa siempre el `client_request_id` con que se cotizó, aunque venga otro `--id`: la
  cotización queda atada a ese id (SaleADS rechaza otro con `QUOTE_CONTENT_MISMATCH`);
- con el esquema del comando: `client_request_id` va cuando el comando lo pide (aunque sea de lectura, como cotizar);
  sin negocio recordado se toma el seleccionado de la cuenta; un valor suelto (`saleads op <id>`) llena el único campo
  obligatorio que falte; campos que no existen, obligatorios que faltan o valores fuera de la lista se avisan antes de
  llamar, con los campos y valores válidos;
- si la salida recortó una lista, la respuesta trae `recortado` con el aviso de no sumar: los totales los da la
  plataforma (`totals`, que nunca se recorta) o se pide la lista entera con `--completo`;
- `saleads web` da las direcciones reales de la web de SaleADS (Límites, aprobaciones), para no inventarlas;
- `piezas preparar` (MCB-007) encadena en el cliente los comandos que ya existen: cotizar → generar si cabe en el tope
  → esperar → subir cada imagen; devuelve `image_hash` y `media_ref` por imagen. No elige nada: el pedido es de Ale;
- `--idioma es|en` (MCB-013): los enlaces de `saleads web` salen en el idioma del dueño; el CLI recuerda el último y lo
  pasa como `locale` solo al pedido de encendido, al espejo y a los comandos que arman el enlace de Límites, cuando su
  esquema lo admite (nunca a `apuestas registrar`, donde `locale` es el idioma de las apuestas);
- 1.5.1 (MCB-011): la primera llamada con la ruta larga deja el atajo `saleads` en `<HERMES_HOME>/.local/bin` (ya en el
  PATH del contenedor), sin cambiar la salida ni fallar nunca; `--help` después de un comando muestra su ayuda;
  `--business_id`/`--business-id` son alias de `--campo business_id`, y `--<campo> <valor>` vale si el campo está
  en el esquema del comando (si no, el mismo CLI-USAGE con los campos válidos).

Uso:
  saleads ayuda [comando]           comandos disponibles (o el detalle de uno); también `saleads <comando> --help`
  saleads esquema <comando>         campos de entrada del comando
  saleads version
  saleads web [--idioma es|en]
  saleads piezas preparar --archivo pieza.json [--max-creditos N] [--esperar S] [--id X]
  saleads <alias|comando> [--archivo args.json] [--campo clave valor ...] [--<campo> valor ...] [--campos a,b]
                          [--completo] [--id <client_request_id>] [--esperar N] [--transporte rest|mcp]

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

VERSION = "1.5.1"
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
    # Canal del agente (AAB-022/023): alias de dos palabras, «sustantivo verbo».
    "apuestas registrar": "saleads_agent_register_bets",
    "apuestas estado": "saleads_agent_bet_state",
    "piezas cotizar": "saleads_agent_quote_pieces",
    "piezas generar": "saleads_agent_generate_pieces",
    "piezas ver": "saleads_agent_pieces",
    "medios subir": "saleads_agent_upload_media",
    "campana publicar": "saleads_agent_publish_campaign",
    "encendido pedir": "saleads_agent_request_activation",
    "espejo": "saleads_agent_mirror",
    "cajas leer": "saleads_agent_read_boxes",
    "leads calidad": "saleads_agent_report_lead_quality",
    "ventas registrar": "saleads_agent_report_box_sales",
    "traza": "saleads_agent_trace",
    # MCB-004: presupuesto del mes y tope de créditos en una lectura (aprobado, gastado, comprometido, lo que queda).
    "limites": "saleads_agent_limits",
}
# Comandos compuestos en el cliente (sin comando nuevo en el servidor).
PREPARE = "piezas preparar"
COMPOSITE = (PREPARE,)
LANGUAGES = ("es", "en")
# MCB-013: comandos cuyo enlace al panel sale en el idioma del dueño (si su esquema admite `locale`).
LOCALE_COMMANDS = ("saleads_agent_request_activation", "saleads_agent_mirror", "saleads_agent_limits", "saleads_agent_quote_pieces")
PREPARE_DEFAULT_WAIT = 150  # la terminal de Hermes corta a los 180 s por defecto (compuerta MCB-000 paso 22)
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
    """{rest, mcp, client_id, web}. Primero el archivo que escribe el servicio; en transición, el config de Hermes."""
    rest = mcp = client_id = web = ""
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
            if isinstance(data.get("web_url"), str) and data["web_url"]:
                web = origin_of(data["web_url"])
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
    return {"rest": rest, "mcp": mcp or rest, "client_id": client_id, "web": web}


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


# --- negocio recordado y esquemas -------------------------------------------------------------------------------

def _cache_file(name: str) -> str:
    return os.path.join(home(), "cache", "saleads-cli", name)


def _read_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_json(path: str, value: Any) -> None:
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        pass


def remembered_business(settings: dict[str, str]) -> str | None:
    data = _read_json(_cache_file("business.json"))
    if isinstance(data, dict) and data.get("base") == settings["rest"] and isinstance(data.get("business_id"), str):
        return data["business_id"]
    return None


def remembered_language() -> str | None:
    data = _read_json(_cache_file("idioma.json"))
    value = data.get("idioma") if isinstance(data, dict) else None
    return value if value in LANGUAGES else None


def remember_language(language: str | None) -> None:
    if language in LANGUAGES and language != remembered_language():
        _write_json(_cache_file("idioma.json"), {"idioma": language})


def remember_business(settings: dict[str, str], business_id: Any) -> None:
    if isinstance(business_id, str) and business_id and business_id != remembered_business(settings):
        _write_json(_cache_file("business.json"), {"base": settings["rest"], "business_id": business_id})


def input_schema(settings: dict[str, str], token: str, name: str) -> dict[str, Any] | None:
    """Campos, obligatorios y valores permitidos del comando (detalle `input_schema`), con caché. None si no se pudo saber."""
    path = _cache_file("schemas-v2.json")
    cached = _read_json(path)
    fresh = isinstance(cached, dict) and cached.get("base") == settings["rest"] and isinstance(cached.get("schemas"), dict)
    try:
        fresh = fresh and time.time() - os.path.getmtime(path) < CACHE_TTL_S
    except OSError:
        fresh = False
    schemas = cached["schemas"] if fresh else {}
    if isinstance(schemas.get(name), dict):
        return schemas[name]
    try:
        status, payload, _ = call("GET", settings["rest"] + "/agent/v1/commands/" + urllib.parse.quote(name, safe=""),
                                  token, read=True)
    except CliError:
        return None
    schema = (payload.get("data") or {}).get("input_schema") if status == 200 and payload.get("ok") else None
    if not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict):
        return None
    properties = schema["properties"]
    info = {
        "props": sorted(properties),
        "required": [k for k in schema.get("required") or [] if isinstance(k, str)],
        "enums": {k: v["enum"] for k, v in properties.items() if isinstance(v, dict) and isinstance(v.get("enum"), list)},
        "closed": schema.get("additionalProperties") is False,
    }
    schemas[name] = info
    _write_json(path, {"base": settings["rest"], "schemas": schemas})
    return info


def selected_business(settings: dict[str, str], token: str) -> str | None:
    """El negocio seleccionado de la cuenta (o el único), para la primera llamada sin negocio recordado."""
    try:
        status, payload, _ = call("POST", settings["rest"] + "/agent/v1/commands/saleads_get_account_overview", token, {}, read=True)
    except CliError:
        return None
    data = (payload.get("data") or {}) if status == 200 and payload.get("ok") else {}
    chosen = data.get("selected_business_id")
    if isinstance(chosen, str) and chosen:
        return chosen
    businesses = [b for b in data.get("businesses") or [] if isinstance(b, dict) and isinstance(b.get("business_id"), str)]
    return businesses[0]["business_id"] if len(businesses) == 1 else None


AUTO_FIELDS = ("business_id", "client_request_id")


def fit_args(settings: dict[str, str], token: str, name: str, args: dict[str, Any], positional: list[str], read: bool,
             loose: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Ajusta los argumentos al esquema del comando antes de llamar. Devuelve (args, avisos) o falla con lo válido.

    `loose` son las opciones `--<campo> <valor>`: entran solo si el campo está en el esquema; si no, se ignoran en una
    lectura y se rechazan en una escritura, igual que un campo de más. Sin esquema, las decide el servidor.
    """
    info = input_schema(settings, token, name)
    loose = {k: v for k, v in (loose or {}).items() if k not in args}
    if info is None:
        return {**args, **loose}, {}
    props, required, enums = set(info["props"]), info["required"], info["enums"]
    notes: dict[str, Any] = {}
    stray = sorted(k for k in loose if k not in props)
    args.update({k: v for k, v in loose.items() if k in props})
    if stray and read:
        notes["ignorados"] = stray
    elif stray:
        raise CliError(EXIT_USAGE, "CLI-USAGE", f"{name} no tiene los campos: {', '.join(stray)}.",
                       f"Quítalos. Campos de {name}: {', '.join(sorted(props))}.")
    if "business_id" in props and not args.get("business_id"):
        business = remembered_business(settings) or selected_business(settings, token)
        if business:
            args["business_id"] = business
    elif "business_id" not in props:
        args.pop("business_id", None)
    missing = [k for k in required if k not in AUTO_FIELDS and args.get(k) in (None, "")]
    if positional:
        if len(positional) != 1 or len(missing) != 1:
            raise CliError(EXIT_USAGE, "CLI-USAGE", f"No sé a qué campo va el valor suelto «{' '.join(positional)[:60]}».",
                           f"Pásalo con --campo <campo> <valor>. Campos de {name}: {', '.join(sorted(props))}.")
        try:
            args[missing[0]] = json.loads(positional[0])
        except ValueError:
            args[missing[0]] = positional[0]
        missing = []
    unknown = sorted(k for k in args if k not in props) if info.get("closed") else []
    if unknown and read:
        for k in unknown:
            args.pop(k)
        notes["ignorados"] = sorted({*notes.get("ignorados", []), *unknown})
    elif unknown:
        raise CliError(EXIT_USAGE, "CLI-USAGE", f"{name} no tiene los campos: {', '.join(unknown)}.",
                       f"Quítalos. Campos de {name}: {', '.join(sorted(props))}.")
    if missing:
        raise CliError(EXIT_USAGE, "CLI-USAGE", f"Falta {', '.join(missing)} para {name}.",
                       f"Agrégalo con --campo <campo> <valor>. Obligatorios: {', '.join(k for k in required if k not in AUTO_FIELDS)}.")
    for field, allowed in enums.items():
        if field in args and args[field] not in allowed:
            raise CliError(EXIT_USAGE, "CLI-USAGE", f"«{args[field]}» no es un valor de {field}.",
                           f"Valores de {field}: {', '.join(str(v) for v in allowed)}.")
    return args, notes


QUOTE_COMMAND, GENERATE_COMMAND = "saleads_agent_quote_pieces", "saleads_agent_generate_pieces"


def quote_request_id(settings: dict[str, str], quote_token: Any) -> str | None:
    data = _read_json(_cache_file("quotes.json"))
    if isinstance(quote_token, str) and isinstance(data, dict) and data.get("base") == settings["rest"]:
        value = (data.get("ids") or {}).get(quote_token)
        return value if isinstance(value, str) else None
    return None


def remember_quote(settings: dict[str, str], quote_token: Any, request_id: str | None) -> None:
    if not isinstance(quote_token, str) or not request_id:
        return
    data = _read_json(_cache_file("quotes.json"))
    ids = data.get("ids") if isinstance(data, dict) and data.get("base") == settings["rest"] and isinstance(data.get("ids"), dict) else {}
    ids[quote_token] = request_id
    _write_json(_cache_file("quotes.json"), {"base": settings["rest"], "ids": dict(list(ids.items())[-50:])})


# --- salida compacta para el modelo -------------------------------------------------------------------------------

# Cifras que calcula la plataforma: nunca se recortan (el modelo no debe sumar filas para obtenerlas).
# MCB-004: credits, limits y budget_check (la plata del mes y el tope) tampoco.
KEEP_WHOLE = {"totals", "total", "summary", "budget", "projection", "credits", "limits", "budget_check", "judge"}


def _shrink(value: Any, depth: int, max_depth: int, max_str: int, max_list: int, cut: list[str] | None = None,
            path: str = "") -> Any:
    if isinstance(value, str):
        return value if len(value) <= max_str else value[: max_str - 1] + "…"
    if isinstance(value, list):
        if depth >= max_depth:
            if cut is not None:
                cut.append(f"{path or '/'}: {len(value)} filas ocultas")
            return {"_lista": len(value)}
        items = [_shrink(v, depth + 1, max_depth, max_str, max_list, cut, f"{path}[{i}]") for i, v in enumerate(value[:max_list])]
        if len(value) > max_list:
            items.append({"_mas": len(value) - max_list})
            if cut is not None:
                cut.append(f"{path or '/'}: {max_list} de {len(value)} filas")
        return items
    if isinstance(value, dict):
        if depth >= max_depth:
            return {"_campos": sorted(value.keys())[:15]}
        return {k: (v if k in KEEP_WHOLE else _shrink(v, depth + 1, max_depth, max_str, max_list, cut, f"{path}/{k}"))
                for k, v in value.items()}
    return value


def compact(value: Any) -> Any:
    """Proyección para el modelo: recorta textos, listas y anidamiento hasta caber en ~6 KB.

    Lo recortado se marca (`_mas`, `_lista`, `_campos`): con `--campos` o `--completo` se pide lo que falte.
    """
    return compact_with_cuts(value)[0]


def compact_with_cuts(value: Any) -> tuple[Any, list[str]]:
    """Como `compact`, y además dice qué listas se recortaron (para avisarle al modelo que no sume)."""
    for max_depth, max_str, max_list in ((6, MAX_STR, MAX_LIST), (4, 200, 10), (3, 120, 5), (2, 80, 3)):
        cut: list[str] = []
        out = _shrink(value, 0, max_depth, max_str, max_list, cut)
        if len(json.dumps(out, ensure_ascii=False)) <= COMPACT_BUDGET:
            return out, cut
    return out, cut


# --- argumentos ---------------------------------------------------------------------------------------------------

def joined(words: list[str]) -> list[str]:
    """`apuestas registrar …` → [`apuestas registrar`, …] cuando las dos primeras palabras son un alias."""
    if len(words) >= 2 and (f"{words[0]} {words[1]}" in ALIASES or f"{words[0]} {words[1]}" in COMPOSITE):
        return [f"{words[0]} {words[1]}", *words[2:]]
    return words


HELP_FLAGS = ("--help", "-h", "--ayuda")
# Opciones propias del CLI: tienen precedencia y nunca se toman como un campo del comando.
OWN_FLAGS = ("--archivo", "--campo", "--campos", "--completo", "--id", "--esperar", "--transporte", "--max-creditos",
             "--idioma")
# Nunca se aceptan, ni como campo: el host y el token los fija SaleADS.
REFUSED_FLAGS = ("--url", "--host", "--token", "--access-token", "--access_token")
BUSINESS_FLAGS = ("--business_id", "--business-id")
# Comandos del propio CLI (no van al catálogo): solo aceptan sus opciones.
LOCAL_COMMANDS = ("ayuda", "esquema", "version", "web")


def _value(raw: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def parse(argv: list[str]) -> tuple[str, list[str], dict[str, Any]]:
    if not argv:
        raise CliError(EXIT_USAGE, "CLI-USAGE", "Falta el comando.", "Usa `saleads ayuda` para ver los comandos.")
    if argv[0] in ("-h", "--help", "help"):
        argv = ["ayuda", *argv[1:]]
    argv = joined(argv)
    if argv[0] in ("ayuda", "esquema"):
        argv = [argv[0], *joined(argv[1:])]
    command, rest = argv[0], argv[1:]
    # `saleads apuestas estado --help` = `saleads ayuda apuestas estado`, en cualquier posición después del comando.
    if command not in ("ayuda", "esquema") and any(flag in HELP_FLAGS for flag in rest):
        return "ayuda", [command], {"args": {}, "loose": {}, "fields": None, "full": False, "id": None, "wait": 0,
                                    "transport": "rest", "max_credits": None, "language": None}
    opts: dict[str, Any] = {"args": {}, "loose": {}, "fields": None, "full": False, "id": None, "wait": 0,
                            "transport": "rest", "max_credits": None, "language": None}
    positional: list[str] = []
    hint = f"Usa `saleads ayuda {command}` para ver sus campos." if command not in LOCAL_COMMANDS else "Usa `saleads ayuda`."
    i = 0
    while i < len(rest):
        flag = rest[i]
        has_value = i + 1 < len(rest) and not rest[i + 1].startswith("--")
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
            opts["args"][rest[i + 1]] = _value(rest[i + 2])
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
        elif flag == "--idioma":
            if i + 1 >= len(rest) or rest[i + 1] not in LANGUAGES:
                raise CliError(EXIT_USAGE, "CLI-USAGE", f"«{rest[i + 1] if i + 1 < len(rest) else ''}» no es un idioma del CLI.",
                               f"Valores de --idioma: {', '.join(LANGUAGES)} (el del dueño en USER.md).")
            opts["language"] = rest[i + 1]
            i += 2
        elif flag == "--max-creditos" and i + 1 < len(rest) and rest[i + 1].isdigit():
            opts["max_credits"] = int(rest[i + 1])
            i += 2
        elif flag in BUSINESS_FLAGS and has_value and command not in LOCAL_COMMANDS:
            opts["args"]["business_id"] = _value(rest[i + 1])
            i += 2
        elif (flag.startswith("--") and len(flag) > 2 and has_value and command not in LOCAL_COMMANDS
              and flag not in OWN_FLAGS and flag not in REFUSED_FLAGS):
            # `--bet_id X` o `--bet-id X`: se usa solo si el campo existe en el esquema del comando (fit_args).
            opts["loose"][flag[2:].replace("-", "_")] = _value(rest[i + 1])
            i += 2
        elif flag.startswith("--") or flag == "-h":
            raise CliError(EXIT_USAGE, "CLI-USAGE", f"Opción no reconocida: {flag}.", hint)
        else:
            positional.append(flag)
            i += 1
    return command, positional, opts


# --- ejecución ----------------------------------------------------------------------------------------------------

def run_mcp(settings: dict[str, str], token: str, name: str, args: dict[str, Any], read: bool) -> dict[str, Any]:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": args, "_meta": {"io.modelcontextprotocol/clientInfo": {"name": "saleads-cli", "version": VERSION}}}}
    headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2026-11-03",
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
                       "Revisa los campos con `saleads esquema <comando>`.")
    result = message.get("result") or {}
    structured = result.get("structuredContent") or {}
    if result.get("isError"):
        raise server_error(200, structured.get("error") or {})
    return structured


def execute(settings: dict[str, str], token: str, name: str, opts: dict[str, Any], entry: dict[str, Any] | None
            ) -> dict[str, Any]:
    read = bool(entry and entry.get("read_only"))
    args = dict(opts["args"])
    notes: dict[str, Any] = {}
    info = None
    if opts["transport"] == "rest":
        args, notes = fit_args(settings, token, name, args, opts.get("positional") or [], read, opts.get("loose"))
        info = input_schema(settings, token, name)
        language = opts.get("language") or remembered_language()
        if name in LOCALE_COMMANDS and language and not args.get("locale") and info is not None and "locale" in info["props"]:
            args["locale"] = language
    else:
        args = {**{k: v for k, v in (opts.get("loose") or {}).items() if k not in args}, **args}
    generated_id = None
    wants_id = (not read) or (info is not None and "client_request_id" in info["props"])
    if wants_id:
        reused = quote_request_id(settings, args.get("quote_token")) if name == GENERATE_COMMAND else None
        if reused and (opts["id"] or args.get("client_request_id")) not in (None, reused):
            notes["client_request_id"] = "se usó el de la cotización: generar va atado a ese id"
        generated_id = reused or opts["id"] or args.get("client_request_id") or str(uuid.uuid4())
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
    remember_business(settings, args.get("business_id"))
    if name == QUOTE_COMMAND and isinstance(data, dict):
        remember_quote(settings, data.get("quote_token"), generated_id)
    out: dict[str, Any] = {"ok": True}
    if opts["fields"]:
        data = {k: data.get(k) for k in opts["fields"]}
    if opts["full"]:
        out["data"] = data
    else:
        out["data"], cut = compact_with_cuts(data)
        if cut:
            out["recortado"] = {"listas": cut[:10], "aviso": ("Faltan filas en esta salida: no sumes ni concluyas totales "
                                "con lo visible. Usa los totales que da SaleADS (`totals`) o pide la lista entera con --completo.")}
    if generated_id:
        out["client_request_id"] = generated_id
    if notes:
        out["avisos"] = notes
    if operation_id:
        out["operation_id"] = operation_id
    nxt = data.get("next_action") if isinstance(data, dict) else None
    if isinstance(nxt, str) and nxt:
        out["next"] = nxt
    return out


UPLOAD_COMMAND, PIECES_COMMAND = "saleads_agent_upload_media", "saleads_agent_pieces"
TERMINAL_JOB = ("completed", "partial", "failed", "cancelled")


def cap_status_of(quote: dict[str, Any]) -> str:
    """`cap_status` del MCP (MCB-005) o, si no viene, la misma regla sobre cap/remaining_cap de la cotización."""
    status = quote.get("cap_status")
    if status in ("ok", "not_set", "short", "unknown"):
        return status
    if "cap" not in quote and "remaining_cap" not in quote:
        return "unknown"
    credits, remaining = quote.get("credits"), quote.get("remaining_cap")
    if quote.get("cap") is None and isinstance(quote.get("used_this_period"), (int, float)):
        return "not_set"
    if isinstance(remaining, (int, float)) and isinstance(credits, (int, float)) and remaining < credits:
        return "short"
    return "ok"


def _step(settings: dict[str, str], token: str, commands: list[dict[str, Any]], name: str, args: dict[str, Any],
          request_id: str | None, transport: str, stage: str) -> dict[str, Any]:
    """Un comando del catálogo con la salida entera (para encadenar). Si falla, el error dice en qué etapa."""
    entry = next((c for c in commands if c.get("name") == name), None)
    if entry is None:
        raise CliError(EXIT_DENIED, "MCP-E-UNKNOWN-COMMAND", f"{name} no está disponible para el agente.",
                       "Usa `saleads ayuda` para ver los comandos.", extra={"etapa": stage})
    step_opts = {"args": dict(args), "loose": {}, "fields": None, "full": True, "id": request_id, "wait": 0,
                 "transport": transport, "positional": [], "language": None}
    try:
        return execute(settings, token, name, step_opts, entry)
    except CliError as error:
        error.extra.setdefault("etapa", stage)
        raise


def prepare(settings: dict[str, str], token: str, opts: dict[str, Any]) -> dict[str, Any]:
    """`piezas preparar`: cotizar → generar si cabe → esperar → subir. Mecánico: el pedido y la elección son de Ale.

    Repetir con el mismo `--id` retoma sin pagar dos veces: cotizar, generar y subir son idempotentes por id.
    """
    if opts.get("positional"):
        raise CliError(EXIT_USAGE, "CLI-USAGE", "piezas preparar no lleva valores sueltos.",
                       "Usa `saleads piezas preparar --archivo pieza.json`.")
    started = time.time()
    wait = opts["wait"] or PREPARE_DEFAULT_WAIT
    request_id = opts["id"] or str(uuid.uuid4())
    transport = opts["transport"]
    commands = catalog(settings, token)
    args = {**{k: v for k, v in (opts.get("loose") or {}).items() if k not in opts["args"]}, **opts["args"]}
    notes: dict[str, Any] = {}
    quote = _step(settings, token, commands, QUOTE_COMMAND, args, request_id, transport, "cotizar")["data"] or {}
    business_id = args.get("business_id") or remembered_business(settings)
    credits, status = quote.get("credits"), cap_status_of(quote)
    out: dict[str, Any] = {"ok": True, "client_request_id": request_id}
    next_action = quote.get("next_action") if isinstance(quote.get("next_action"), str) else None
    stop = {"not_set": "sin_tope", "short": "tope_corto"}.get(status)
    if not stop and opts.get("max_credits") is not None and isinstance(credits, (int, float)) and credits > opts["max_credits"]:
        stop = "supera_maximo"
    if stop:
        out["data"] = {"estado": stop, "cotizacion": compact(quote)}
        if next_action:
            out["next"] = next_action
        return out
    if status == "unknown":
        notes["tope"] = "La cotización no trajo el tope: SaleADS lo revisa al generar. Vuelve a leerlo con `saleads limites`."
    generate_args = {**args, "quote_token": quote.get("quote_token"), "accepted_credits": credits}
    try:
        generated = _step(settings, token, commands, GENERATE_COMMAND, generate_args, request_id, transport, "generar")
    except CliError as error:
        if (error.extra.get("details") or {}).get("downstream_code") != "QUOTE_EXPIRED":
            raise
        # Se cortó antes de generar y la cotización venció (5 min): se vuelve a cotizar con un id nuevo y fijo.
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"saleads-preparar:{request_id}:recotizar"))
        out["client_request_id"] = request_id
        notes["cotizacion"] = "La cotización anterior venció antes de generar: se volvió a cotizar con un id nuevo."
        quote = _step(settings, token, commands, QUOTE_COMMAND, args, request_id, transport, "cotizar")["data"] or {}
        credits = quote.get("credits")
        generate_args = {**args, "quote_token": quote.get("quote_token"), "accepted_credits": credits}
        generated = _step(settings, token, commands, GENERATE_COMMAND, generate_args, request_id, transport, "generar")
    body = generated["data"] or {}
    job_ids = [j for j in [body.get("jobId") or body.get("job_id")] if isinstance(j, str) and j]
    job_ids += [v.get("job_id") for v in body.get("variations") or [] if isinstance(v, dict) and isinstance(v.get("job_id"), str)]
    jobs: dict[str, dict[str, Any]] = {}
    delay = 2.0
    while True:
        for job_id in job_ids:
            if (jobs.get(job_id) or {}).get("status") in TERMINAL_JOB:
                continue
            read = _step(settings, token, commands, PIECES_COMMAND, {"business_id": business_id, "job_id": job_id}, None,
                         transport, "ver")["data"] or {}
            jobs[job_id] = {"status": (read.get("job") or {}).get("status"), "images": read.get("images") or [],
                            "judge": read.get("judge")}
        left = started + wait - time.time()
        if all((jobs.get(j) or {}).get("status") in TERMINAL_JOB for j in job_ids) or left <= 0:
            break
        time.sleep(min(delay, left))
        delay = min(delay * 1.6, 15.0)
    data: dict[str, Any] = {"credits": credits, "job_ids": job_ids,
                            "judge": {j: jobs[j]["judge"] for j in job_ids if jobs.get(j, {}).get("judge") is not None}}
    pending = [j for j in job_ids if (jobs.get(j) or {}).get("status") not in TERMINAL_JOB]
    if pending or not job_ids:
        data["estado"] = "generando"
        out["data"] = data
        out["next"] = (f"Las piezas siguen generándose: repite `saleads piezas preparar` con el mismo archivo y "
                       f"`--id {request_id}` (no cobra dos veces).")
        if notes:
            out["avisos"] = notes
        return out
    images: list[dict[str, Any]] = []
    failed = []
    for job_id in job_ids:
        job = jobs[job_id]
        if job["status"] not in ("completed", "partial"):
            failed.append(job_id)
            continue
        for image in job["images"]:
            image_id = image.get("id") if isinstance(image, dict) else None
            if not isinstance(image_id, str) or not image_id:
                continue
            upload_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"saleads-preparar:{request_id}:{job_id}:{image_id}"))
            uploaded = _step(settings, token, commands, UPLOAD_COMMAND,
                             {"business_id": business_id, "action": "image",
                              "source": {"kind": "gen_image", "jobId": job_id, "variationId": image_id}},
                             upload_id, transport, "subir")["data"] or {}
            images.append({"job_id": job_id, "variation_id": image_id, "image_hash": uploaded.get("image_hash"),
                           "media_ref": uploaded.get("media_ref")})
    if failed:
        notes["fallidas"] = failed
    data["estado"] = "lista" if images else "fallida"
    data["images"] = images
    out["data"] = data if opts["full"] else compact(data)
    if not images:
        out["next"] = "Ninguna pieza salió: lee `judge`, ajusta el pedido y prepara otra con un `--id` nuevo."
    if notes:
        out["avisos"] = notes
    return out


WRAPPER = '#!/bin/sh\nexec python3 {script} "$@"\n'
LOCAL_HELP = {
    "web": {"name": "web", "summary": ("Direcciones reales de la web de SaleADS (Límites, Mi asistente) en el idioma del "
                                       "dueño. El CLI recuerda el último --idioma. No llama a SaleADS."),
            "usage": "saleads web [--idioma es|en]"},
    "version": {"name": "version", "summary": "Versión del CLI.", "usage": "saleads version"},
    "esquema": {"name": "esquema", "summary": "Campos de entrada de un comando.", "usage": "saleads esquema <comando>"},
    PREPARE: {"name": PREPARE, "alias": PREPARE, "read_only": False,
              "summary": ("Cotiza, genera si cabe en el tope de créditos, espera y sube cada imagen a la cuenta del dueño: "
                          "devuelve image_hash y media_ref por imagen. El pedido (maestra o variación) es el de piezas cotizar."),
              "usage": "saleads piezas preparar --archivo pieza.json [--max-creditos N] [--esperar S] [--id X]",
              "estados": ["lista", "generando", "fallida", "sin_tope", "tope_corto", "supera_maximo"]},
}


def ensure_wrapper() -> None:
    """Deja `saleads` en `<HERMES_HOME>/.local/bin` (en el PATH del contenedor) si falta. Nunca falla ni imprime."""
    try:
        script = os.path.join(home(), "skills", "saleads-cli", "scripts", "saleads.py")
        target = os.path.join(home(), ".local", "bin", "saleads")
        if not os.path.isfile(script):
            return
        if not os.path.exists(target):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            tmp = f"{target}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(WRAPPER.format(script=script))
            os.chmod(tmp, 0o755)
            os.replace(tmp, target)
        elif not os.access(target, os.X_OK):
            os.chmod(target, 0o755)
    except Exception:  # noqa: BLE001 — un detalle de la VM nunca bloquea un comando
        pass


def main(argv: list[str]) -> int:
    ensure_wrapper()
    try:
        command, positional, opts = parse(argv)
        remember_language(opts.get("language"))
        if command == "version":
            emit({"ok": True, "data": {"version": VERSION}})
            return EXIT_OK
        if command == "web":
            web = load_settings()["web"]
            if not web:
                raise CliError(EXIT_USAGE, "CLI-CONFIG", "No tengo la dirección de la web de SaleADS en esta máquina.",
                               "No la inventes: dile al dueño que entre a SaleADS desde el enlace que usa siempre.")
            language = opts.get("language") or remembered_language() or "es"
            emit({"ok": True, "data": {"web": web, "idioma": language,
                                       "limites": f"{web}/{language}/dashboard/assistant?tab=limits",
                                       "asistente": f"{web}/{language}/dashboard/assistant"}})
            return EXIT_OK
        if command in ("-h", "--help", "help"):
            command = "ayuda"
        if command == "ayuda" and positional and positional[0] in LOCAL_HELP:
            emit({"ok": True, "data": LOCAL_HELP[positional[0]]})
            return EXIT_OK
        settings = load_settings()
        token = read_token()
        if command == "ayuda":
            commands = catalog(settings, token)
            if positional:
                target = ALIASES.get(positional[0], positional[0])
                entry = next((c for c in commands if c.get("name") == target), None)
                if not entry:
                    raise CliError(EXIT_DENIED, "MCP-E-UNKNOWN-COMMAND", "Ese comando no está disponible.",
                                   "Usa `saleads ayuda` para ver los comandos.")
                info = input_schema(settings, token, target)
                if info is not None:
                    entry = {**entry, "campos": info["props"],
                             "obligatorios": [k for k in info["required"] if k not in AUTO_FIELDS],
                             **({"valores": info["enums"]} if info["enums"] else {})}
                emit({"ok": True, "data": entry})
                return EXIT_OK
            reverse = {v: k for k, v in ALIASES.items()}
            listed = [{"name": c.get("name"), **({"alias": reverse[c["name"]]} if c.get("name") in reverse else {}),
                       "summary": c.get("summary"), "read_only": c.get("read_only")} for c in commands]
            if any(c.get("name") == QUOTE_COMMAND for c in commands):
                listed.append({k: LOCAL_HELP[PREPARE][k] for k in ("name", "alias", "summary", "read_only")})
            emit({"ok": True, "data": {"commands": listed}})
            return EXIT_OK
        if command == "esquema":
            if not positional:
                raise CliError(EXIT_USAGE, "CLI-USAGE", "Falta el comando.", "Usa `saleads esquema <comando>`.")
            if positional[0] == PREPARE:  # compuesto: el pedido es el mismo de piezas cotizar
                positional = ["piezas cotizar"]
            name = ALIASES.get(positional[0], positional[0])
            status, payload, _ = call("GET", settings["rest"] + "/agent/v1/commands/" + urllib.parse.quote(name, safe=""),
                                      token, read=True)
            if status != 200 or not payload.get("ok"):
                raise server_error(status, payload)
            emit({"ok": True, "data": payload.get("data")})
            return EXIT_OK
        if command == PREPARE:
            opts["positional"] = positional
            emit(prepare(settings, token, opts))
            return EXIT_OK
        name = ALIASES.get(command, command)
        commands = catalog(settings, token)
        entry = next((c for c in commands if c.get("name") == name), None)
        if entry is None:
            commands = catalog(settings, token, refresh=True)
            entry = next((c for c in commands if c.get("name") == name), None)
        if entry is None and opts["transport"] == "rest":
            raise CliError(EXIT_DENIED, "MCP-E-UNKNOWN-COMMAND", "Ese comando no está disponible para el agente.",
                           "Usa `saleads ayuda` para ver los comandos.")
        opts["positional"] = positional
        emit(execute(settings, token, name, opts, entry))
        return EXIT_OK
    except CliError as error:
        emit(error.payload())
        return error.exit_code
    except KeyboardInterrupt:
        return EXIT_TRANSIENT


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
