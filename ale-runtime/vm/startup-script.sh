#!/bin/bash
# SaleADS one-click assistant VM (COS): startup-script + metadata watcher.
#
# One self-contained file. GCE runs it on every boot as `startup-script`
# (no arguments). It installs itself to /var/lib/hermes/bin, recreates the
# watcher unit in /etc/systemd/system (tmpfs on COS) and starts it. The
# watcher (`watch`) long-polls the instance metadata, writes the Hermes files
# into /var/lib/hermes/data (mounted as /opt/data), runs the pinned Hermes
# container and publishes the ack in guest attribute hermes/applied-version.
#
# Closed list of metadata keys (anything else is ignored):
#   hermes-api-key hermes-archive-url hermes-bundle-version hermes-config
#   hermes-env hermes-mcp-tokens hermes-skills hermes-soul
#   hermes-brain-image hermes-seed-url hermes-snapshot-url   (ORQA cliente, OSB-005)
#   hermes-restore-url                                       (memory restore, D50)
#   hermes-profiles                                          (specialist team, MLB-005a)
#
# ORQA cliente: with hermes-brain-image the VM also runs `falkordb` and
# `saleads-brain` (private Artifact Registry image) on the docker network
# hermes-net; Hermes joins it with `docker network connect`. The watcher
# downloads the seed, creates the brain's no-agent cron jobs, uploads the graph
# snapshot when it changes and deletes only the skills SaleADS manages.
#
# Never logs metadata values: only key names and short hashes.
# Compatible with bash 3.2 so the tests run on macOS.

set -euo pipefail
umask 077

HERMES_IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent@sha256:55e192fba0cd4fde61142abbff5adeacff40efdb482ccd0ff877924bd274f909}"
MD_URL="${HERMES_MD_URL:-http://metadata.google.internal/computeMetadata/v1}"
HERMES_ROOT="${HERMES_ROOT:-/var/lib/hermes}"
DATA_DIR="${HERMES_DATA_DIR:-$HERMES_ROOT/data}"
STATE_DIR="${HERMES_STATE_DIR:-$HERMES_ROOT/state}"
BIN_PATH="$HERMES_ROOT/bin/hermes-vm.sh"
UNIT_DIR="${HERMES_UNIT_DIR:-/etc/systemd/system}"
UNIT_NAME="hermes-watcher.service"
OWNER="${HERMES_OWNER:-10000:10000}"
DOCKER="${HERMES_DOCKER:-docker}"
CONTAINER="${HERMES_CONTAINER:-hermes}"
API_PORT=8642
NETWORK="${HERMES_NETWORK:-hermes-net}"
FALKOR_CONTAINER=falkordb
BRAIN_CONTAINER=saleads-brain
BRAIN_PORT=8765
FALKOR_IMAGE="${HERMES_FALKOR_IMAGE:-falkordb/falkordb:v4.22.1@sha256:b0bdcac2cbaff989e77cb0610439b7a9289e86de033ccbbd4368b66fb680ae7a}"
BRAIN_DIR="${HERMES_BRAIN_DIR:-$HERMES_ROOT/brain}"
AR_REGISTRY=us-central1-docker.pkg.dev
DOCKER_CRED="${HERMES_DOCKER_CRED:-docker-credential-gcr}"
WAIT_TIMEOUT_SEC="${HERMES_WAIT_TIMEOUT_SEC:-60}"
WATCH_MAX_ITER="${HERMES_WATCH_MAX_ITER:-0}"   # 0 = forever (tests set a bound)

# Fixed order: it is part of the applied-version contract.
KEYS="hermes-api-key hermes-archive-url hermes-bundle-version hermes-config hermes-env hermes-mcp-tokens hermes-skills hermes-soul hermes-brain-image hermes-seed-url hermes-snapshot-url hermes-restore-url hermes-profiles hermes-extensions hermes-first-loop-url hermes-continuous-contexts hermes-continuous-url"
# Published as guest attribute hermes/watcher-version: the service sends
# hermes-profiles only to a watcher that supports it (MLB-005b).
# Version 6 adds conditional managed-Meta inference pins and upgrades the cached merge.
# Version 10 adds private API-run receipts and a read-only copy before gateway startup.
# Version 11 adds the managed landing role, scoped experience and fixed CLI adapter assets.
WATCHER_VERSION=11
# Specialist profiles: never copied into their .env (duplicate channel
# credentials or the root API server).
PROFILE_ENV_DROP="TELEGRAM_|API_SERVER_|WHATSAPP_"
# Filled from the generated contract installed with the managed extensions.
MANAGED_ROLE_LIST=""

# Files kept in the memories archive (relative to DATA_DIR), for the root and
# for every profile (archive_list), plus the shared Kanban board. Secrets
# (.env, mcp-tokens/, auth.json) are never archived, except the channel lines
# of .env copied to saleads/channels.env (CHANNEL_ENV_RE).
ARCHIVE_PATHS="memories sessions state.db state.db-wal state.db-shm"
# Messaging channels the assistant connected by chat (Hermes writes the token in
# .env and the home channel under `platforms` in config.yaml). Only these lines of .env, never the AI key, plus
# the WhatsApp session linked by QR (platforms/whatsapp/session).
CHANNEL_ENV_RE='^[[:space:]]*(export[[:space:]]+)?(TELEGRAM|WHATSAPP|DISCORD|SLACK)_'
CHANNEL_FILES="saleads/channels.env saleads/platforms.json platforms/whatsapp/session"
ARCHIVE_SHARED="kanban.db kanban.db-wal kanban.db-shm kanban"
# Restore of that archive on a new VM (D50): download budget, extracted-bytes
# cap and attempts for transient download errors before Hermes starts anyway.
RESTORE_MAX_BYTES="${HERMES_RESTORE_MAX_BYTES:-4294967296}"
RESTORE_TRIES="${HERMES_RESTORE_TRIES:-3}"

log() { printf '%s hermes-vm: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1; fi
}
sha256_file() { sha256_stdin <"$1"; }
short() { printf '%s' "$1" | cut -c1-12; }

# ---------------------------------------------------------------- metadata

# md_get KEY OUT -> 0 present (value in OUT), 1 absent (404), 2 error.
md_get() {
  local key=$1 out=$2 code
  code=$(curl -sS --max-time 10 -H 'Metadata-Flavor: Google' -o "$out" -w '%{http_code}' \
    "$MD_URL/instance/attributes/$key") || { rm -f "$out"; return 2; }
  case "$code" in
    200) return 0 ;;
    404) rm -f "$out"; return 1 ;;
    *) rm -f "$out"; return 2 ;;
  esac
}

guest_put() {
  curl -sS -f --max-time 10 -X PUT -H 'Metadata-Flavor: Google' --data-binary "$2" \
    "$MD_URL/instance/guest-attributes/hermes/$1" >/dev/null
}

# fetch_all STAGE: copies every present key of the closed list into STAGE/<key>.
fetch_all() {
  local stage=$1 k rc
  for k in $KEYS; do
    rc=0
    md_get "$k" "$stage/$k" || rc=$?
    if [ "$rc" -eq 2 ]; then log "metadata read failed for $k"; return 1; fi
  done
}

# applied-version = sha256 of "<key> <sha256(value)>\n" for each present key,
# in the fixed KEYS order. The service computes the same value from the
# metadata items it sent (see vm/README.md).
compute_version() {
  local stage=$1 k
  for k in $KEYS; do
    if [ -f "$stage/$k" ]; then printf '%s %s\n' "$k" "$(sha256_file "$stage/$k")"; fi
  done | sha256_stdin
}

# ------------------------------------------------------------------- files

ensure_dir() { mkdir -p "$1"; chown "$OWNER" "$1"; chmod 0700 "$1"; }

# install_file SRC DEST: atomic replace, owner 10000:10000, mode 0600.
install_file() {
  local src=$1 dest=$2 tmp
  tmp="$dest.tmp.$$"
  cp "$src" "$tmp"
  chown "$OWNER" "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$dest"
}

state_get() { cat "$STATE_DIR/$1.sha" 2>/dev/null || true; }
state_set() { printf '%s' "$2" >"$STATE_DIR/$1.sha"; }

# Hash of the metadata value for KEY (empty when absent).
value_hash() { if [ -f "$1/$2" ]; then sha256_file "$1/$2"; fi; }

# Python helper. Reads stdin and writes a sanitized tar on stdout. Modes:
#   tokens  metadata value: JSON {"tokens.json":.., "client.json":..}
#   skills  metadata value: JSON {path: content} or base64 tar.gz
#   config  tar {meta, current?, managed?} -> tar {config.yaml, managed, status, changed}
#   profiles  metadata value: base64 tar.gz of profiles/<n>/{SOUL.md,
#           profile-config.yaml, skills/...}; anything else is refused
#   profile-config  tar {meta, layer} -> config.yaml (meta + layer, layer wins)
# Runs with the python3 of the pinned Hermes image (COS has no python), with
# --network none. tokens/skills use only the stdlib. config needs a YAML
# loader: Hermes v0.21.6 ships ruamel.yaml behind its own hermes_yaml module
# (WORKDIR /opt/hermes); PyYAML is the last fallback (tests).
PY_HELPER='
import base64, copy, io, json, posixpath, re, sys, tarfile
mode = sys.argv[1]
def bad(msg):
    sys.stderr.write("hermes-vm helper: " + msg + "\n"); sys.exit(3)
# restore: memories archive (tar.gz, streamed) -> plain tar with only the
# regular files of the allowlist (Hermes memories, sessions, state.db*, kanban
# and the same per profile). Secrets (.env, auth.json, mcp-tokens/) and
# anything else (config, skills, SOUL.md, links, devices) are dropped.
PROFILE_ID = r"[a-z0-9][a-z0-9_-]{0,63}"
RESTORE_RE = re.compile(r"saleads/channels\.env|saleads/platforms\.json|platforms/whatsapp/session/[A-Za-z0-9._-]+|(?:profiles/" + PROFILE_ID + r"/)?(?:memories/.+|sessions/.+|state\.db(?:-wal|-shm)?)"
                        r"|kanban\.db(?:-wal|-shm)?|kanban/.+")
NEVER = (".env", "auth.json", "mcp-tokens")
def restore(limit):
    total = 0
    try:
        src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz")
        with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as out:
            for m in src:
                if not m.isfile(): continue
                n = posixpath.normpath(m.name)
                if n.startswith("/") or n == ".." or n.startswith("../") or re.search(r"[\x00-\x1f\\]", n): continue
                if any(part in NEVER for part in n.split("/")) or not RESTORE_RE.fullmatch(n): continue
                total += m.size
                if total > limit: bad("archive larger than the restore cap")
                info = tarfile.TarInfo(n)
                info.size = m.size; info.mode = 0o600; info.mtime = m.mtime
                out.addfile(info, src.extractfile(m))
    except (tarfile.TarError, EOFError, OSError): bad("invalid archive")
    sys.exit(0)
if mode == "restore": restore(int(sys.argv[2]))
raw = sys.stdin.buffer.read()
# config.yaml merge. SaleADS owns only the top-level keys model, approvals and
# timezone plus the nested keys in MANAGED_NESTED (mcp_servers.saleads, the
# brain MCP and skills.write_approval): they take the metadata value, and one it
# managed before that the metadata no longer carries is removed. Everything
# else in the existing file (platforms, other MCP servers, other skills keys,
# _config_version...) is kept. Output is JSON (a YAML subset: strings stay
# quoted, so "off" never turns into a boolean).
MANAGED_TOP = ("model", "approvals", "timezone")
MANAGED_NESTED = ("mcp_servers.saleads", "mcp_servers.saleads-brain", "skills.write_approval", "tools.tool_search",
                  "cron.wrap_response", "display.file_mutation_verifier",
                  "kanban.max_in_progress", "kanban.auto_decompose", "kanban.review_dispatch", "kanban.auto_subscribe_on_create")
META_AUXILIARY_FIELDS = ("provider", "model", "base_url", "api_key", "fallback_chain")
META_DELEGATION_FIELDS = ("provider", "model", "base_url", "fallback_providers")
META_AUXILIARY_SELECTORS = ("key_env", "api_key_env", "api_mode")
META_DELEGATION_SELECTORS = ("api_key", "key_env", "api_key_env", "api_mode")
def meta_auxiliary_sections(cfg):
    auxiliary = cfg.get("auxiliary")
    if not isinstance(auxiliary, dict): return []
    return [(task, section) for task, section in auxiliary.items()
            if isinstance(task, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", task) and isinstance(section, dict)]
def meta_inference_paths(cfg):
    model = cfg.get("model")
    if not isinstance(model, dict) or model.get("provider") != "meta-ai": return []
    paths = [key for key in ("fallback_providers", "fallback_model") if key in cfg]
    for task, section in meta_auxiliary_sections(cfg):
        paths.extend("auxiliary." + task + "." + field
                     for field in META_AUXILIARY_FIELDS + META_AUXILIARY_SELECTORS if field in section)
    delegation = cfg.get("delegation")
    if isinstance(delegation, dict):
        paths.extend("delegation." + field
                     for field in META_DELEGATION_FIELDS + META_DELEGATION_SELECTORS if field in delegation)
    return paths
def meta_inference_cleanup_paths(cfg):
    model = cfg.get("model")
    if not isinstance(model, dict) or model.get("provider") != "meta-ai": return []
    paths = []
    for task, section in meta_auxiliary_sections(cfg):
        paths.extend("auxiliary." + task + "." + field for field in META_AUXILIARY_SELECTORS if field not in section)
    delegation = cfg.get("delegation")
    if isinstance(delegation, dict):
        paths.extend("delegation." + field for field in META_DELEGATION_SELECTORS if field not in delegation)
    return paths
def yaml_loader():
    try:
        import hermes_yaml
        return hermes_yaml.safe_load
    except Exception:
        pass
    try:
        from ruamel.yaml import YAML
        return YAML(typ="safe", pure=True).load
    except Exception:
        pass
    try:
        import yaml
        return yaml.safe_load
    except Exception:
        bad("no yaml library in the image")
def managed_paths(cfg):
    paths = [k for k in MANAGED_TOP if k in cfg]
    for path in MANAGED_NESTED:
        top, leaf = path.split(".", 1)
        section = cfg.get(top)
        if isinstance(section, dict) and leaf in section: paths.append(path)
    return paths + meta_inference_paths(cfg)
def merge_config(blob):
    parts = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as t:
            for m in t.getmembers():
                if m.isfile() and m.name in ("meta", "current", "managed", "brain_token"):
                    parts[m.name] = t.extractfile(m).read()
    except tarfile.TarError: bad("invalid config input")
    if "meta" not in parts: bad("missing hermes-config")
    load = yaml_loader()
    try: meta = load(parts["meta"].decode("utf-8"))
    except Exception: bad("hermes-config is not valid yaml")
    if not isinstance(meta, dict): bad("hermes-config must be a mapping")
    prev = set(l.strip() for l in parts.get("managed", b"").decode("utf-8", "replace").splitlines() if l.strip())
    current = None
    status = "new"
    if "current" in parts:
        try:
            current = load(parts["current"].decode("utf-8"))
            if current is None: current = {}
            if not isinstance(current, dict): raise ValueError("not a mapping")
            status = "merged"
        except Exception:
            current = None
            status = "replaced_invalid"
    token = parts.get("brain_token", b"").decode("utf-8", "replace").strip()
    brain_mcp = meta.get("mcp_servers", {}).get("saleads-brain") if isinstance(meta.get("mcp_servers"), dict) else None
    if token and isinstance(brain_mcp, dict):
        # Solo Ale manda el token del cerebro (MLB-009): sin él, el cerebro no acepta aprendizajes.
        brain_mcp["headers"] = {"x-saleads-brain-token": token}
    before = copy.deepcopy(current)
    if current is None and not (token and isinstance(brain_mcp, dict)):
        body = parts["meta"]
    elif current is None:
        body = (json.dumps(meta, indent=2, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    else:
        out = current
        for k in MANAGED_TOP:
            if k in meta: out[k] = meta[k]
            elif k in prev: out.pop(k, None)
        for path in MANAGED_NESTED:
            top, leaf = path.split(".", 1)
            mine = meta.get(top)
            section = out.get(top)
            if isinstance(mine, dict) and leaf in mine:
                if not isinstance(section, dict): section = {}
                section[leaf] = mine[leaf]
                out[top] = section
            elif path in prev and isinstance(section, dict):
                section.pop(leaf, None)
                if not section: out.pop(top, None)
        # Only managed Meta claims these inference leaves. Keep personal task
        # settings (enabled, concurrency, etc.), other tasks and legacy providers.
        for path in meta_inference_paths(meta):
            keys = path.split(".")
            target, source = out, meta
            for key in keys[:-1]:
                source = source[key]
                if not isinstance(target.get(key), dict): target[key] = {}
                target = target[key]
            target[keys[-1]] = source[keys[-1]]
        # Stale provider credential/transport selectors override empty default
        # fields in Hermes. Remove them only in explicitly managed Meta sections.
        for path in meta_inference_cleanup_paths(meta):
            keys = path.split(".")
            target = out
            for key in keys[:-1]:
                target = target.get(key) if isinstance(target, dict) else None
            if isinstance(target, dict): target.pop(keys[-1], None)
        body = (json.dumps(out, indent=2, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    changed = current is None or before != current
    files = {"config.yaml": body, "managed": "".join(p + "\n" for p in managed_paths(meta)).encode(),
             "status": status.encode(), "changed": b"1" if changed else b"0"}
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as t:
        for name in sorted(files):
            info = tarfile.TarInfo(name)
            info.size = len(files[name]); info.mode = 0o600; info.mtime = 0
            t.addfile(info, io.BytesIO(files[name]))
    sys.exit(0)
if mode == "config": merge_config(raw)
def deep_merge(base, layer):
    for k, v in layer.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict): deep_merge(base[k], v)
        else: base[k] = v
    return base
def profile_config(blob):
    parts = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as t:
            for m in t.getmembers():
                if m.isfile() and m.name in ("meta", "layer", "current"): parts[m.name] = t.extractfile(m).read()
    except tarfile.TarError: bad("invalid profile-config input")
    if "meta" not in parts or "layer" not in parts: bad("missing hermes-config or profile layer")
    load = yaml_loader()
    try:
        meta = load(parts["meta"].decode("utf-8")) or {}
        layer = load(parts["layer"].decode("utf-8")) or {}
    except Exception: bad("profile config is not valid yaml")
    if not isinstance(meta, dict) or not isinstance(layer, dict): bad("profile config must be a mapping")
    meta.pop("kanban", None)  # the board and its dispatcher belong to the root profile
    for server in (meta.get("mcp_servers") or {}).values():
        if isinstance(server, dict): server.pop("headers", None)  # the brain token is only for Ale
    merged = deep_merge(meta, layer)
    if "current" in parts:
        try: current = load(parts["current"].decode("utf-8")) or {}
        except Exception: current = {}
        previous = current.get("plugins") if isinstance(current, dict) else None
        if isinstance(previous, dict):
            target = merged.get("plugins") if isinstance(merged.get("plugins"), dict) else {}
            keep = list(previous.get("enabled", [])) if isinstance(previous.get("enabled"), list) else []
            add = list(target.get("enabled", [])) if isinstance(target.get("enabled"), list) else []
            merged["plugins"] = deep_merge(previous, target)
            merged["plugins"]["enabled"] = list(dict.fromkeys(keep + add))
    sys.stdout.write(json.dumps(merged, indent=2, ensure_ascii=False, default=str) + "\n")
    sys.exit(0)
if mode == "profile-config": profile_config(raw)
# platforms-get: the `platforms` section of config.yaml as JSON (empty if none).
# platforms-merge: tar {current, platforms} -> config.yaml with that section
# added only when the current file has none (existing configuration wins).
def platforms_get(blob):
    try: cfg = yaml_loader()(blob.decode("utf-8")) or {}
    except Exception: cfg = {}
    section = cfg.get("platforms") if isinstance(cfg, dict) else None
    sys.stdout.write(json.dumps(section, ensure_ascii=False, default=str) if isinstance(section, dict) and section else "")
    sys.exit(0)
if mode == "platforms-get": platforms_get(raw)
def platforms_merge(blob):
    parts = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as t:
            for m in t.getmembers():
                if m.isfile() and m.name in ("current", "platforms"): parts[m.name] = t.extractfile(m).read()
    except tarfile.TarError: bad("invalid platforms input")
    try: section = json.loads(parts.get("platforms", b"{}").decode("utf-8"))
    except ValueError: bad("invalid platforms json")
    try: cfg = yaml_loader()(parts.get("current", b"").decode("utf-8")) or {}
    except Exception: cfg = {}
    if not isinstance(cfg, dict): cfg = {}
    if isinstance(section, dict) and section and not cfg.get("platforms"): cfg["platforms"] = section
    sys.stdout.write(json.dumps(cfg, indent=2, ensure_ascii=False, default=str) + "\n")
    sys.exit(0)
if mode == "platforms-merge": platforms_merge(raw)
# Fixed managed extension files only: no arbitrary executable paths from metadata.
if mode == "extensions":
    legacy = {"plugins/saleads-meta-search/plugin.yaml", "plugins/saleads-meta-search/__init__.py", "plugins/saleads-meta-search/search.py", "runtime/first-loop-exporter.py"}
    continuity = legacy | {"plugins/saleads-continuity/plugin.yaml", "plugins/saleads-continuity/__init__.py", "plugins/saleads-continuity/context.py", "plugins/saleads-continuity/notifications.py", "runtime/continuous-exporter.py"}
    managed_v9 = continuity | {"plugins/saleads-continuity/delivery.py", "plugins/saleads-continuity/turn_frames.py", "plugins/saleads-continuity/goal_delivery.py", "plugins/saleads-memory/plugin.yaml", "plugins/saleads-memory/__init__.py", "plugins/saleads-memory/client.py", "plugins/saleads-memory/context.py", "plugins/saleads-memory/memory.py", "plugins/saleads-memory/schemas.py", "plugins/saleads-memory/source_capture.py", "plugins/saleads-memory/specialist_capture.py", "plugins/saleads-memory/dispatch.py", "plugins/saleads-memory/turn_frames.py", "plugins/saleads-memory/contracts/knowledge-candidate.schema.json", "plugins/saleads-memory/contracts/specialist-experience.schema.json", "plugins/saleads-memory/contracts/goal-state.schema.json", "runtime/curation-dispatcher.py"}
    managed_v10 = managed_v9 | {"plugins/saleads-continuity/run_receipts.py"}
    managed_catalog = managed_v10 | {"plugins/saleads-continuity/role-catalog.json"}
    landing_memory = managed_catalog | {"plugins/saleads-memory/landing_experience.py"}
    allowed = landing_memory | {"runtime/landing-pilot/cli/landing_cli.py", "runtime/landing-pilot/cli/README.md", "runtime/landing-pilot/build_metadata.py"}
    try:
        data = base64.b64decode(b"".join(raw.split()), validate=True)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as src, tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as out:
            seen, total = set(), 0
            for m in src.getmembers():
                if m.isdir(): continue
                if not m.isfile() or m.name not in allowed or m.name in seen: bad("unsupported extension member")
                seen.add(m.name); total += m.size
                if total > 524288 or m.size < 0: bad("extension too large")
                info = tarfile.TarInfo(m.name); info.size = m.size; info.mode = 0o600; info.mtime = 0
                out.addfile(info, src.extractfile(m))
            if seen not in (allowed, landing_memory, managed_catalog, managed_v10, managed_v9, legacy, continuity): bad("incomplete extension payload")
    except (ValueError, tarfile.TarError): bad("invalid extensions archive")
    sys.exit(0)
if mode == "plugins-enable":
    try: cfg = yaml_loader()(raw.decode("utf-8")) or {}
    except Exception: bad("invalid plugin config")
    if not isinstance(cfg, dict): bad("invalid plugin config")
    plugins = cfg.setdefault("plugins", {})
    if not isinstance(plugins, dict): bad("invalid plugins section")
    enabled = plugins.setdefault("enabled", [])
    if not isinstance(enabled, list): bad("invalid enabled plugins")
    if len(sys.argv) > 2 and sys.argv[2] == "disable":
        plugins["enabled"] = [p for p in enabled if p != "saleads-meta-search"]
    elif "saleads-meta-search" not in enabled: enabled.append("saleads-meta-search")
    if len(sys.argv) > 3 and sys.argv[3] == "continuous" and "saleads-continuity" not in plugins["enabled"]:
        plugins["enabled"].append("saleads-continuity")
    if len(sys.argv) > 5 and sys.argv[5] == "memory" and "saleads-memory" not in plugins["enabled"]:
        plugins["enabled"].append("saleads-memory")
    if len(sys.argv) > 4 and sys.argv[4] == "root" and sys.argv[3] == "continuous":
        cfg.setdefault("platforms",{}).setdefault("saleads_home",{})["enabled"] = True
    sys.stdout.write(json.dumps(cfg, indent=2, ensure_ascii=False, default=str) + "\n")
    sys.exit(0)
if mode == "continuous-contexts":
    if len(raw) > 131072: bad("context registry too large")
    try: value = json.loads(raw)
    except (ValueError, UnicodeError): bad("invalid context registry")
    if not isinstance(value, dict) or value.get("schema_version") != "trusted-context-registry/1" or not isinstance(value.get("owner_id"), str) or not isinstance(value.get("contexts"), list) or not isinstance(value.get("jobs"), list): bad("invalid context registry")
    if len(value["contexts"]) > 50 or len(value["jobs"]) > 500: bad("context registry bound")
    sys.stdout.buffer.write(raw)
    sys.exit(0)
if mode in ("continuous-owner", "continuous-canary"):
    try: value = json.loads(raw)
    except (ValueError, UnicodeError): bad("invalid context registry")
    owner = value.get("owner_id") if isinstance(value, dict) else None
    if not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", owner): bad("invalid context owner")
    if mode == "continuous-owner": sys.stdout.write(owner)
    else:
        ids = value.get("operator_canary_client_message_ids", [])
        if not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(item, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", item) for item in ids): bad("invalid canary identities")
        sys.stdout.write(json.dumps({"schema_version":"operator-canary-clients/1","owner_id":owner,"client_message_ids":ids},separators=(",",":")))
    sys.exit(0)
if mode == "managed-roles":
    # Compatibility only for older accepted extension archives without a catalog.
    roles = ["ale","investigador","estratega","estructurador","analista","optimizador","curador"]
    if raw.strip():
        try: catalog = json.loads(raw)
        except (ValueError, UnicodeError): bad("invalid managed role catalog")
        if not isinstance(catalog,dict) or catalog.get("schema_version") != "actor-role-catalog/1": bad("invalid managed role catalog")
        roles, specialists = catalog.get("actor_roles"), catalog.get("specialist_roles")
        if not isinstance(roles,list) or not isinstance(specialists,list) or len(roles) > 32 or any(not isinstance(r,str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}",r) for r in roles + specialists): bad("invalid managed role catalog")
        if len(set(roles)) != len(roles) or set(roles) != {"ale","curador",*specialists}: bad("invalid managed role catalog")
    sys.stdout.write(" ".join(roles)); sys.exit(0)
if mode == "memory-token":
    import hashlib, hmac
    role = sys.argv[2] if len(sys.argv) > 2 else ""
    roles = sys.argv[3].split() if len(sys.argv) > 3 else []
    if role not in ["collector", *roles] or len(raw.strip()) < 32: bad("invalid memory identity")
    label = "mcl-collector" if role == "collector" else "mcl-profile:" + role
    sys.stdout.write(hmac.new(raw.strip(),label.encode(),hashlib.sha256).hexdigest())
    sys.exit(0)
if mode == "managed-memory-config":
    try: cfg = yaml_loader()(raw.decode("utf-8")) or {}
    except Exception: bad("invalid managed memory config")
    if not isinstance(cfg, dict): bad("invalid managed memory config")
    agent = cfg.setdefault("agent", {})
    memory = cfg.setdefault("memory", {})
    review = cfg.setdefault("auxiliary", {}).setdefault("background_review", {})
    if not all(isinstance(item,dict) for item in (agent,memory,review)): bad("invalid managed memory sections")
    disabled = agent.setdefault("disabled_toolsets", [])
    if not isinstance(disabled,list): bad("invalid disabled toolsets")
    agent["disabled_toolsets"] = list(dict.fromkeys(disabled + ["memory","session_search"]))
    memory["memory_enabled"] = False; memory["user_profile_enabled"] = False; review["enabled"] = False
    brain = cfg.get("mcp_servers",{}).get("saleads-brain")
    if isinstance(brain,dict): brain["tools"] = {"include":[]}
    sys.stdout.write(json.dumps(cfg,ensure_ascii=False,indent=2)+"\n"); sys.exit(0)
PROFILE_FILE_RE = re.compile(r"profiles/" + PROFILE_ID + r"/(?:SOUL\.md|profile-config\.yaml|skills/[A-Za-z0-9._/-]+)")
def profiles(blob):
    try: data = base64.b64decode(b"".join(blob.split()), validate=True)
    except Exception: bad("invalid base64")
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as src, tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as out:
            for m in src.getmembers():
                if m.isdir(): continue
                n = posixpath.normpath(m.name)
                if not m.isfile() or n != m.name or ".." in n.split("/") or not PROFILE_FILE_RE.fullmatch(n): bad("unsupported profiles member")
                info = tarfile.TarInfo(n)
                info.size = m.size; info.mode = 0o600; info.mtime = 0
                out.addfile(info, src.extractfile(m))
    except tarfile.TarError: bad("invalid tar.gz")
    sys.exit(0)
if mode == "profiles": profiles(raw)
def safe(p):
    if not p or p.startswith("/") or "\\" in p: bad("invalid path")
    n = posixpath.normpath(p)
    if n in (".", "..") or n.startswith("../") or "/../" in "/" + n + "/": bad("invalid path")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", n): bad("invalid path")
    return n
files = {}
if raw.lstrip()[:1] == b"{":
    try: obj = json.loads(raw)
    except ValueError: bad("invalid json")
    if not isinstance(obj, dict): bad("json must be an object")
    for k, v in obj.items():
        files[k] = (v if isinstance(v, str) else json.dumps(v, separators=(",", ":"))).encode()
elif mode == "skills":
    try: data = base64.b64decode(b"".join(raw.split()), validate=True)
    except Exception: bad("invalid base64")
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for m in t.getmembers():
                if m.isdir(): continue
                if not m.isfile(): bad("unsupported tar member")
                files[m.name] = t.extractfile(m).read()
    except tarfile.TarError: bad("invalid tar.gz")
else:
    bad("tokens must be a json object")
if mode == "tokens":
    alias = {"tokens.json": "saleads.json", "client.json": "saleads.client.json"}
    out = {}
    for k, v in files.items():
        name = alias.get(k, k)
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.json", name): bad("invalid token file name")
        out[name] = v
    files = out
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as t:
    for name in sorted(files):
        info = tarfile.TarInfo(safe(name))
        info.size = len(files[name]); info.mode = 0o600; info.mtime = 0
        t.addfile(info, io.BytesIO(files[name]))
'

run_helper() {
  if [ -n "${HERMES_PY_CMD:-}" ]; then  # tests only
    # shellcheck disable=SC2086 # word splitting intended (command + args)
    $HERMES_PY_CMD -c "$PY_HELPER" "$@"
  else
    "$DOCKER" run --rm -i --network none --entrypoint python3 "$HERMES_IMAGE" -c "$PY_HELPER" "$@"
  fi
}

# install_tree MODE SRC_VALUE DEST_DIR: writes the helper output into DEST_DIR
# (only the files it carries; other files there are left alone).
install_tree() {
  local mode=$1 src=$2 dest=$3 tmp rel
  tmp=$(mktemp -d "$STATE_DIR/tree.XXXXXX") || return 1
  if ! run_helper "$mode" <"$src" | tar -x -f - -C "$tmp" --no-same-owner 2>/dev/null; then
    rm -rf "$tmp"; return 1
  fi
  ensure_dir "$dest" || { rm -rf "$tmp"; return 1; }
  (cd "$tmp" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort) >"$STATE_DIR/tree-files.list"
  if ! (cd "$tmp" && find . -type f -print) | while IFS= read -r rel; do
    rel=${rel#./}
    case "$rel" in */*) mkdir_owned "$dest" "$(dirname "$rel")" || exit 1 ;; esac
    install_file "$tmp/$rel" "$dest/$rel" || exit 1
  done; then
    rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
}

# mkdir_owned BASE REL: creates BASE/REL one level at a time with 0700.
mkdir_owned() {
  local base=$1 rel=$2 cur=$1 part
  local IFS=/
  for part in $rel; do
    cur="$cur/$part"
    if [ ! -d "$cur" ]; then ensure_dir "$cur"; fi
  done
}

# ---------------------------------------------------------------- apply

CONFIG_CHANGED=0
RESTORE_RETRY=0

apply_simple() { # KEY STAGE DEST_NAME
  local key=$1 stage=$2 dest=$3 h
  [ -f "$stage/$key" ] || return 0
  h=$(value_hash "$stage" "$key")
  if [ "$h" != "$(state_get "$key")" ] || [ ! -f "$DATA_DIR/$dest" ]; then
    install_file "$stage/$key" "$DATA_DIR/$dest"
    state_set "$key" "$h"
    log "applied $key -> $dest ($(short "$h"))"
  fi
}

# config.yaml = existing file + the keys SaleADS owns from hermes-config
# (helper mode "config"). Hermes edits the file itself when the owner sets
# something up by chat (e.g. `platforms` for Telegram): that is kept. The list
# of paths managed last time lives in STATE_DIR/config-managed.list. Only runs
# when the metadata value changed, the merge protocol upgraded, or the file is missing.
# Token of Ale for the brain (MLB-009): derived from hermes-api-key, so the
# watcher gives the same value to the brain (env) and to Ale's config.yaml
# (MCP header) without another metadata key. Never logged.
brain_token() {
  [ -f "$1/hermes-api-key" ] || return 0
  printf 'saleads-brain-ale:%s' "$(tr -d '\r\n' <"$1/hermes-api-key")" | sha256_stdin
}

apply_config() {
  local stage=$1 h prev in out f status token changed
  [ -f "$stage/hermes-config" ] || return 0
  token=$(brain_token "$stage")
  h=$( { value_hash "$stage" hermes-config; printf '%s' "$token" | sha256_stdin; } | sha256_stdin)
  prev=$(state_get hermes-config)
  if [ "$h" = "$prev" ] && [ -f "$DATA_DIR/config.yaml" ] \
    && [ "$(state_get config-merge-version)" = "$WATCHER_VERSION" ]; then return 0; fi
  in=$(mktemp -d "$STATE_DIR/cfgin.XXXXXX") || return 1
  out=$(mktemp -d "$STATE_DIR/cfgout.XXXXXX") || { rm -rf "$in"; return 1; }
  cp "$stage/hermes-config" "$in/meta"
  set -- meta
  if [ -f "$DATA_DIR/config.yaml" ]; then cp "$DATA_DIR/config.yaml" "$in/current"; set -- "$@" current; fi
  if [ -f "$STATE_DIR/config-managed.list" ]; then cp "$STATE_DIR/config-managed.list" "$in/managed"; set -- "$@" managed; fi
  if [ -n "$token" ]; then printf '%s' "$token" >"$in/brain_token"; set -- "$@" brain_token; fi
  if ! tar -c -f - -C "$in" "$@" | run_helper config | tar -x -f - -C "$out" --no-same-owner 2>/dev/null \
    || [ ! -f "$out/config.yaml" ] || [ ! -f "$out/managed" ]; then
    rm -rf "$in" "$out"; log "invalid hermes-config; not applied"; return 1
  fi
  status=$(cat "$out/status" 2>/dev/null || true)
  changed=$(cat "$out/changed" 2>/dev/null || true)
  install_file "$out/config.yaml" "$DATA_DIR/config.yaml"
  f="$STATE_DIR/config-managed.list"
  cp "$out/managed" "$f.tmp" && chmod 0600 "$f.tmp" && mv -f "$f.tmp" "$f"
  rm -rf "$in" "$out"
  if [ "$status" = replaced_invalid ]; then log "existing config.yaml was not valid YAML; replaced with hermes-config"; fi
  if [ -n "$prev" ] && { [ "$h" != "$prev" ] || [ "$changed" = 1 ]; }; then CONFIG_CHANGED=1; fi
  state_set hermes-config "$h"
  state_set config-merge-version "$WATCHER_VERSION"
  if [ -n "$token" ]; then printf '%s' "$token" >"$STATE_DIR/brain-token"; chmod 0600 "$STATE_DIR/brain-token"; fi
  log "applied hermes-config -> config.yaml (${status:-new}, $(short "$h"))"
}

# Prints the variable name of each assignment line (KEY=..., export KEY=...).
env_keys() {
  awk '{
    line = $0; sub(/^[ \t]+/, "", line); sub(/^export[ \t]+/, "", line)
    if (line ~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) { sub(/[ \t]*=.*/, "", line); print line }
  }'
}

# .env = existing lines that SaleADS does not manage (kept as they are, e.g.
# TELEGRAM_* written by Hermes) + hermes-env (without API_SERVER_* lines) +
# API_SERVER_* owned here. SaleADS manages the keys of hermes-env and every
# API_SERVER_*; a key it managed last time (STATE_DIR/env-managed.list) that
# hermes-env no longer carries is removed.
apply_env() {
  local stage=$1 h key tmp meta keys drop
  if [ ! -f "$stage/hermes-api-key" ]; then log "hermes-api-key missing; .env not written"; return 0; fi
  key=$(tr -d '\r\n' <"$stage/hermes-api-key")
  if [ "${#key}" -lt 16 ]; then log "hermes-api-key shorter than 16 chars; .env not written"; return 0; fi
  h=$( { value_hash "$stage" hermes-api-key; value_hash "$stage" hermes-env; } | sha256_stdin)
  if [ "$h" = "$(state_get env)" ] && [ -f "$DATA_DIR/.env" ]; then return 0; fi
  tmp="$STATE_DIR/env.tmp"; meta="$STATE_DIR/env-meta.tmp"; keys="$STATE_DIR/env-managed.tmp"
  : >"$meta"
  if [ -f "$stage/hermes-env" ]; then
    tr -d '\r' <"$stage/hermes-env" | grep -v -E '^[[:space:]]*(export[[:space:]]+)?API_SERVER_' \
      | grep -v -E '^[[:space:]]*$' >"$meta" || true
  fi
  env_keys <"$meta" | sort -u >"$keys"
  drop=$( { cat "$keys"; cat "$STATE_DIR/env-managed.list" 2>/dev/null || true; } | tr '\n' ' ')
  {
    if [ -f "$DATA_DIR/.env" ]; then
      awk -v drop="$drop" 'BEGIN { n = split(drop, list, " "); for (i = 1; i <= n; i++) managed[list[i]] = 1 }
        {
          line = $0; sub(/^[ \t]+/, "", line); sub(/^export[ \t]+/, "", line)
          if (line ~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) {
            sub(/[ \t]*=.*/, "", line)
            if (line ~ /^API_SERVER_/ || (line in managed)) next
          }
          print
        }' "$DATA_DIR/.env"
    fi
    cat "$meta"
    printf 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=%s\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=%s\n' "$key" "$API_PORT"
  } >"$tmp"
  install_file "$tmp" "$DATA_DIR/.env"
  mv -f "$keys" "$STATE_DIR/env-managed.list"
  rm -f "$tmp" "$meta"
  # Container env: only API_SERVER_* (never the AI key, which Hermes reads
  # from /opt/data/.env with override=True on every run; G-07 of OCB-002).
  printf 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=%s\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=%s\n' "$key" "$API_PORT" \
    >"$STATE_DIR/container.env"
  chmod 0600 "$STATE_DIR/container.env"
  state_set env "$h"
  log "applied hermes-api-key+hermes-env -> .env ($(short "$h"))"
}

# Written only when the metadata value changed: Hermes owns the refresh and
# rewrites mcp-tokens/saleads.json itself; we must not clobber it.
apply_tree() { # KEY MODE STAGE DEST_DIR
  local key=$1 mode=$2 stage=$3 dest=$4 h
  [ -f "$stage/$key" ] || return 0
  h=$(value_hash "$stage" "$key")
  [ "$h" != "$(state_get "$key")" ] || return 0
  if ! install_tree "$mode" "$stage/$key" "$dest"; then log "invalid $key; not applied"; return 1; fi
  if [ "$mode" = skills ]; then prune_skills "$dest"; fi
  state_set "$key" "$h"
  log "applied $key ($(short "$h"))"
}

# Deletes the skill files SaleADS installed last time and no longer sends
# (STATE_DIR/skills-managed.list, or the profile's own list). Skills created by the agent are never in
# that list, so they are never touched.
prune_skills() { # DEST [PREV_LIST]
  local dest=$1 rel prev="${2:-$STATE_DIR/skills-managed.list}"
  if [ -f "$prev" ]; then
    LC_ALL=C sort "$prev" | LC_ALL=C comm -23 - "$STATE_DIR/tree-files.list" | while IFS= read -r rel; do
      case "$rel" in ''|/*|*..*) continue ;; esac
      if [ -f "$dest/$rel" ]; then rm -f "$dest/$rel"; log "removed managed skill file $rel"; fi
    done
  fi
  mv -f "$STATE_DIR/tree-files.list" "$prev"
}

apply_bundle_version() {
  local stage=$1
  [ -f "$stage/hermes-bundle-version" ] || return 0
  state_set hermes-bundle-version "$(value_hash "$stage" hermes-bundle-version)"
}

# ------------------------------------------------------------- container

container_running() { "$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true; }

ensure_image() {
  "$DOCKER" image inspect "$HERMES_IMAGE" >/dev/null 2>&1 && return 0
  log "pulling pinned Hermes image"
  "$DOCKER" pull "$HERMES_IMAGE" >/dev/null
}

# Echoes "created" when it had to create/start the container.
ensure_container() {
  local running cenv
  if [ ! -f "$DATA_DIR/.env" ] || [ ! -f "$DATA_DIR/config.yaml" ] || [ ! -f "$STATE_DIR/container.env" ]; then
    log "waiting for hermes-config and hermes-api-key before starting Hermes"; return 0
  fi
  cenv=$(sha256_file "$STATE_DIR/container.env")
  running=$(container_running)
  if [ -n "$running" ] && [ "$cenv" != "$(state_get container-env)" ]; then
    # API_SERVER_KEY changed (normally never): recreate with the new env.
    "$DOCKER" rm -f "$CONTAINER" >/dev/null || return 1
    log "container env changed; recreating"
    running=""
  fi
  case "$running" in
    true) return 0 ;;
    false) "$DOCKER" start "$CONTAINER" >/dev/null || return 1
      log "started existing container"; echo created ;;
    *)
      "$DOCKER" run -d --name "$CONTAINER" --restart=always \
        -p "$API_PORT:$API_PORT" \
        -v "$DATA_DIR:/opt/data" \
        --env-file "$STATE_DIR/container.env" \
        --log-opt max-size=10m --log-opt max-file=3 \
        "$HERMES_IMAGE" gateway run >/dev/null || return 1
      state_set container-env "$cenv"
      log "created container $CONTAINER"; echo created ;;
  esac
}

# ---------------------------------------------------------------- archive

# archive_list: the paths of ARCHIVE_PATHS that exist, for the root and for each
# profile, plus the shared board (ARCHIVE_SHARED). Relative to DATA_DIR.
archive_list() {
  local p d
  for p in $ARCHIVE_PATHS $ARCHIVE_SHARED $CHANNEL_FILES; do [ -e "$DATA_DIR/$p" ] && echo "$p"; done
  for d in "$DATA_DIR"/profiles/*; do
    [ -d "$d" ] || continue
    case "$(basename "$d")" in [a-z0-9]*) ;; *) continue ;; esac
    for p in $ARCHIVE_PATHS; do [ -e "$d/$p" ] && echo "profiles/$(basename "$d")/$p"; done
  done
  return 0
}

# Uploads memories/sessions to the signed URL in hermes-archive-url (PUT,
# application/gzip). The URL is a credential: never logged.
apply_archive() {
  local stage=$1 h list tgz code p was_running
  [ -f "$stage/hermes-archive-url" ] || return 0
  h=$(value_hash "$stage" hermes-archive-url)
  [ "$h" != "$(state_get hermes-archive-url)" ] || return 0
  list="$STATE_DIR/archive.list"; tgz="$STATE_DIR/archive.tgz"
  save_channels || true
  : >"$list"
  archive_list >"$list"
  was_running=$(container_running)
  # Stop Hermes so state.db is consistent; the VM is about to be deleted.
  if [ "$was_running" = "true" ]; then "$DOCKER" stop -t 30 "$CONTAINER" >/dev/null || true; fi
  if ! tar -czf "$tgz" -C "$DATA_DIR" -T "$list"; then
    rm -f "$tgz" "$list"
    if [ "$was_running" = "true" ]; then "$DOCKER" start "$CONTAINER" >/dev/null || true; fi
    log "archive tar failed"; return 1
  fi
  code=$(curl -sS --max-time 300 -X PUT -H 'Content-Type: application/gzip' \
    --upload-file "$tgz" -o /dev/null -w '%{http_code}' "$(cat "$stage/hermes-archive-url")") || code=000
  rm -f "$tgz" "$list"
  if [ "$was_running" = "true" ]; then "$DOCKER" start "$CONTAINER" >/dev/null || true; fi
  case "$code" in
    2??) state_set hermes-archive-url "$h"; guest_put archive-status "uploaded:$(short "$h")" || true
         log "archive uploaded (HTTP $code)"; return 0 ;;
    *) guest_put archive-status "failed:$code" || true; log "archive upload failed (HTTP $code)"; return 1 ;;
  esac
}

# save_channels: copies the channel lines of .env and the `platforms` section
# of config.yaml into saleads/ for the archive (none = files removed).
save_channels() {
  local dir="$DATA_DIR/saleads" lines platforms
  lines=$(grep -E "$CHANNEL_ENV_RE" "$DATA_DIR/.env" 2>/dev/null || true)
  platforms=$(run_helper platforms-get <"$DATA_DIR/config.yaml" 2>/dev/null || true)
  if [ -z "$lines" ] && [ -z "$platforms" ]; then rm -f "$dir/channels.env" "$dir/platforms.json"; return 0; fi
  mkdir_owned "$DATA_DIR" saleads
  if [ -n "$lines" ]; then printf '%s\n' "$lines" >"$dir/channels.env.tmp"; install_file "$dir/channels.env.tmp" "$dir/channels.env"; rm -f "$dir/channels.env.tmp"
  else rm -f "$dir/channels.env"; fi
  if [ -n "$platforms" ]; then printf '%s\n' "$platforms" >"$dir/platforms.json.tmp"; install_file "$dir/platforms.json.tmp" "$dir/platforms.json"; rm -f "$dir/platforms.json.tmp"
  else rm -f "$dir/platforms.json"; fi
}

# restore_channels: after a restore, puts the archived channel lines back in .env
# (keys .env already has win) and the `platforms` section in config.yaml.
restore_channels() {
  local dir="$DATA_DIR/saleads" key line tmp
  if [ -f "$dir/channels.env" ]; then
    touch "$DATA_DIR/.env"
    while IFS= read -r line; do
      key=$(printf '%s\n' "$line" | env_keys)
      [ -n "$key" ] || continue
      if ! env_keys <"$DATA_DIR/.env" | grep -qxF "$key"; then printf '%s\n' "$line" >>"$DATA_DIR/.env"; fi
    done < <(grep -E "$CHANNEL_ENV_RE" "$dir/channels.env" || true)
    chown "$OWNER" "$DATA_DIR/.env"; chmod 0600 "$DATA_DIR/.env"
    log "restore: channel lines back in .env"
  fi
  if [ -f "$dir/platforms.json" ]; then
    tmp=$(mktemp -d "$STATE_DIR/platforms.XXXXXX")
    cp "$dir/platforms.json" "$tmp/platforms"; set -- platforms
    if [ -f "$DATA_DIR/config.yaml" ]; then cp "$DATA_DIR/config.yaml" "$tmp/current"; set -- "$@" current; fi
    if tar -c -f - -C "$tmp" "$@" | run_helper platforms-merge >"$tmp/config.yaml" 2>/dev/null && [ -s "$tmp/config.yaml" ]; then
      install_file "$tmp/config.yaml" "$DATA_DIR/config.yaml"; log "restore: platforms back in config.yaml"
    fi
    rm -rf "$tmp"
  fi
  state_set channels "$(channel_hash)"
}

# channel_hash: hash of the channel lines of .env (empty when there are none).
channel_hash() {
  local lines
  lines=$(grep -E "$CHANNEL_ENV_RE" "$DATA_DIR/.env" 2>/dev/null || true)
  [ -n "$lines" ] && printf '%s\n' "$lines" | sha256_stdin || true
}

# ---------------------------------------------------------------- restore

# restore_into SRC DEST: moves each file of SRC into DEST unless DEST already
# has it (existing data always wins). A SQLite database travels with its
# -wal/-shm: they are restored only together with their .db. Adds to the
# counters RESTORED and KEPT (no subshell, so errexit stays active).
restore_into() {
  local src=$1 dest=$2 rel db list="$STATE_DIR/restore.files" dbs="$STATE_DIR/restore.dbs"
  (cd "$src" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort) >"$list"
  : >"$dbs"
  while IFS= read -r rel; do
    case "$rel" in
      *.db-wal|*.db-shm) db=${rel%-wal}; db=${db%-shm}
        if ! grep -qxF "$db" "$dbs"; then KEPT=$((KEPT + 1)); continue; fi ;;
      *) if [ -e "$dest/$rel" ]; then KEPT=$((KEPT + 1)); continue; fi
        case "$rel" in *.db) echo "$rel" >>"$dbs" ;; esac ;;
    esac
    case "$rel" in */*) mkdir_owned "$dest" "$(dirname "$rel")" ;; esac
    chown "$OWNER" "$src/$rel"; chmod 0600 "$src/$rel"
    mv -f "$src/$rel" "$dest/$rel"
    RESTORED=$((RESTORED + 1))
  done <"$list"
  rm -f "$list" "$dbs"
}

restore_done() {
  state_set restore "$1"; rm -f "$STATE_DIR/restore-tries.sha"
  guest_put restore-status "$1" || true
  log "restore $1"
}

# Restore of the memories archive on a new VM (D50). hermes-restore-url is a
# signed GET of the last archive of this user (a credential: never logged).
# Runs ONCE per VM and only before Hermes was ever created here, so it never
# races a live state.db. Only a transient download error sets RESTORE_RETRY=1
# (Hermes is not started in that pass, no ack); any other outcome is final and
# Hermes starts with what is there. Root files go in place now; a profile's files
# only when the archive carries its state.db (a profile identity marker), so
# `hermes profile create` never meets a marker-less directory.
apply_restore() {
  local stage=$1 tgz tmp code tries p name
  [ -f "$stage/hermes-restore-url" ] || return 0
  [ -z "$(state_get restore)" ] || return 0
  if [ -n "$(container_running)" ]; then restore_done skipped:hermes_exists; return 0; fi
  tgz="$STATE_DIR/restore.tgz"
  code=$(curl -sS --max-time 600 -o "$tgz" -w '%{http_code}' "$(cat "$stage/hermes-restore-url")") || code=000
  case "$code" in
    2??) ;;
    000|408|429|5??)
      rm -f "$tgz"
      tries=$(state_get restore-tries); tries=$(( ${tries:-0} + 1 ))
      if [ "$tries" -lt "$RESTORE_TRIES" ]; then
        state_set restore-tries "$tries"; guest_put restore-status "retry:$code" || true
        log "restore download failed (HTTP $code); retrying before starting Hermes"; RESTORE_RETRY=1; return 0
      fi
      restore_done "failed:$code"; return 0 ;;
    *) rm -f "$tgz"; restore_done "failed:$code"; return 0 ;;
  esac
  tmp=$(mktemp -d "$STATE_DIR/restore.XXXXXX")
  if ! run_helper restore "$RESTORE_MAX_BYTES" <"$tgz" | tar -x -f - -C "$tmp" --no-same-owner 2>/dev/null; then
    rm -rf "$tmp" "$tgz"; restore_done failed:invalid; return 0
  fi
  rm -f "$tgz"
  RESTORED=0; KEPT=0
  if [ -d "$tmp/profiles" ]; then
    for p in "$tmp"/profiles/*; do
      [ -d "$p" ] || continue
      name=$(basename "$p")
      if [ ! -f "$p/state.db" ]; then log "restore: profile $name has no state.db; not restored"; continue; fi
      mkdir_owned "$DATA_DIR" "profiles/$name"
      restore_into "$p" "$DATA_DIR/profiles/$name"
    done
    rm -rf "$tmp/profiles"
  fi
  restore_into "$tmp" "$DATA_DIR"
  rm -rf "$tmp"
  restore_channels
  restore_done "restored:$RESTORED:kept:$KEPT"
}

# --------------------------------------------------- profiles (MLB-005a)

# A directory under profiles/ is a Hermes profile only with an identity file
# (hermes_constants.py _PROFILE_IDENTITY_MARKERS).
profile_has_identity() {
  local d=$1 m
  for m in config.yaml .env SOUL.md profile.yaml auth.json state.db; do
    if [ -f "$d/$m" ] || [ -L "$d/$m" ]; then return 0; fi
  done
  return 1
}

# install_profile_file SRC DEST STATE_KEY: replaces DEST when SRC changed.
install_profile_file() {
  local src=$1 dest=$2 key=$3 h
  h=$(sha256_file "$src")
  if [ "$h" != "$(state_get "$key")" ] || [ ! -f "$dest" ]; then
    install_file "$src" "$dest"; state_set "$key" "$h"; return 0
  fi
  return 1
}

# apply_profile NAME SRC_DIR STAGE: config, SOUL, .env, tokens and skills of
# one specialist, each with its own state under STATE_DIR/profiles/NAME.
apply_profile() {
  local n=$1 src=$2 stage=$3 dest="$DATA_DIR/profiles/$1" st="profiles/$1" out rel h list
  mkdir -p "$STATE_DIR/profiles/$n"; chmod 0700 "$STATE_DIR/profiles" "$STATE_DIR/profiles/$n"
  if [ ! -f "$stage/hermes-env" ]; then log "profile $n: hermes-env missing; not written"; return 0; fi
  if ! profile_has_identity "$dest"; then
    # Never write into profiles/<n>/ before `profile create`: it refuses a
    # marker-less directory. "already exists" (a profile restored with its
    # state.db, or created by an earlier pass) counts as success.
    out=$("$DOCKER" exec "$CONTAINER" hermes profile create "$n" --no-skills --description "SaleADS specialist $n" 2>&1) \
      || case "$out" in *"already exists"*) ;; *) log "profile $n: create failed"; return 1 ;; esac
    log "profile $n created"
  fi
  ensure_dir "$dest"
  # config.yaml = hermes-config (model, MCP, timezone, approvals...) + the
  # profile layer (MCP tool filters, toolsets, memory). Owned by SaleADS.
  if [ -f "$stage/hermes-config" ] && [ -f "$src/profile-config.yaml" ]; then
    h=$( { sha256_file "$stage/hermes-config"; sha256_file "$src/profile-config.yaml"; } | sha256_stdin)
    if [ "$h" != "$(state_get "$st/config")" ] || [ ! -f "$dest/config.yaml" ]; then
      out=$(mktemp -d "$STATE_DIR/pcfg.XXXXXX")
      cp "$stage/hermes-config" "$out/meta"; cp "$src/profile-config.yaml" "$out/layer"
      local profile_parts="meta layer"
      if [ -f "$dest/config.yaml" ]; then cp "$dest/config.yaml" "$out/current"; profile_parts="meta layer current"; fi
      # shellcheck disable=SC2086 # fixed allowlisted member names only
      if ! tar -c -f - -C "$out" $profile_parts | run_helper profile-config >"$out/config.yaml" 2>/dev/null; then
        rm -rf "$out"; log "profile $n: invalid config; not applied"; return 1
      fi
      install_file "$out/config.yaml" "$dest/config.yaml"; rm -rf "$out"
      state_set "$st/config" "$h"; log "profile $n: config.yaml ($(short "$h"))"
    fi
  fi
  if [ -f "$src/SOUL.md" ] && install_profile_file "$src/SOUL.md" "$dest/SOUL.md" "$st/soul"; then log "profile $n: SOUL.md"; fi
  out="$STATE_DIR/profiles/$n/env.tmp"
  tr -d '\r' <"$stage/hermes-env" | grep -v -E "^[[:space:]]*(export[[:space:]]+)?($PROFILE_ENV_DROP)" \
    | grep -v -E '^[[:space:]]*$' >"$out" || true
  if install_profile_file "$out" "$dest/.env" "$st/env"; then log "profile $n: .env"; fi
  rm -f "$out"
  # OAuth tokens: one copy per profile (Hermes does not share OAuth MCP
  # connections across profiles). Written when the metadata value changed or
  # when the profile has none yet; Hermes refreshes its own copy afterwards.
  if [ -f "$stage/hermes-mcp-tokens" ]; then
    h=$(value_hash "$stage" hermes-mcp-tokens)
    if [ "$h" != "$(state_get "$st/tokens")" ] || [ ! -f "$dest/mcp-tokens/saleads.json" ]; then
      install_tree tokens "$stage/hermes-mcp-tokens" "$dest/mcp-tokens" || { log "profile $n: invalid tokens"; return 1; }
      rm -f "$STATE_DIR/tree-files.list"; state_set "$st/tokens" "$h"; log "profile $n: mcp-tokens"
    fi
  fi
  # Skills of the profile: installed and pruned with the profile's own list.
  list="$STATE_DIR/profiles/$n/skills-managed.list"
  if [ -d "$src/skills" ]; then
    h=$( (cd "$src/skills" && find . -type f -print | LC_ALL=C sort | while IFS= read -r rel; do printf '%s %s\n' "$rel" "$(sha256_file "$rel")"; done) | sha256_stdin)
  else
    h=none
  fi
  if [ "$h" != "$(state_get "$st/skills")" ]; then
    ensure_dir "$dest/skills"
    : >"$STATE_DIR/tree-files.list"
    if [ -d "$src/skills" ]; then
      (cd "$src/skills" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort) >"$STATE_DIR/tree-files.list"
      while IFS= read -r rel; do
        case "$rel" in */*) mkdir_owned "$dest/skills" "$(dirname "$rel")" ;; esac
        install_file "$src/skills/$rel" "$dest/skills/$rel"
      done <"$STATE_DIR/tree-files.list"
    fi
    prune_skills "$dest/skills" "$list"
    state_set "$st/skills" "$h"; log "profile $n: skills ($(short "$h"))"
  fi
}

# Specialist profiles (hermes-profiles). Hermes must be running: profiles
# are created with `hermes profile create` inside the container, and only
# then their files are written. No container restart: each Kanban worker is a
# new `hermes -p <n>` process that reads its profile when it starts.
apply_profiles() {
  local stage=$1 tmp d n rc=0
  [ -f "$stage/hermes-profiles" ] || return 0
  if [ "$(container_running)" != "true" ]; then log "hermes-profiles waiting for Hermes to run"; return 1; fi
  tmp=$(mktemp -d "$STATE_DIR/profiles.XXXXXX")
  if ! run_helper profiles <"$stage/hermes-profiles" | tar -x -f - -C "$tmp" --no-same-owner 2>/dev/null; then
    rm -rf "$tmp"; log "invalid hermes-profiles; not applied"; return 1
  fi
  mkdir_owned "$DATA_DIR" profiles
  for d in "$tmp"/profiles/*; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    case "$n" in default|*[!a-z0-9_-]*|[!a-z0-9]*) log "profile name refused"; rc=1; continue ;; esac
    apply_profile "$n" "$d" "$stage" || rc=1
  done
  rm -rf "$tmp"
  return "$rc"
}

# Kanban on the root profile, once per VM: Ale creates cards from the API
# server (web chat), cron (saleads:loop-tick) and the channels. Through
# `hermes tools enable` (never by merging platform_toolsets: the owner's
# choices stay). A restart makes the gateway read the new toolsets.
KANBAN_PLATFORMS="api_server cron telegram whatsapp"
ensure_kanban_toolsets() {
  local stage=$1 want p
  [ -f "$stage/hermes-profiles" ] || return 0
  [ "$(container_running)" = "true" ] || return 0
  want=$(printf 'kanban %s' "$KANBAN_PLATFORMS" | sha256_stdin)
  [ "$want" != "$(state_get kanban-toolsets)" ] || return 0
  for p in $KANBAN_PLATFORMS; do
    "$DOCKER" exec "$CONTAINER" hermes tools enable kanban --platform "$p" >/dev/null 2>&1 \
      || { log "kanban toolset for $p failed"; return 1; }
  done
  "$DOCKER" restart "$CONTAINER" >/dev/null && log "kanban toolsets enabled; container restarted"
  state_set kanban-toolsets "$want"
}

# ------------------------------------------------------- brain (OSB-005)

on_network() { "$DOCKER" inspect -f '{{json .NetworkSettings.Networks}}' "$1" 2>/dev/null | grep -q "\"$NETWORK\""; }
running() { [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = true ]; }

# Docker auth for the private repository saleads-brain with the VM's metadata
# token (the VM SA can only read that repository).
ar_auth() {
  [ -f "$HERMES_ROOT/docker-config/config.json" ] && return 0
  mkdir -p "$HERMES_ROOT/docker-config"; chmod 0700 "$HERMES_ROOT/docker-config"
  DOCKER_CONFIG="$HERMES_ROOT/docker-config" "$DOCKER_CRED" configure-docker --registries="$AR_REGISTRY" >/dev/null 2>&1
}

# Brain env = the owner's AI key lines of .env (never API_SERVER_* nor TELEGRAM_*).
brain_env() {
  local out="$STATE_DIR/brain.env" identity
  { grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$DATA_DIR/.env" 2>/dev/null \
      | grep -v -E '^[[:space:]]*(export[[:space:]]+)?(API_SERVER_|TELEGRAM_)' || true
    printf 'FALKOR_HOST=%s\nBRAIN_DATA=/brain\nBRAIN_PORT=%s\n' "$FALKOR_CONTAINER" "$BRAIN_PORT"
    if [ -f "$STATE_DIR/brain-token" ]; then printf 'BRAIN_ALE_TOKEN=%s\n' "$(cat "$STATE_DIR/brain-token")"; fi
    if [ -f "$DATA_DIR/saleads/continuous/trusted-contexts.json" ]; then
      identity=$(run_helper continuous-owner <"$DATA_DIR/saleads/continuous/trusted-contexts.json") || return 1
      printf 'BRAIN_OWNER_ID=%s\nBRAIN_MANAGED_CURATION=true\n' "$identity"
    fi
  } >"$out"
  chmod 0600 "$out"
}

ensure_brain() {
  local stage=$1 image ident
  [ -f "$stage/hermes-brain-image" ] || return 0
  [ -f "$DATA_DIR/.env" ] || { log "brain waits for .env"; return 0; }
  image=$(tr -d '\r\n' <"$stage/hermes-brain-image")
  case "$image" in "$AR_REGISTRY"/*@sha256:*) ;; *) log "hermes-brain-image must be a pinned $AR_REGISTRY digest"; return 1 ;; esac
  "$DOCKER" network inspect "$NETWORK" >/dev/null 2>&1 || "$DOCKER" network create "$NETWORK" >/dev/null || return 1
  mkdir -p "$BRAIN_DIR/falkordb" "$BRAIN_DIR/data"; chown "$OWNER" "$BRAIN_DIR/data"
  mkdir_owned "$DATA_DIR" saleads/graph
  if ! running "$FALKOR_CONTAINER"; then
    "$DOCKER" rm -f "$FALKOR_CONTAINER" >/dev/null 2>&1 || true
    "$DOCKER" run -d --name "$FALKOR_CONTAINER" --restart=always --network "$NETWORK" --memory 768m \
      -e REDIS_ARGS="--maxmemory 512mb" -v "$BRAIN_DIR/falkordb:/data" \
      --log-opt max-size=10m --log-opt max-file=3 "$FALKOR_IMAGE" >/dev/null || return 1
    log "started $FALKOR_CONTAINER"
  fi
  brain_env
  ident=$( { printf '%s\n' "$image"; sha256_file "$STATE_DIR/brain.env"; } | sha256_stdin)
  if ! running "$BRAIN_CONTAINER" || [ "$ident" != "$(state_get brain)" ]; then
    ar_auth || { log "artifact registry auth failed"; return 1; }
    DOCKER_CONFIG="$HERMES_ROOT/docker-config" "$DOCKER" pull "$image" >/dev/null || { log "brain image pull failed"; return 1; }
    "$DOCKER" rm -f "$BRAIN_CONTAINER" >/dev/null 2>&1 || true
    "$DOCKER" run -d --name "$BRAIN_CONTAINER" --restart=always --network "$NETWORK" --memory 768m \
      --env-file "$STATE_DIR/brain.env" -v "$BRAIN_DIR/data:/brain" -v "$DATA_DIR:/opt/data:ro" \
      -v "$DATA_DIR/saleads/graph:/opt/data/saleads/graph" \
      --log-opt max-size=10m --log-opt max-file=3 "$image" >/dev/null || return 1
    state_set brain "$ident"
    log "started $BRAIN_CONTAINER ($(short "$ident"))"
  fi
  if running "$CONTAINER" && ! on_network "$CONTAINER"; then
    "$DOCKER" network connect "$NETWORK" "$CONTAINER" >/dev/null && log "connected $CONTAINER to $NETWORK"
  fi
}

# Seed: the signed GET URL is a credential (never logged). The brain loads it
# itself, without AI (ingest-seed only writes structured facts). A new brain
# image re-applies the local seed: ingest-seed is an idempotent upsert that
# repairs facts written by an older image (e.g. edges without uuid/episodes).
apply_seed() {
  local stage=$1 h img dir code
  [ -f "$stage/hermes-seed-url" ] || return 0
  h=$(value_hash "$stage" hermes-seed-url)
  img=$(value_hash "$stage" hermes-brain-image)
  dir="$DATA_DIR/saleads/seed"
  if [ "$h" = "$(state_get hermes-seed-url)" ]; then
    [ "$img" != "$(state_get seed-brain-image)" ] && [ -f "$dir/seed.json" ] || return 0
  fi
  running "$BRAIN_CONTAINER" || return 0
  if [ "$h" != "$(state_get hermes-seed-url)" ]; then
    mkdir_owned "$DATA_DIR" saleads/seed
    code=$(curl -sS --max-time 120 -o "$dir/seed.json.tmp" -w '%{http_code}' "$(cat "$stage/hermes-seed-url")") || code=000
    case "$code" in
      2??) chown "$OWNER" "$dir/seed.json.tmp"; chmod 0600 "$dir/seed.json.tmp"; mv -f "$dir/seed.json.tmp" "$dir/seed.json" ;;
      *) rm -f "$dir/seed.json.tmp"; guest_put seed-status "failed:$code" || true; log "seed download failed (HTTP $code)"; return 1 ;;
    esac
  fi
  if "$DOCKER" exec "$BRAIN_CONTAINER" saleads-brain ingest-seed /opt/data/saleads/seed/seed.json >/dev/null; then
    state_set hermes-seed-url "$h"; state_set seed-brain-image "$img"
    guest_put seed-status "loaded:$(short "$h")" || true; log "seed loaded ($(short "$h"))"
  else
    guest_put seed-status failed:ingest || true; log "seed ingest failed"; return 1
  fi
}

# No-agent cron jobs of the brain (stdout empty = silence). POST /api/jobs does
# not accept script/no_agent, so they are created with the Hermes CLI.
BRAIN_JOBS="ingest-day|15 3 * * *
analyze|45 3 * * *
export-snapshot|0 */6 * * *
extract-lessons|30 4 * * *
decay|0 5 * * *"

brain_job_script() {
  cat <<EOF
import json, sys, urllib.request
req = urllib.request.Request("http://$BRAIN_CONTAINER:$BRAIN_PORT/run/$1", data=b"{}", method="POST",
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=3000) as res:
    body = json.loads(res.read() or b"{}")
message = (body.get("message") or "").strip()
if message:
    sys.stdout.write(message + "\n")
EOF
}

ensure_brain_jobs() {
  local want listed dir
  running "$BRAIN_CONTAINER" && running "$CONTAINER" || return 0
  want=$(printf '%s\n' "$BRAIN_JOBS" | sha256_stdin)
  [ "$want" != "$(state_get brain-jobs)" ] || return 0
  dir="$DATA_DIR/scripts/saleads"; mkdir_owned "$DATA_DIR" scripts/saleads
  listed=$("$DOCKER" exec "$CONTAINER" hermes cron list 2>/dev/null) || { log "hermes cron list failed"; return 1; }
  printf '%s\n' "$BRAIN_JOBS" | while IFS='|' read -r cmd sched; do
    [ -n "$cmd" ] || continue
    brain_job_script "$cmd" >"$dir/brain_$cmd.py.tmp"; chown "$OWNER" "$dir/brain_$cmd.py.tmp"; chmod 0700 "$dir/brain_$cmd.py.tmp"
    mv -f "$dir/brain_$cmd.py.tmp" "$dir/brain_$cmd.py"
    if ! printf '%s\n' "$listed" | grep -q "saleads:brain-$cmd\$"; then
      "$DOCKER" exec "$CONTAINER" hermes cron create "$sched" --name "saleads:brain-$cmd" --no-agent \
        --script "saleads/brain_$cmd.py" --deliver local >/dev/null || exit 1
      log "created job saleads:brain-$cmd"
    fi
  done || return 1
  state_set brain-jobs "$want"
}

# Managed native plugin and RO exporter. Only this fixed archive is installed.
managed_role_allowed() {
  local role=$1 catalog="$DATA_DIR/plugins/saleads-continuity/role-catalog.json"
  if [ -z "$MANAGED_ROLE_LIST" ]; then
    if [ -f "$catalog" ] && [ ! -L "$catalog" ]; then
      MANAGED_ROLE_LIST=$(run_helper managed-roles <"$catalog") || return 1
    elif [ -e "$catalog" ] || [ -L "$catalog" ]; then return 1
    else MANAGED_ROLE_LIST=$(run_helper managed-roles </dev/null) || return 1; fi
  fi
  case " $MANAGED_ROLE_LIST " in *" $role "*) return 0 ;; *) return 1 ;; esac
}

install_meta_plugin_home() {
  local src=$1 dest=$2 f tmp managed=0
  [ "$dest" != "$DATA_DIR" ] || managed=1
  if [ "$dest" != "$DATA_DIR" ] && [ "$(basename "$dest")" != ale ] && managed_role_allowed "$(basename "$dest")"; then managed=1; fi
  [ "$managed" = 1 ] || return 0
  mkdir_owned "$dest" plugins/saleads-meta-search
  for f in plugin.yaml __init__.py search.py; do
    if ! cmp -s "$src/plugins/saleads-meta-search/$f" "$dest/plugins/saleads-meta-search/$f"; then
      cp "$src/plugins/saleads-meta-search/$f" "$dest/plugins/saleads-meta-search/$f"
      chown "$OWNER" "$dest/plugins/saleads-meta-search/$f"; chmod 0600 "$dest/plugins/saleads-meta-search/$f"
      [ "$dest" != "$DATA_DIR" ] || CONFIG_CHANGED=1
    fi
  done
  if [ "$managed" = 1 ] && [ -d "$src/plugins/saleads-continuity" ]; then
    mkdir_owned "$dest" plugins/saleads-continuity
    for f in plugin.yaml __init__.py context.py role-catalog.json notifications.py delivery.py turn_frames.py goal_delivery.py run_receipts.py; do
      [ -f "$src/plugins/saleads-continuity/$f" ] || continue
      if ! cmp -s "$src/plugins/saleads-continuity/$f" "$dest/plugins/saleads-continuity/$f"; then
        cp "$src/plugins/saleads-continuity/$f" "$dest/plugins/saleads-continuity/$f"
        chown "$OWNER" "$dest/plugins/saleads-continuity/$f"; chmod 0600 "$dest/plugins/saleads-continuity/$f"
        [ "$dest" != "$DATA_DIR" ] || CONFIG_CHANGED=1
      fi
    done
  fi
  if [ "$managed" = 1 ] && [ -d "$src/plugins/saleads-memory" ]; then
    mkdir_owned "$dest" plugins/saleads-memory/contracts
    for f in plugin.yaml __init__.py client.py context.py memory.py schemas.py source_capture.py specialist_capture.py landing_experience.py dispatch.py turn_frames.py contracts/knowledge-candidate.schema.json contracts/specialist-experience.schema.json contracts/goal-state.schema.json; do
      [ "$f" != landing_experience.py ] || [ -f "$src/plugins/saleads-memory/$f" ] || continue
      if ! cmp -s "$src/plugins/saleads-memory/$f" "$dest/plugins/saleads-memory/$f"; then
        cp "$src/plugins/saleads-memory/$f" "$dest/plugins/saleads-memory/$f"
        chown "$OWNER" "$dest/plugins/saleads-memory/$f"; chmod 0600 "$dest/plugins/saleads-memory/$f"
        [ "$dest" != "$DATA_DIR" ] || CONFIG_CHANGED=1
      fi
    done
  fi
  return 0
}
apply_extensions() {
  local stage=$1 h tmp d
  [ -f "$stage/hermes-extensions" ] || return 0
  h=$(value_hash "$stage" hermes-extensions)
  [ "$h" != "$(state_get extensions)" ] || return 0
  tmp=$(mktemp -d "$STATE_DIR/extensions.XXXXXX")
  if ! run_helper extensions <"$stage/hermes-extensions" | tar -x -f - -C "$tmp" --no-same-owner; then rm -rf "$tmp"; return 1; fi
  install_meta_plugin_home "$tmp" "$DATA_DIR" || { rm -rf "$tmp"; return 1; }
  MANAGED_ROLE_LIST=""
  mkdir_owned "$DATA_DIR" saleads/runtime
  cp "$tmp/runtime/first-loop-exporter.py" "$DATA_DIR/saleads/runtime/first-loop-exporter.py"
  chown "$OWNER" "$DATA_DIR/saleads/runtime/first-loop-exporter.py"; chmod 0600 "$DATA_DIR/saleads/runtime/first-loop-exporter.py"
  if [ -f "$tmp/runtime/continuous-exporter.py" ]; then
    cp "$tmp/runtime/continuous-exporter.py" "$DATA_DIR/saleads/runtime/continuous-exporter.py"
    chown "$OWNER" "$DATA_DIR/saleads/runtime/continuous-exporter.py"; chmod 0600 "$DATA_DIR/saleads/runtime/continuous-exporter.py"
  fi
  if [ -f "$tmp/runtime/curation-dispatcher.py" ]; then
    cp "$tmp/runtime/curation-dispatcher.py" "$DATA_DIR/saleads/runtime/curation-dispatcher.py"
    chown "$OWNER" "$DATA_DIR/saleads/runtime/curation-dispatcher.py"; chmod 0600 "$DATA_DIR/saleads/runtime/curation-dispatcher.py"
  fi
  if [ -d "$tmp/runtime/landing-pilot" ]; then
    # Only fixed service-owned helper files; preserve workspaces, receipts and manual profile data.
    [ ! -L "$DATA_DIR/saleads" ] && [ ! -L "$DATA_DIR/saleads/landing-pilot" ] && [ ! -L "$DATA_DIR/saleads/landing-pilot/cli" ] || { rm -rf "$tmp"; return 1; }
    mkdir_owned "$DATA_DIR" saleads/landing-pilot/cli
    local helper_rel helper_target
    for helper_rel in cli/landing_cli.py cli/README.md build_metadata.py; do
      helper_target="$DATA_DIR/saleads/landing-pilot/$helper_rel"
      [ ! -L "$helper_target" ] || { rm -rf "$tmp"; return 1; }
      if ! cmp -s "$tmp/runtime/landing-pilot/$helper_rel" "$helper_target"; then
        cp "$tmp/runtime/landing-pilot/$helper_rel" "$helper_target"
        chown "$OWNER" "$helper_target"; chmod 0600 "$helper_target"
      fi
    done
  fi
  for d in "$DATA_DIR"/profiles/*; do
    [ -d "$d" ] && [ -f "$d/profile.yaml" ] || continue
    install_meta_plugin_home "$tmp" "$d" || { rm -rf "$tmp"; return 1; }
  done
  state_set extensions "$h"; rm -rf "$tmp"
}

# Copy already-observed API-run state before a fresh gateway can prune its
# terminal idempotency rows. This fixed module only SELECTs the native DB and
# writes private receipt journals; it starts no gateway/model and has no network.
refresh_native_run_receipts() {
  local stage=$1 script="$DATA_DIR/plugins/saleads-continuity/run_receipts.py" copied=0
  [ -f "$stage/hermes-continuous-contexts" ] || return 0
  [ -f "$script" ] && [ ! -L "$script" ] || return 0
  [ -f "$DATA_DIR/runs_idempotency.db" ] && [ -d "$DATA_DIR/saleads/continuous/run-receipts/pre" ] || return 0
  if [ -n "${HERMES_PY_CMD:-}" ]; then  # tests: execute the same fixed script without Docker
    # shellcheck disable=SC2086 # command + fixed helper args, as in run_helper
    if $HERMES_PY_CMD "$script" --data-dir "$DATA_DIR" >/dev/null 2>&1; then copied=1; fi
  else
    if "$DOCKER" run --rm --network none --user "$OWNER" -v "$DATA_DIR:/opt/data" \
      --entrypoint python3 "$HERMES_IMAGE" /opt/data/plugins/saleads-continuity/run_receipts.py \
      --data-dir /opt/data >/dev/null 2>&1; then copied=1; fi
  fi
  if [ "$copied" = 1 ]; then guest_put run-receipts-status refreshed || true; return 0; fi
  guest_put run-receipts-status refresh_failed || true
  log "API-run receipt refresh failed before gateway start"
  return 1
}
# Profile merges may replace config.yaml without changing the extension tar.
# Re-enable only after its content hash changed; no repeated container helpers on stable cycles.
ensure_meta_plugin_config() {
  local stage=$1 mode=$2 d name h tmp key action continuity memory
  [ -f "$stage/hermes-extensions" ] || return 0
  for d in "$DATA_DIR" "$DATA_DIR"/profiles/*; do
    [ -d "$d" ] && [ -f "$d/config.yaml" ] && [ -f "$d/plugins/saleads-meta-search/plugin.yaml" ] || continue
    if [ "$mode" = root ] && [ "$d" != "$DATA_DIR" ]; then continue; fi
    if [ "$mode" = profiles ] && [ "$d" = "$DATA_DIR" ]; then continue; fi
    name=$(basename "$d"); [ "$d" != "$DATA_DIR" ] || name=root
    if [ "$name" != root ]; then [ "$name" != ale ] && managed_role_allowed "$name" || continue; fi
    key="extension-config-$name"; h=$(managed_plugin_config_hash "$d")
    [ "$h" != "$(state_get "$key")" ] || continue
    tmp=$(mktemp "$STATE_DIR/extension-config.XXXXXX")
    action=disable; [ "$d" != "$DATA_DIR/profiles/investigador" ] || action=enable
    continuity=legacy; [ ! -f "$d/plugins/saleads-continuity/plugin.yaml" ] || continuity=continuous
    memory=legacy; [ ! -f "$d/plugins/saleads-memory/plugin.yaml" ] || memory=memory
    if ! run_helper plugins-enable "$action" "$continuity" "$name" "$memory" <"$d/config.yaml" >"$tmp"; then rm -f "$tmp"; return 1; fi
    if ! cmp -s "$tmp" "$d/config.yaml"; then
      chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$d/config.yaml"
      [ "$d" != "$DATA_DIR" ] || CONFIG_CHANGED=1
    else rm -f "$tmp"; fi
    state_set "$key" "$(managed_plugin_config_hash "$d")"
  done
}

managed_plugin_config_hash() {
  local dir=$1 plugin
  { sha256_file "$dir/config.yaml"
    for plugin in saleads-meta-search saleads-continuity saleads-memory; do
      [ ! -f "$dir/plugins/$plugin/plugin.yaml" ] || printf '%s\n' "$plugin"
    done
  } | sha256_stdin
}

install_memory_auth() {
  local stage=$1 home role dir tmp
  [ -f "$stage/hermes-continuous-contexts" ] && [ -f "$STATE_DIR/brain-token" ] || return 0
  for home in "$DATA_DIR" "$DATA_DIR"/profiles/*; do
    [ -d "$home" ] || continue
    role=$(basename "$home"); [ "$home" != "$DATA_DIR" ] || role=ale
    managed_role_allowed "$role" || continue
    dir="$home/plugin-data/saleads-memory"
    [ ! -L "$home/plugin-data" ] && [ ! -L "$dir" ] || return 1
    mkdir_owned "$home" plugin-data/saleads-memory
    tmp=$(mktemp "$dir/.auth.XXXXXX")
    if ! run_helper memory-token "$role" "$MANAGED_ROLE_LIST" <"$STATE_DIR/brain-token" >"$tmp"; then rm -f "$tmp"; return 1; fi
    chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$dir/auth-token"
    tmp=$(mktemp "$dir/.collector.XXXXXX")
    if ! run_helper memory-token collector <"$STATE_DIR/brain-token" >"$tmp"; then rm -f "$tmp"; return 1; fi
    chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$dir/collector-token"
  done
}

apply_managed_memory_config() {
  local stage=$1 mode=$2 home tmp role
  [ -f "$stage/hermes-continuous-contexts" ] || return 0
  for home in "$DATA_DIR" "$DATA_DIR"/profiles/*; do
    [ -f "$home/config.yaml" ] && [ -f "$home/plugins/saleads-memory/plugin.yaml" ] || continue
    [ "$mode" != root ] || [ "$home" = "$DATA_DIR" ] || continue
    [ "$mode" != profiles ] || [ "$home" != "$DATA_DIR" ] || continue
    role=$(basename "$home"); [ "$home" != "$DATA_DIR" ] || role=ale
    managed_role_allowed "$role" || continue
    tmp=$(mktemp "$STATE_DIR/memory-config.XXXXXX")
    if ! run_helper managed-memory-config <"$home/config.yaml" >"$tmp"; then rm -f "$tmp"; return 1; fi
    if ! cmp -s "$tmp" "$home/config.yaml"; then
      chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$home/config.yaml"
      [ "$home" != "$DATA_DIR" ] || CONFIG_CHANGED=1
    else rm -f "$tmp"; fi
  done
}

ensure_memory_dispatcher_job() {
  local stage=$1 dir="$DATA_DIR/scripts/saleads" listed
  [ -f "$stage/hermes-continuous-contexts" ] && [ -f "$DATA_DIR/saleads/runtime/curation-dispatcher.py" ] || return 0
  running "$CONTAINER" && running "$BRAIN_CONTAINER" || return 0
  mkdir_owned "$DATA_DIR" scripts/saleads
  printf '%s\n' 'import runpy' 'runpy.run_path("/opt/data/saleads/runtime/curation-dispatcher.py",run_name="__main__")' >"$dir/curation-dispatcher.py"
  chown "$OWNER" "$dir/curation-dispatcher.py"; chmod 0700 "$dir/curation-dispatcher.py"
  [ "$(state_get memory-dispatcher-job)" != v1 ] || return 0
  listed=$("$DOCKER" exec "$CONTAINER" hermes cron list 2>/dev/null) || return 1
  if ! printf '%s\n' "$listed" | grep -q 'saleads:memory-reconcile$'; then
    "$DOCKER" exec "$CONTAINER" hermes cron create 'every 3h' --name saleads:memory-reconcile --script saleads/curation-dispatcher.py --no-agent --deliver local >/dev/null || return 1
  fi
  state_set memory-dispatcher-job v1
}

continuous_ready() {
  local stage=$1
  [ -f "$stage/hermes-continuous-contexts" ] || return 0
  [ -f "$stage/hermes-brain-image" ] && [ -f "$DATA_DIR/plugin-data/saleads-memory/collector-token" ] || return 1
  [ -f "$DATA_DIR/plugins/saleads-memory/plugin.yaml" ] && [ "$(state_get memory-dispatcher-job)" = v1 ] || return 1
  running "$CONTAINER" && running "$BRAIN_CONTAINER" || return 1
  "$DOCKER" exec --user "$OWNER" "$CONTAINER" python3 -c '
import json, pathlib, urllib.request
token=pathlib.Path("/opt/data/plugin-data/saleads-memory/collector-token").read_text().strip()
request=urllib.request.Request("http://saleads-brain:8765/continuous/ready",data=b"{}",method="POST",headers={"Content-Type":"application/json","x-saleads-memory-token":token})
with urllib.request.urlopen(request,timeout=3) as response:
    if response.status!=200 or json.loads(response.read(4096))!={"ready":True}: raise SystemExit(1)
' >/dev/null 2>&1
}

# Server-owned routing context is updated atomically without restarting Hermes.
apply_continuous_contexts() {
  local stage=$1 dir="$DATA_DIR/saleads/continuous" tmp hash
  [ -f "$stage/hermes-continuous-contexts" ] || return 0
  hash=$(value_hash "$stage" hermes-continuous-contexts)
  if [ "$hash" = "$(state_get continuous-contexts)" ] && [ -f "$dir/trusted-contexts.json" ] && [ -f "$dir/operator-canary-client-ids.json" ]; then
    return 0
  fi
  [ ! -L "$DATA_DIR/saleads" ] && [ ! -L "$dir" ] || return 1
  mkdir_owned "$DATA_DIR" saleads/continuous
  tmp=$(mktemp "$dir/.contexts.XXXXXX")
  if ! run_helper continuous-contexts <"$stage/hermes-continuous-contexts" >"$tmp"; then rm -f "$tmp"; return 1; fi
  chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$dir/trusted-contexts.json"
  tmp=$(mktemp "$dir/.canary.XXXXXX")
  if ! run_helper continuous-canary <"$stage/hermes-continuous-contexts" >"$tmp"; then rm -f "$tmp"; return 1; fi
  chown "$OWNER" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$dir/operator-canary-client-ids.json"
  state_set continuous-contexts "$hash"
}

apply_continuous_snapshot() {
  local stage=$1 file="$DATA_DIR/saleads/continuous/notifications.json.gz" sha code
  [ -f "$stage/hermes-continuous-url" ] && [ -f "$DATA_DIR/saleads/runtime/continuous-exporter.py" ] || return 0
  running "$CONTAINER" || return 0
  if ! "$DOCKER" exec --user "$OWNER" "$CONTAINER" python3 /opt/data/saleads/runtime/continuous-exporter.py --data-dir /opt/data >/dev/null 2>&1; then
    guest_put continuous-status export_failed || true; return 0
  fi
  [ -f "$file" ] || return 0
  sha=$(sha256_file "$file"); [ "$sha" != "$(state_get continuous-snapshot)" ] || return 0
  code=$(curl -sS --max-time 60 -X PUT -H 'Content-Type: application/gzip' --upload-file "$file" -o /dev/null -w '%{http_code}' "$(cat "$stage/hermes-continuous-url")") || code=000
  case "$code" in
    2??) state_set continuous-snapshot "$sha"; guest_put continuous-status uploaded || true ;;
    *) guest_put continuous-status upload_failed || true ;;
  esac
}

# Only these fixed directories belong to the first-loop transport. Repair an
# existing root-owned private parent before the unprivileged agent writes its
# brief. Never follow links or change ownership of saved files recursively.
ensure_first_loop_dirs() {
  local base="$DATA_DIR/saleads/first-loop" dir
  [ -d "$DATA_DIR/saleads" ] && [ ! -L "$DATA_DIR/saleads" ] || return 1
  for dir in "$base" "$base/flows" "$base/works"; do
    [ ! -L "$dir" ] || return 1
    if [ -e "$dir" ] && [ ! -d "$dir" ]; then return 1; fi
  done
  for dir in "$base" "$base/flows" "$base/works"; do
    [ -d "$dir" ] || mkdir "$dir" || return 1
    chown "$OWNER" "$dir" || return 1
    chmod 0700 "$dir" || return 1
  done
}

# Read-only SQLite snapshot in the existing Hermes container (COS has no host Python).
apply_first_loop_snapshot() {
  local stage=$1 file="$DATA_DIR/saleads/first-loop/snapshot.json.gz" sha code
  [ -f "$stage/hermes-first-loop-url" ] && [ -f "$DATA_DIR/saleads/runtime/first-loop-exporter.py" ] || return 0
  running "$CONTAINER" || return 0
  if ! ensure_first_loop_dirs; then
    log "first-loop directories could not be prepared"
    guest_put first-loop-status directory_failed || true; return 0
  fi
  if ! "$DOCKER" exec --user "$OWNER" "$CONTAINER" python3 /opt/data/saleads/runtime/first-loop-exporter.py --data-dir /opt/data >/dev/null 2>&1; then
    guest_put first-loop-status export_failed || true; return 0
  fi
  [ -f "$file" ] || return 0
  sha=$(sha256_file "$file")
  [ "$sha" != "$(state_get first-loop-snapshot)" ] || return 0
  code=$(curl -sS --max-time 60 -X PUT -H 'Content-Type: application/gzip' --upload-file "$file" -o /dev/null -w '%{http_code}' "$(cat "$stage/hermes-first-loop-url")") || code=000
  case "$code" in
    2??) state_set first-loop-snapshot "$sha"; guest_put first-loop-snapshot "$sha" || true; guest_put first-loop-status uploaded || true ;;
    *) guest_put first-loop-status upload_failed || true ;;
  esac
}

# Snapshot: export-snapshot writes saleads/graph/snapshot.json.gz; it is
# uploaded only when its sha changes (the signed PUT URL is never logged).
apply_snapshot() {
  local stage=$1 file="$DATA_DIR/saleads/graph/snapshot.json.gz" sha code
  [ -f "$stage/hermes-snapshot-url" ] && [ -f "$file" ] || return 0
  sha=$(sha256_file "$file")
  [ "$sha" != "$(state_get snapshot)" ] || return 0
  code=$(curl -sS --max-time 120 -X PUT -H 'Content-Type: application/gzip' --upload-file "$file" \
    -o /dev/null -w '%{http_code}' "$(cat "$stage/hermes-snapshot-url")") || code=000
  case "$code" in
    2??) state_set snapshot "$sha"; guest_put graph-snapshot "$sha" || true; guest_put snapshot-status "uploaded:$(short "$sha")" || true
         log "snapshot uploaded ($(short "$sha"))" ;;
    *) guest_put snapshot-status "failed:$code" || true; log "snapshot upload failed (HTTP $code)" ;;
  esac
  return 0
}

# ------------------------------------------------------------------ apply

apply_once() {
  local stage version created rc=0
  mkdir -p "$STATE_DIR"; chmod 0700 "$STATE_DIR"
  stage=$(mktemp -d "$STATE_DIR/stage.XXXXXX")
  if ! fetch_all "$stage"; then rm -rf "$stage"; return 1; fi
  version=$(compute_version "$stage")
  if ! ensure_image; then log "image pull failed"; rm -rf "$stage"; return 1; fi
  ensure_dir "$DATA_DIR"
  CONFIG_CHANGED=0
  apply_config "$stage" || rc=1
  apply_simple hermes-soul "$stage" SOUL.md
  apply_env "$stage"
  apply_tree hermes-mcp-tokens tokens "$stage" "$DATA_DIR/mcp-tokens" || rc=1
  apply_tree hermes-skills skills "$stage" "$DATA_DIR/skills" || rc=1
  apply_bundle_version "$stage"
  apply_extensions "$stage" || rc=1
  apply_continuous_contexts "$stage" || rc=1
  apply_managed_memory_config "$stage" root || rc=1
  ensure_meta_plugin_config "$stage" root || rc=1
  # The archive is restored before Hermes is created for the first time (D50).
  RESTORE_RETRY=0
  apply_restore "$stage"
  if [ "$RESTORE_RETRY" = 1 ]; then rc=1; created=""; else
    if ! refresh_native_run_receipts "$stage"; then
      rm -rf "$stage"; guest_put apply-status error || true; return 1
    fi
    created=$(ensure_container) || rc=1
  fi
  RESTARTED=0
  if [ "$CONFIG_CHANGED" = 1 ] && [ "$created" != "created" ] && [ "$(container_running)" = "true" ]; then
    "$DOCKER" restart "$CONTAINER" >/dev/null && log "config.yaml changed; container restarted" && RESTARTED=1
  fi
  apply_profiles "$stage" || rc=1
  # A first boot created specialist homes after the root extension install.
  if [ -f "$stage/hermes-extensions" ]; then
    for d in "$DATA_DIR"/profiles/*; do
      [ -d "$d" ] && [ -f "$d/profile.yaml" ] || continue
      if [ ! -f "$d/plugins/saleads-meta-search/plugin.yaml" ]; then rm -f "$STATE_DIR/extensions.sha"; break; fi
    done
    apply_extensions "$stage" || rc=1
  fi
  ensure_meta_plugin_config "$stage" profiles || rc=1
  install_memory_auth "$stage" || rc=1
  apply_managed_memory_config "$stage" profiles || rc=1
  ensure_kanban_toolsets "$stage" || rc=1
  ensure_brain "$stage" || rc=1
  apply_seed "$stage" || rc=1
  ensure_brain_jobs || rc=1
  ensure_memory_dispatcher_job "$stage" || rc=1
  apply_snapshot "$stage"
  apply_first_loop_snapshot "$stage"
  apply_continuous_snapshot "$stage"
  apply_archive "$stage" || rc=1
  continuous_ready "$stage" || rc=1
  guest_put watcher-version "$WATCHER_VERSION" || true
  if [ "$rc" -ne 0 ]; then rm -rf "$stage"; guest_put apply-status error || true; return 1; fi
  if [ -f "$stage/hermes-continuous-contexts" ]; then
    guest_put continuous-context-hash "$(state_get continuous-contexts)" || return 1
  fi
  rm -rf "$stage"
  if [ "$version" != "$(state_get applied-version)" ] || [ "${HERMES_FORCE_ACK:-0}" = 1 ]; then
    guest_put applied-version "$version" || { log "guest attribute write failed"; return 1; }
    state_set applied-version "$version"
    guest_put apply-status ok || true
    log "ack hermes/applied-version=$(short "$version")"
  fi
}

# ------------------------------------------------------------------ watch

watch_loop() {
  local etag=NONE new hdr rc iter=0 backoff=5
  # Re-publish the ack on every watcher start (guest attributes are reset
  # when the instance is recreated; harmless otherwise).
  HERMES_FORCE_ACK=1
  while :; do
    hdr=$(mktemp "$STATE_DIR/hdr.XXXXXX")
    if curl -sS -f --max-time $((WAIT_TIMEOUT_SEC + 30)) -H 'Metadata-Flavor: Google' -D "$hdr" -o /dev/null \
      "$MD_URL/instance/attributes/?recursive=true&wait_for_change=true&timeout_sec=$WAIT_TIMEOUT_SEC&last_etag=$etag"; then
      new=$(tr -d '\r' <"$hdr" | awk 'tolower($1)=="etag:"{print $2}' | tail -n 1)
      # Subshell with errexit really active: it must not run as an `if`
      # condition, where bash would ignore every failure inside apply_once.
      set +e
      (set -e; apply_once)
      rc=$?
      set -e
      if [ "$rc" -eq 0 ]; then
        etag=${new:-NONE}; backoff=5; HERMES_FORCE_ACK=0
      else
        sleep "$backoff"; [ "$backoff" -ge 60 ] || backoff=$((backoff * 2))
      fi
    else
      sleep "$backoff"
    fi
    rm -f "$hdr"
    iter=$((iter + 1))
    if [ "$WATCH_MAX_ITER" -gt 0 ] && [ "$iter" -ge "$WATCH_MAX_ITER" ]; then break; fi
  done
}

# ---------------------------------------------------------------- startup

write_unit() {
  cat >"$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=SaleADS Hermes metadata watcher
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=simple
ExecStart=/bin/bash $BIN_PATH watch
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_DIR/$UNIT_NAME"
}

startup() {
  if [ "$(id -u)" -ne 0 ]; then log "startup must run as root"; exit 1; fi
  mkdir -p "$HERMES_ROOT/bin" "$STATE_DIR"
  chmod 0700 "$HERMES_ROOT" "$HERMES_ROOT/bin" "$STATE_DIR"
  ensure_dir "$DATA_DIR"
  local self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ]; then
    install -m 0700 "$self" "$BIN_PATH"
  else
    md_get startup-script "$BIN_PATH" && chmod 0700 "$BIN_PATH"
  fi
  # COS host firewall drops inbound by default; the GCP firewall limits 8642
  # to the GKE pod range.
  iptables -w -C INPUT -p tcp --dport "$API_PORT" -j ACCEPT 2>/dev/null \
    || iptables -w -A INPUT -p tcp --dport "$API_PORT" -j ACCEPT
  systemctl start docker.service
  write_unit
  systemctl daemon-reload
  systemctl restart "$UNIT_NAME"
  log "watcher installed and started"
}

main() {
  case "${1:-startup}" in
    startup) startup ;;
    watch) mkdir -p "$STATE_DIR"; watch_loop ;;
    apply) apply_once ;;
    *) echo "usage: $0 [startup|watch|apply]" >&2; exit 64 ;;
  esac
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then main "$@"; fi
