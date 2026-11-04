#!/bin/bash
# Watcher tests with a simulated metadata server and a fake docker CLI.
# No Docker, no cloud. Requires bash, curl, python3 and tar.
#   bash vm/test/watcher-test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../startup-script.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hermes-watcher-test.XXXXXX")
PASS=0
FAIL=0

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  [ -n "${KEEP_WORK:-}" ] || rm -rf "$WORK"
}
trap cleanup EXIT

python3 -u "$HERE/fake_metadata.py" >"$WORK/port" 2>"$WORK/server.err" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port" ] && break; sleep 0.2; done
PORT=$(head -n 1 "$WORK/port")
BASE="http://127.0.0.1:$PORT"

export HERMES_MD_URL="$BASE/computeMetadata/v1"
export HERMES_ROOT="$WORK/root"
export HERMES_DATA_DIR="$WORK/root/data"
export HERMES_STATE_DIR="$WORK/root/state"
export HERMES_OWNER="$(id -u):$(id -g)"
export HERMES_DOCKER="$HERE/fake-docker.sh"
export HERMES_PY_CMD="python3"
export FAKE_DOCKER_LOG="$WORK/docker.log"
export FAKE_DOCKER_STATE="$WORK/docker.state"
D="$HERMES_DATA_DIR"
: >"$FAKE_DOCKER_LOG"

md_set() { curl -sS -f -X POST --data-binary "$2" "$BASE/_ctl/set/$1" >/dev/null; }
md_set_file() { curl -sS -f -X POST --data-binary "@$2" "$BASE/_ctl/set/$1" >/dev/null; }
md_del() { curl -sS -f -X POST "$BASE/_ctl/del/$1" >/dev/null; }
guest_get() { curl -sS "$BASE/_ctl/guest/$1"; }
apply() { bash "$SCRIPT" apply 2>>"$WORK/watcher.log"; }
docker_calls() { grep -c "^$1 " "$FAKE_DOCKER_LOG" || true; }
# yget FILE DOTTED.PATH -> value (JSON for mappings, "<absent>" when missing).
yget() {
  python3 - "$1" "$2" <<'PY'
import json, sys, yaml
cur = yaml.safe_load(open(sys.argv[1]).read())
for part in sys.argv[2].split("."):
    if not isinstance(cur, dict) or part not in cur:
        print("<absent>"); sys.exit(0)
    cur = cur[part]
print(cur if isinstance(cur, str) else json.dumps(cur, sort_keys=True))
PY
}
mode_of() { python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$1"; }

ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
ko() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

# Reference implementation of hermes/applied-version (the service must match).
expected_version() {
  python3 - "$BASE" <<'PY'
import hashlib, sys, urllib.request, urllib.error
base = sys.argv[1]
keys = ["hermes-api-key", "hermes-archive-url", "hermes-bundle-version", "hermes-config",
        "hermes-env", "hermes-mcp-tokens", "hermes-skills", "hermes-soul",
        "hermes-brain-image", "hermes-seed-url", "hermes-snapshot-url", "hermes-restore-url", "hermes-profiles", "hermes-extensions", "hermes-first-loop-url", "hermes-continuous-contexts", "hermes-continuous-url"]
lines = ""
for k in keys:
    req = urllib.request.Request(base + "/computeMetadata/v1/instance/attributes/" + k,
                                 headers={"Metadata-Flavor": "Google"})
    try:
        v = urllib.request.urlopen(req).read()
    except urllib.error.HTTPError:
        continue
    lines += "%s %s\n" % (k, hashlib.sha256(v).hexdigest())
print(hashlib.sha256(lines.encode()).hexdigest())
PY
}

API_KEY="k_$(printf 'a%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20)"
CONFIG1='model: { provider: "openrouter", default: "openai/gpt-4o-mini" }'
CONFIG2='model: { provider: "openrouter", default: "openai/gpt-4.1-mini" }'
TOKENS1='{"tokens.json":{"access_token":"at1","token_type":"Bearer","refresh_token":"rt1","expires_at":1},"client.json":{"client_id":"mcp-saleads-assistant-dev"}}'

echo "# 1. initial apply with valid metadata"
md_set hermes-api-key "$API_KEY"
md_set hermes-config "$CONFIG1"
md_set hermes-soul "Eres el asistente de ventas."
md_set hermes-env "OPENROUTER_API_KEY=sk-old
API_SERVER_KEY=must-be-ignored"
md_set hermes-mcp-tokens "$TOKENS1"
md_set hermes-skills '{"saleads/ventas/SKILL.md":"# Ventas\n"}'
md_set hermes-bundle-version "bundle-1"
md_set enable-oslogin "TRUE"   # outside the closed list: ignored
apply
check "config.yaml written" '[ "$(cat "$D/config.yaml")" = "$CONFIG1" ]'
check "SOUL.md written" 'grep -q "asistente de ventas" "$D/SOUL.md"'
check ".env has provider key" 'grep -qx "OPENROUTER_API_KEY=sk-old" "$D/.env"'
check ".env owns API_SERVER_* (metadata override dropped)" '! grep -q "must-be-ignored" "$D/.env" && grep -qx "API_SERVER_KEY=$API_KEY" "$D/.env" && grep -qx "API_SERVER_HOST=0.0.0.0" "$D/.env" && grep -qx "API_SERVER_PORT=8642" "$D/.env" && grep -qx "API_SERVER_ENABLED=true" "$D/.env"'
check "tokens.json -> mcp-tokens/saleads.json" 'grep -q "\"refresh_token\":\"rt1\"" "$D/mcp-tokens/saleads.json"'
check "client.json -> mcp-tokens/saleads.client.json" 'grep -q mcp-saleads-assistant-dev "$D/mcp-tokens/saleads.client.json"'
check "skill file written" '[ "$(cat "$D/skills/saleads/ventas/SKILL.md")" = "# Ventas" ]'
check "files are 0600" '[ "$(mode_of "$D/.env")" = 0o600 ] && [ "$(mode_of "$D/config.yaml")" = 0o600 ] && [ "$(mode_of "$D/mcp-tokens/saleads.json")" = 0o600 ] && [ "$(mode_of "$D/skills/saleads/ventas/SKILL.md")" = 0o600 ]'
check "dirs are 0700" '[ "$(mode_of "$D")" = 0o700 ] && [ "$(mode_of "$D/mcp-tokens")" = 0o700 ] && [ "$(mode_of "$D/skills/saleads")" = 0o700 ]'
check "container created once with the pinned contract" '[ "$(docker_calls run)" = 1 ] && grep -qx "nousresearch/hermes-agent@sha256:55e192fba0cd4fde61142abbff5adeacff40efdb482ccd0ff877924bd274f909" "$FAKE_DOCKER_STATE.run-args" && grep -qx -- "--restart=always" "$FAKE_DOCKER_STATE.run-args" && grep -qx "8642:8642" "$FAKE_DOCKER_STATE.run-args" && grep -qx "$D:/opt/data" "$FAKE_DOCKER_STATE.run-args" && tail -n 2 "$FAKE_DOCKER_STATE.run-args" | tr "\n" " " | grep -q "^gateway run $"'
check "container env-file has API_SERVER_* but never the AI key" 'ENVF=$(grep -A1 -x -- "--env-file" "$FAKE_DOCKER_STATE.run-args" | tail -n 1); grep -qx "API_SERVER_KEY=$API_KEY" "$ENVF" && ! grep -q OPENROUTER "$ENVF" && [ "$(mode_of "$ENVF")" = 0o600 ]'
check "no restart on first apply" '[ "$(docker_calls restart)" = 0 ]'
V1=$(guest_get applied-version)
check "ack hermes/applied-version matches reference hash" '[ "$V1" = "$(expected_version)" ]'
check "apply-status ok" '[ "$(guest_get apply-status)" = ok ]'
check "no metadata value in logs" '! grep -q -e sk-old -e "$API_KEY" -e rt1 "$WORK/watcher.log"'

echo "# 2. changing hermes-env changes the key without restarting"
md_set hermes-env "OPENROUTER_API_KEY=sk-new"
apply
check ".env has the new key and not the old one" 'grep -qx "OPENROUTER_API_KEY=sk-new" "$D/.env" && ! grep -q sk-old "$D/.env"'
check "no restart / no new run after env change" '[ "$(docker_calls restart)" = 0 ] && [ "$(docker_calls run)" = 1 ]'
V2=$(guest_get applied-version)
check "applied-version changed after setMetadata" '[ "$V2" != "$V1" ] && [ "$V2" = "$(expected_version)" ]'

echo "# 3. Hermes refresh is not clobbered when hermes-mcp-tokens did not change"
printf '{"access_token":"at-refreshed-by-hermes","refresh_token":"rt2"}' >"$D/mcp-tokens/saleads.json"
md_set hermes-soul "Eres el asistente de ventas v2."
apply
check "mcp-tokens/saleads.json keeps Hermes refresh" 'grep -q at-refreshed-by-hermes "$D/mcp-tokens/saleads.json"'
check "applied-version changed again" '[ "$(guest_get applied-version)" != "$V2" ]'
check "SOUL change does not restart" '[ "$(docker_calls restart)" = 0 ]'

echo "# 4. a new hermes-mcp-tokens value is written"
md_set hermes-mcp-tokens '{"tokens.json":{"access_token":"at3","refresh_token":"rt3"}}'
apply
check "reseeded tokens replace the file" 'grep -q "\"rt3\"" "$D/mcp-tokens/saleads.json"'

echo "# 5. config.yaml change restarts the container (once)"
md_set hermes-config "$CONFIG2"
apply
check "config.yaml updated" '[ "$(yget "$D/config.yaml" model.default)" = "openai/gpt-4.1-mini" ]'
check "exactly one restart" '[ "$(docker_calls restart)" = 1 ]'
apply
check "idempotent re-apply: no extra restart, no extra run" '[ "$(docker_calls restart)" = 1 ] && [ "$(docker_calls run)" = 1 ]'

echo "# 5b. Telegram set up by Hermes (config.yaml + .env) survives hermes-config and hermes-env changes"
python3 - "$D/config.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]
cfg = yaml.safe_load(open(p).read())
cfg["platforms"] = {"telegram": {"enabled": True, "home_channel": "x"}}
cfg["_config_version"] = 7
cfg.setdefault("mcp_servers", {})["other"] = {"url": "https://other.example/mcp"}
open(p, "w").write(yaml.safe_dump(cfg, sort_keys=False))
PY
printf 'TELEGRAM_BOT_TOKEN=tg-secret-123\nTELEGRAM_ALLOWED_USERS=42\n' >>"$D/.env"
RESTARTS_BEFORE=$(docker_calls restart)
CONFIG3='model: { provider: "openrouter", default: "openai/gpt-5-mini" }
mcp_servers:
  saleads:
    url: "https://mcp.example/mcp"
    auth: oauth
timezone: "America/Bogota"
approvals:
  mode: "off"
'
md_set hermes-config "$CONFIG3"
apply
check "platforms and _config_version kept after hermes-config change" '[ "$(yget "$D/config.yaml" platforms.telegram.enabled)" = true ] && [ "$(yget "$D/config.yaml" _config_version)" = 7 ]'
check "other MCP server kept, saleads replaced" '[ "$(yget "$D/config.yaml" mcp_servers.other.url)" = "https://other.example/mcp" ] && [ "$(yget "$D/config.yaml" mcp_servers.saleads.url)" = "https://mcp.example/mcp" ]'
check "managed keys take the metadata value" '[ "$(yget "$D/config.yaml" model.default)" = "openai/gpt-5-mini" ] && [ "$(yget "$D/config.yaml" timezone)" = America/Bogota ] && [ "$(yget "$D/config.yaml" approvals.mode)" = off ]'
check "config change restarts once" '[ "$(docker_calls restart)" = $((RESTARTS_BEFORE + 1)) ]'
check "config.yaml stays 0600" '[ "$(mode_of "$D/config.yaml")" = 0o600 ]'
check "TELEGRAM_* kept after hermes-config change" 'grep -qx "TELEGRAM_BOT_TOKEN=tg-secret-123" "$D/.env" && grep -qx "TELEGRAM_ALLOWED_USERS=42" "$D/.env"'
check "ack after merge matches reference hash" '[ "$(guest_get applied-version)" = "$(expected_version)" ]'
md_set hermes-env "OPENROUTER_API_KEY=sk-two
DEEPSEEK_API_KEY=sk-deep"
apply
check "TELEGRAM_* kept after hermes-env change" 'grep -qx "TELEGRAM_BOT_TOKEN=tg-secret-123" "$D/.env" && grep -qx "TELEGRAM_ALLOWED_USERS=42" "$D/.env"'
check "hermes-env keys replaced, one line each" '[ "$(grep -c "^OPENROUTER_API_KEY=" "$D/.env")" = 1 ] && grep -qx "OPENROUTER_API_KEY=sk-two" "$D/.env" && grep -qx "DEEPSEEK_API_KEY=sk-deep" "$D/.env" && [ "$(grep -c "^API_SERVER_KEY=" "$D/.env")" = 1 ]'
check "platforms kept after hermes-env change" '[ "$(yget "$D/config.yaml" platforms.telegram.enabled)" = true ]'
md_set hermes-env "OPENROUTER_API_KEY=sk-three"
apply
check "a key no longer managed is removed" '! grep -q "^DEEPSEEK_API_KEY=" "$D/.env" && grep -qx "OPENROUTER_API_KEY=sk-three" "$D/.env" && ! grep -q sk-two "$D/.env"'
check "TELEGRAM_* still kept" 'grep -qx "TELEGRAM_BOT_TOKEN=tg-secret-123" "$D/.env"'
check "container env-file still only API_SERVER_*" '! grep -q -v "^API_SERVER_" "$HERMES_STATE_DIR/container.env"'
CONFIG4='model: { provider: "openrouter", default: "openai/gpt-5-mini" }
mcp_servers:
  saleads:
    url: "https://mcp.example/mcp"
    auth: oauth
'
md_set hermes-config "$CONFIG4"
apply
check "a config key no longer managed is removed" '[ "$(yget "$D/config.yaml" timezone)" = "<absent>" ] && [ "$(yget "$D/config.yaml" approvals)" = "<absent>" ]'
check "platforms still kept" '[ "$(yget "$D/config.yaml" platforms.telegram.enabled)" = true ] && [ "$(yget "$D/config.yaml" mcp_servers.other.url)" = "https://other.example/mcp" ]'
echo "# 5c. ORQA (OSB-009): brain MCP and skills.write_approval are managed leaves; other skills keys survive"
python3 - "$D/config.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]
cfg = yaml.safe_load(open(p).read())
cfg["skills"] = {"external_dirs": ["/opt/data/extra"]}
open(p, "w").write(yaml.safe_dump(cfg, sort_keys=False))
PY
CONFIG5="$CONFIG4"'  saleads-brain:
    url: "http://saleads-brain:8765/mcp"
skills:
  write_approval: true
tools:
  tool_search:
    enabled: "off"
'
md_set hermes-config "$CONFIG5"
apply
check "brain MCP and write_approval applied" '[ "$(yget "$D/config.yaml" mcp_servers.saleads-brain.url)" = "http://saleads-brain:8765/mcp" ] && [ "$(yget "$D/config.yaml" skills.write_approval)" = true ]'
check "tool_search stays the string off (not a boolean)" '[ "$(yget "$D/config.yaml" tools.tool_search.enabled)" = off ]'
check "other skills keys and MCP servers kept" 'yget "$D/config.yaml" skills.external_dirs | grep -q /opt/data/extra && [ "$(yget "$D/config.yaml" mcp_servers.other.url)" = "https://other.example/mcp" ]'
md_set hermes-config "$CONFIG4"
apply
check "brain MCP and write_approval removed when no longer managed" '[ "$(yget "$D/config.yaml" mcp_servers.saleads-brain)" = "<absent>" ] && [ "$(yget "$D/config.yaml" skills.write_approval)" = "<absent>" ] && [ "$(yget "$D/config.yaml" tools.tool_search)" = "<absent>" ] && yget "$D/config.yaml" skills.external_dirs | grep -q /opt/data/extra'
printf 'platforms: [unclosed\n  : : :\n' >"$D/config.yaml"
md_set hermes-config "$CONFIG3"
apply
check "invalid existing config.yaml is replaced by the metadata value" '[ "$(cat "$D/config.yaml")" = "$(printf "%s" "$CONFIG3")" ]'
check "replacement is logged" 'grep -q "existing config.yaml was not valid YAML" "$WORK/watcher.log"'
check "no Telegram token or AI key in logs" '! grep -q -e tg-secret-123 -e sk-three -e sk-deep "$WORK/watcher.log"'
VCFG=$(guest_get applied-version)
md_set hermes-config "::: [not yaml"
if apply; then ko "invalid hermes-config must fail the apply"; else ok "invalid hermes-config fails the apply"; fi
check "invalid hermes-config: file and ack untouched" '[ "$(cat "$D/config.yaml")" = "$(printf "%s" "$CONFIG3")" ] && [ "$(guest_get applied-version)" = "$VCFG" ] && [ "$(guest_get apply-status)" = error ]'
md_set hermes-config "$CONFIG3"
apply

echo "# 6. invalid skills are rejected and the ack is not published"
VBEFORE=$(guest_get applied-version)
md_set hermes-skills '{"../escape.md":"x"}'
if apply; then ko "invalid skills must fail the apply"; else ok "invalid skills fail the apply"; fi
check "no file outside skills/" '[ ! -e "$HERMES_DATA_DIR/escape.md" ] && [ ! -e "$HERMES_ROOT/escape.md" ]'
check "ack unchanged and apply-status error" '[ "$(guest_get applied-version)" = "$VBEFORE" ] && [ "$(guest_get apply-status)" = error ]'
SKILLS_TGZ_DIR="$WORK/skills-src"; mkdir -p "$SKILLS_TGZ_DIR/saleads/cierre"
printf '# Cierre\n' >"$SKILLS_TGZ_DIR/saleads/cierre/SKILL.md"
tar -czf "$WORK/skills.tgz" -C "$SKILLS_TGZ_DIR" saleads
base64 <"$WORK/skills.tgz" | tr -d '\n' >"$WORK/skills.b64"
mkdir -p "$D/skills/agente/propia" && printf '# Del agente\n' >"$D/skills/agente/propia/SKILL.md"
md_set_file hermes-skills "$WORK/skills.b64"
apply
check "base64 tar.gz skills accepted" '[ "$(cat "$D/skills/saleads/cierre/SKILL.md")" = "# Cierre" ]'
check "a managed skill SaleADS no longer sends is removed (OSB-005)" '[ ! -f "$D/skills/saleads/ventas/SKILL.md" ]'
check "a skill created by the agent is never touched (OSB-005)" '[ "$(cat "$D/skills/agente/propia/SKILL.md")" = "# Del agente" ]'

echo "# 7. restart of the VM: data survives and the container is started again"
echo false >"$FAKE_DOCKER_STATE"
apply
check "stopped container is started, not recreated" '[ "$(docker_calls start)" -ge 1 ] && [ "$(docker_calls run)" = 1 ]'

echo "# 8. archive on delete: memories/sessions uploaded, secrets excluded"
mkdir -p "$D/memories" "$D/sessions"
printf 'recuerdo' >"$D/memories/MEMORY.md"
printf 'sqlite' >"$D/state.db"
printf 's' >"$D/sessions/s1.json"
md_set hermes-archive-url "$BASE/upload/memories/user.tar.gz?X-Goog-Signature=secret"
apply
check "upload Content-Type application/gzip" '[ "$(curl -sS "$BASE/_ctl/upload-type")" = application/gzip ]'
curl -sS "$BASE/_ctl/upload" >"$WORK/uploaded.tgz"
tar -tzf "$WORK/uploaded.tgz" | sort >"$WORK/uploaded.list"
check "archive has memories, sessions and state.db" 'grep -q "memories/MEMORY.md" "$WORK/uploaded.list" && grep -q "sessions/s1.json" "$WORK/uploaded.list" && grep -qx "state.db" "$WORK/uploaded.list"'
check "archive excludes .env and mcp-tokens" '! grep -v -x saleads/channels.env "$WORK/uploaded.list" | grep -q -e "\.env" -e mcp-tokens -e config.yaml'
check "archive carries the channel lines of .env, never the AI key nor API_SERVER_*" 'tar -xzOf "$WORK/uploaded.tgz" saleads/channels.env | grep -qx "TELEGRAM_BOT_TOKEN=tg-secret-123" && ! tar -xzOf "$WORK/uploaded.tgz" saleads/channels.env | grep -q -e OPENROUTER -e API_SERVER_'
check "archive-status uploaded" 'guest_get archive-status | grep -q "^uploaded:"'
check "signed URL never logged" '! grep -q X-Goog-Signature "$WORK/watcher.log"'
check "container running again after archive" '[ "$(cat "$FAKE_DOCKER_STATE")" = true ]'
UPLOADS_BEFORE=$(docker_calls stop)
apply
check "archive not repeated for the same URL" '[ "$(docker_calls stop)" = "$UPLOADS_BEFORE" ]'

echo "# 9. watch loop reacts to a metadata change (wait_for_change + ETag)"
export HERMES_WAIT_TIMEOUT_SEC=3 HERMES_WATCH_MAX_ITER=2
( sleep 1; md_set hermes-env "OPENROUTER_API_KEY=sk-watch" ) &
CHANGER_PID=$!
bash "$SCRIPT" watch 2>>"$WORK/watcher.log"
wait "$CHANGER_PID"
check "watch applied the change" 'grep -qx "OPENROUTER_API_KEY=sk-watch" "$D/.env"'
check "watch ack matches reference hash" '[ "$(guest_get applied-version)" = "$(expected_version)" ]'
unset HERMES_WAIT_TIMEOUT_SEC HERMES_WATCH_MAX_ITER

echo "# 11. brain (OSB-005): private image, falkordb, network, seed, jobs and snapshot"
BRAIN_IMG="us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain@sha256:$(printf 'b%.0s' $(seq 1 64))"
export HERMES_DOCKER_CRED="true"
md_set hermes-api-key "$API_KEY"
md_set hermes-env "OPENROUTER_API_KEY=sk-brain"
printf 'TELEGRAM_BOT_TOKEN=tg-secret\n' >>"$D/.env"
md_set hermes-brain-image "docker.io/someone/brain:latest"
if apply; then ko "a non-pinned brain image must fail the apply"; else ok "a non-pinned brain image fails the apply"; fi
md_set hermes-brain-image "$BRAIN_IMG"
apply
check "network hermes-net created" '[ -f "$FAKE_DOCKER_STATE.network" ]'
check "falkordb runs on hermes-net with a memory limit and no published port" 'grep -qx hermes-net "$FAKE_DOCKER_STATE.run-args.falkordb" && grep -qx 768m "$FAKE_DOCKER_STATE.run-args.falkordb" && ! grep -qx -- -p "$FAKE_DOCKER_STATE.run-args.falkordb"'
check "brain image pulled by digest from the private registry" 'grep -qx "$BRAIN_IMG" "$FAKE_DOCKER_STATE.pulls"'
check "brain runs on hermes-net without published ports" 'grep -qx hermes-net "$FAKE_DOCKER_STATE.run-args.saleads-brain" && ! grep -qx -- -p "$FAKE_DOCKER_STATE.run-args.saleads-brain"'
check "brain env has the AI key but never API_SERVER_* nor TELEGRAM_*" 'grep -qx "OPENROUTER_API_KEY=sk-brain" "$HERMES_STATE_DIR/brain.env" && ! grep -q -e API_SERVER_ -e TELEGRAM_ "$HERMES_STATE_DIR/brain.env" && [ "$(mode_of "$HERMES_STATE_DIR/brain.env")" = 0o600 ]'
check "hermes joined hermes-net without being recreated" 'grep -qx hermes "$FAKE_DOCKER_STATE.connected" && [ "$(docker_calls run | tr -d " ")" -ge 1 ] && grep -q "^network connect" "$FAKE_DOCKER_LOG"'
check "five no-agent brain jobs created" '[ "$(grep -c "saleads:brain-" "$FAKE_DOCKER_STATE.cron")" = 5 ] && [ -x "$D/scripts/saleads/brain_ingest-day.py" ]'
RUNS=$(grep -c "^run " "$FAKE_DOCKER_LOG"); CREATES=$(grep -c "saleads:brain-" "$FAKE_DOCKER_STATE.cron")
apply
check "second apply recreates nothing and duplicates no job" '[ "$(grep -c "^run " "$FAKE_DOCKER_LOG")" = "$RUNS" ] && [ "$(grep -c "saleads:brain-" "$FAKE_DOCKER_STATE.cron")" = "$CREATES" ]'
curl -sS -f -X POST --data-binary '{"businesses":[]}' "$BASE/_ctl/download" >/dev/null
md_set hermes-seed-url "$BASE/download/seeds/u1.json?X-Goog-Signature=seed-secret"
apply
check "seed downloaded and loaded by the brain" '[ "$(cat "$D/saleads/seed/seed.json")" = "{\"businesses\":[]}" ] && [ -s "$FAKE_DOCKER_STATE.ingested" ] && guest_get seed-status | grep -q "^loaded:"'
apply
check "the same seed is not loaded twice" '[ "$(wc -l <"$FAKE_DOCKER_STATE.ingested" | tr -d " ")" = 1 ]'
BRAIN_IMG2="us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain@sha256:$(printf 'c%.0s' $(seq 1 64))"
curl -sS -f -X POST --data-binary '{"businesses":["changed"]}' "$BASE/_ctl/download" >/dev/null
md_set hermes-brain-image "$BRAIN_IMG2"
apply
check "a new brain image re-applies the local seed without downloading it again" '[ "$(wc -l <"$FAKE_DOCKER_STATE.ingested" | tr -d " ")" = 2 ] && [ "$(cat "$D/saleads/seed/seed.json")" = "{\"businesses\":[]}" ]'
apply
check "the re-applied seed is not loaded a third time" '[ "$(wc -l <"$FAKE_DOCKER_STATE.ingested" | tr -d " ")" = 2 ]'
mkdir -p "$D/saleads/graph" && printf 'gz1' >"$D/saleads/graph/snapshot.json.gz"
md_set hermes-snapshot-url "$BASE/upload/snapshots/u1.json.gz?X-Goog-Signature=snap-secret"
apply
N1=$(curl -sS "$BASE/_ctl/upload-count")
apply
check "snapshot uploaded once while it does not change" '[ "$(curl -sS "$BASE/_ctl/upload-count")" = "$N1" ] && guest_get graph-snapshot | grep -q .'
printf 'gz2' >"$D/saleads/graph/snapshot.json.gz"
apply
check "a changed snapshot is uploaded again" '[ "$(curl -sS "$BASE/_ctl/upload-count")" -gt "$N1" ] && guest_get snapshot-status | grep -q "^uploaded:"'
check "ack includes the brain keys in the fixed order" '[ "$(guest_get applied-version)" = "$(expected_version)" ]'
check "no seed/snapshot URL or secret in logs" '! grep -q -e seed-secret -e snap-secret -e tg-secret -e sk-brain "$WORK/watcher.log"'

echo "# 10. without hermes-api-key Hermes is not started"
md_del hermes-api-key
md_del hermes-brain-image
rm -f "$FAKE_DOCKER_STATE" "$D/.env"
rm -f "$HERMES_STATE_DIR/env.sha"
RUNS_BEFORE=$(docker_calls run)
apply
check "no container without api key" '[ "$(docker_calls run)" = "$RUNS_BEFORE" ] && [ ! -f "$D/.env" ]'

echo "# 12. restore on a new VM (D50): once, before Hermes starts, never over existing data"
# A new VM: empty disk and no container. Same metadata server.
new_vm() {
  export HERMES_ROOT="$WORK/$1" HERMES_DATA_DIR="$WORK/$1/data" HERMES_STATE_DIR="$WORK/$1/state"
  export FAKE_DOCKER_STATE="$WORK/$1.docker"
  D="$HERMES_DATA_DIR"
}
download_count() { curl -sS "$BASE/_ctl/download-count"; }
md_set hermes-api-key "$API_KEY"
md_set hermes-env "OPENROUTER_API_KEY=sk-restore"
md_del hermes-archive-url; md_del hermes-seed-url; md_del hermes-snapshot-url
# The archive of the old VM, with what must and must not come back.
python3 - "$WORK/restore.tgz" <<'PY'
import io, sys, tarfile
files = {
    "memories/MEMORY.md": b"recuerdo del negocio", "memories/USER.md": b"perfil del dueno",
    "sessions/s1.json": b"{}", "state.db": b"db", "state.db-wal": b"wal",
    "kanban.db": b"kdb", "kanban/workspaces/t1/notes.md": b"tarea",
    "profiles/analista/memories/MEMORY.md": b"memoria analista", "profiles/analista/state.db": b"pdb",
    "profiles/analista/.env": b"OPENROUTER_API_KEY=sk-archived-profile",
    "profiles/sin-db/memories/MEMORY.md": b"sin identidad",
    "saleads/channels.env": b"TELEGRAM_BOT_TOKEN=tg-restored\nTELEGRAM_ALLOWED_USERS=7\nOPENROUTER_API_KEY=sk-sneaky\n",
    "saleads/platforms.json": b'{"telegram": {"home_channel": {"platform": "telegram", "chat_id": "7"}}}',
    "platforms/whatsapp/session/creds.json": b'{"me": {"id": "573000000000:1@s.whatsapp.net"}}',
    ".env": b"OPENROUTER_API_KEY=sk-archived", "auth.json": b"{\"t\":\"archived\"}",
    "mcp-tokens/saleads.json": b"{\"refresh_token\":\"rt-archived\"}", "memories/.env": b"x",
    "config.yaml": b"model: archived", "SOUL.md": b"alma vieja", "skills/x/SKILL.md": b"vieja",
    "../escape.md": b"x", "/abs.md": b"x",
}
with tarfile.open(sys.argv[1], "w:gz") as t:
    for name, body in files.items():
        info = tarfile.TarInfo(name); info.size = len(body); t.addfile(info, io.BytesIO(body))
    link = tarfile.TarInfo("memories/link.md"); link.type = tarfile.SYMTYPE; link.linkname = "/etc/passwd"; t.addfile(link)
PY
curl -sS -f -X POST --data-binary "@$WORK/restore.tgz" "$BASE/_ctl/download" >/dev/null
curl -sS -f -X POST --data-binary 200 "$BASE/_ctl/download-code" >/dev/null
md_set hermes-restore-url "$BASE/download/memories/u1/20261019T000000Z.tgz?X-Goog-Signature=restore-secret"
new_vm vm2
mkdir -p "$D/memories" && printf 'nuevo en esta VM' >"$D/memories/MEMORY.md"
: >"$FAKE_DOCKER_LOG"; : >"$WORK/watcher.log"
apply
check "memories, sessions, state.db and its wal come back" '[ "$(cat "$D/memories/USER.md")" = "perfil del dueno" ] && [ -f "$D/sessions/s1.json" ] && [ "$(cat "$D/state.db")" = db ] && [ "$(cat "$D/state.db-wal")" = wal ]'
check "kanban.db and kanban/ come back" '[ "$(cat "$D/kanban.db")" = kdb ] && [ "$(cat "$D/kanban/workspaces/t1/notes.md")" = tarea ]'
check "a profile with state.db comes back" '[ "$(cat "$D/profiles/analista/memories/MEMORY.md")" = "memoria analista" ] && [ "$(cat "$D/profiles/analista/state.db")" = pdb ]'
check "a profile without state.db is not created (no marker-less dir)" '[ ! -e "$D/profiles/sin-db" ]'
check "existing data wins over the archive" '[ "$(cat "$D/memories/MEMORY.md")" = "nuevo en esta VM" ]'
check "never restored: .env, auth.json, mcp-tokens, config, SOUL, skills" '! grep -rq -e sk-archived -e rt-archived -e archived "$D" && [ ! -e "$D/auth.json" ] && [ ! -e "$D/profiles/analista/.env" ] && [ ! -e "$D/memories/.env" ] && [ ! -e "$D/skills/x" ] && ! grep -q "model: archived" "$D/config.yaml" && grep -q "asistente de ventas" "$D/SOUL.md"'
check "no link, no path outside the data dir" '[ ! -e "$D/memories/link.md" ] && [ ! -e "$WORK/vm2/escape.md" ] && [ ! -e "$D/abs.md" ]'
check "restored files are 0600 and dirs 0700" '[ "$(mode_of "$D/state.db")" = 0o600 ] && [ "$(mode_of "$D/kanban/workspaces/t1/notes.md")" = 0o600 ] && [ "$(mode_of "$D/kanban/workspaces")" = 0o700 ] && [ "$(mode_of "$D/profiles/analista")" = 0o700 ]'
check "restore-status counts restored and kept files" '[ "$(guest_get restore-status)" = "restored:11:kept:1" ]'
check "the channel comes back: TELEGRAM_* in .env, platforms in config.yaml" 'grep -qx "TELEGRAM_BOT_TOKEN=tg-restored" "$D/.env" && grep -qx "TELEGRAM_ALLOWED_USERS=7" "$D/.env" && grep -q "\"home_channel\"" "$D/config.yaml"'
check "the WhatsApp session linked by QR comes back" '[ -f "$D/platforms/whatsapp/session/creds.json" ] && [ "$(mode_of "$D/platforms/whatsapp/session/creds.json")" = 0o600 ]'
check "only channel lines come back from the archive (never another key)" '! grep -q sk-sneaky "$D/.env" && grep -qx "OPENROUTER_API_KEY=sk-restore" "$D/.env"'
check "metadata keys still managed after the channel restore" 'grep -q "\"model\"" "$D/config.yaml" || grep -q "model" "$D/config.yaml"'
check "restored before Hermes was created" '[ "$(docker_calls run)" = 1 ] && [ "$(grep -n "restore restored" "$WORK/watcher.log" | cut -d: -f1)" -lt "$(grep -n "created container" "$WORK/watcher.log" | cut -d: -f1)" ]'
check "ack includes hermes-restore-url" '[ "$(guest_get applied-version)" = "$(expected_version)" ]'
N=$(download_count)
rm -f "$D/memories/USER.md"
apply
check "restore runs once per VM" '[ "$(download_count)" = "$N" ] && [ ! -e "$D/memories/USER.md" ]'
check "restore URL and archived secrets never logged" '! grep -q -e restore-secret -e X-Goog-Signature -e sk-archived -e rt-archived "$WORK/watcher.log"'

echo "# 12a. a channel connected by chat never restarts Hermes (it picks it up hot)"
R0=$(docker_calls restart)
printf 'TELEGRAM_HOME_CHANNEL=7\n' >>"$D/.env"
apply
check "no restart when the channel lines change" '[ "$(docker_calls restart)" = "$R0" ]'

echo "# 12b. transient download error: Hermes waits, then starts without the archive"
export HERMES_RESTORE_TRIES=2
curl -sS -f -X POST --data-binary 503 "$BASE/_ctl/download-code" >/dev/null
new_vm vm3
: >"$FAKE_DOCKER_LOG"
if apply; then ko "a transient restore error must fail the apply"; else ok "a transient restore error fails the apply (no ack)"; fi
check "Hermes not started while the restore is retried" '[ "$(docker_calls run)" = 0 ] && [ "$(guest_get restore-status)" = retry:503 ]'
apply
check "after the last try Hermes starts without the archive" '[ "$(docker_calls run)" = 1 ] && [ "$(guest_get restore-status)" = failed:503 ] && [ ! -e "$D/state.db" ]'
unset HERMES_RESTORE_TRIES

echo "# 12c. expired URL, invalid archive and an existing Hermes"
curl -sS -f -X POST --data-binary 403 "$BASE/_ctl/download-code" >/dev/null
new_vm vm4; : >"$FAKE_DOCKER_LOG"
apply
check "an expired URL (403) is final and Hermes starts" '[ "$(guest_get restore-status)" = failed:403 ] && [ "$(docker_calls run)" = 1 ]'
curl -sS -f -X POST --data-binary 200 "$BASE/_ctl/download-code" >/dev/null
curl -sS -f -X POST --data-binary "not a tar" "$BASE/_ctl/download" >/dev/null
new_vm vm5; : >"$FAKE_DOCKER_LOG"
apply
check "an invalid archive is final and Hermes starts" '[ "$(guest_get restore-status)" = failed:invalid ] && [ "$(docker_calls run)" = 1 ]'
curl -sS -f -X POST --data-binary "@$WORK/restore.tgz" "$BASE/_ctl/download" >/dev/null
new_vm vm6; echo true >"$FAKE_DOCKER_STATE"; : >"$FAKE_DOCKER_LOG"
N=$(download_count)
apply
check "with Hermes already created the archive is never applied" '[ "$(guest_get restore-status)" = skipped:hermes_exists ] && [ "$(download_count)" = "$N" ] && [ ! -e "$D/state.db" ]'
md_del hermes-restore-url

echo "# 13. specialist profiles (MLB-005a): created once inside Hermes, their own files and state"
new_vm vm7; : >"$FAKE_DOCKER_LOG"; : >"$WORK/watcher.log"
md_set hermes-api-key "$API_KEY"
md_set hermes-config 'model: { provider: "openrouter", default: "deepseek/deepseek-chat-v3.1" }
mcp_servers: { saleads: { url: "https://dev.saleads.ai/mcp" }, saleads-brain: { url: "http://saleads-brain:8765/mcp" } }
kanban: { max_in_progress: 2, auto_decompose: false, review_dispatch: false, auto_subscribe_on_create: true }'
md_set hermes-env 'OPENROUTER_API_KEY=sk-team
TELEGRAM_BOT_TOKEN=tg-secret
export WHATSAPP_TOKEN=wa-secret
API_SERVER_KEY=never'
md_set hermes-mcp-tokens "$TOKENS1"
profiles_value() { # NAME:SKILL ... -> base64 tar.gz of hermes-profiles
  python3 - "$@" <<'PY'
import base64, io, sys, tarfile
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as t:
    for spec in sys.argv[1:]:
        name, skill = spec.split(":")
        files = {"SOUL.md": "Eres el %s del equipo." % name,
                 "profile-config.yaml": "mcp_servers:\n  saleads-brain:\n    tools:\n      exclude: [brain_record_learning]\n"}
        if skill: files["skills/%s/SKILL.md" % skill] = "# %s\n" % skill
        for path, body in files.items():
            data = body.encode(); info = tarfile.TarInfo("profiles/%s/%s" % (name, path)); info.size = len(data)
            t.addfile(info, io.BytesIO(data))
print(base64.b64encode(buf.getvalue()).decode())
PY
}
md_set hermes-profiles "$(profiles_value investigador:saleads-market-research analista:saleads-reading-diagnosis)"
apply
check "both profiles created inside Hermes, once each" '[ "$(sort "$FAKE_DOCKER_STATE.profiles" | tr "\n" " ")" = "analista investigador " ]'
check "profile config = hermes-config + its layer, without the root kanban keys" '[ "$(yget "$D/profiles/analista/config.yaml" model.default)" = deepseek/deepseek-chat-v3.1 ] && [ "$(yget "$D/profiles/analista/config.yaml" mcp_servers.saleads-brain.tools.exclude)" = "[\"brain_record_learning\"]" ] && [ "$(yget "$D/profiles/analista/config.yaml" mcp_servers.saleads-brain.url)" = http://saleads-brain:8765/mcp ] && [ "$(yget "$D/profiles/analista/config.yaml" kanban)" = "<absent>" ]'
check "root config keeps the managed kanban keys" '[ "$(yget "$D/config.yaml" kanban.max_in_progress)" = 2 ] && [ "$(yget "$D/config.yaml" kanban.auto_decompose)" = False -o "$(yget "$D/config.yaml" kanban.auto_decompose)" = false ]'
check "specialist SOUL and skills written" 'grep -q "analista del equipo" "$D/profiles/analista/SOUL.md" && [ -f "$D/profiles/investigador/skills/saleads-market-research/SKILL.md" ]'
check "no specialist .env carries TELEGRAM_, API_SERVER_ or WHATSAPP_" 'grep -qx OPENROUTER_API_KEY=sk-team "$D/profiles/analista/.env" && ! grep -q -e TELEGRAM_ -e API_SERVER_ -e WHATSAPP_ "$D/profiles/analista/.env" "$D/profiles/investigador/.env"'
check "each profile has its own copy of the OAuth tokens" 'grep -q "\"refresh_token\":\"rt1\"" "$D/profiles/analista/mcp-tokens/saleads.json" && grep -q "\"refresh_token\":\"rt1\"" "$D/profiles/investigador/mcp-tokens/saleads.json"'
check "kanban enabled on the root for api_server, cron, telegram and whatsapp, once, with one restart" '[ "$(tr "\n" " " <"$FAKE_DOCKER_STATE.toolsets")" = "api_server cron telegram whatsapp " ] && [ "$(docker_calls restart)" = 1 ]'
TOKEN=$(printf 'saleads-brain-ale:%s' "$API_KEY" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
check "Ale config sends the brain token; no specialist config does" '[ "$(yget "$D/config.yaml" mcp_servers.saleads-brain.headers.x-saleads-brain-token)" = "$TOKEN" ] && ! grep -q -e headers -e "$TOKEN" "$D/profiles/analista/config.yaml" "$D/profiles/investigador/config.yaml"'
check "the brain gets the same token (state for its env), never in logs" '[ "$(cat "$HERMES_STATE_DIR/brain-token")" = "$TOKEN" ] && ! grep -q "$TOKEN" "$WORK/watcher.log"'
check "watcher-version published" '[ "$(guest_get watcher-version)" = 11 ]'
check "ack includes hermes-profiles" '[ "$(guest_get applied-version)" = "$(expected_version)" ]'
check "no secret in logs" '! grep -q -e sk-team -e tg-secret -e wa-secret "$WORK/watcher.log"'
RESTARTS=$(docker_calls restart)
apply
check "a second apply neither recreates profiles nor restarts Hermes" '[ "$(wc -l <"$FAKE_DOCKER_STATE.profiles" | tr -d " ")" = 2 ] && [ "$(docker_calls restart)" = "$RESTARTS" ] && [ "$(wc -l <"$FAKE_DOCKER_STATE.toolsets" | tr -d " ")" = 4 ]'

echo "# 13b. a new profile gets the tokens without a token change; skills prune per profile"
printf 'mine' >"$D/profiles/analista/skills/agent-made.md"
md_set hermes-profiles "$(profiles_value investigador: analista:saleads-reading-diagnosis estratega:saleads-type-infoproduct)"
apply
check "a profile created later receives its token copy" 'grep -q "\"refresh_token\":\"rt1\"" "$D/profiles/estratega/mcp-tokens/saleads.json"'
check "dropping a skill of one profile keeps the others and the agent-made files" '[ ! -e "$D/profiles/investigador/skills/saleads-market-research/SKILL.md" ] && [ -f "$D/profiles/analista/skills/saleads-reading-diagnosis/SKILL.md" ] && [ -f "$D/profiles/estratega/skills/saleads-type-infoproduct/SKILL.md" ] && [ -f "$D/profiles/analista/skills/agent-made.md" ]'

echo "# 13c. an existing profile (SOUL.md) is never created again; Hermes off = no ack"
mkdir -p "$D/profiles/optimizador"; printf 'alma' >"$D/profiles/optimizador/SOUL.md"
md_set hermes-profiles "$(profiles_value optimizador:)"
apply
check "no profile create for a directory with an identity file" '! grep -qx optimizador "$FAKE_DOCKER_STATE.profiles" && grep -q "optimizador del equipo" "$D/profiles/optimizador/SOUL.md"'
md_set hermes-profiles "$(profiles_value optimizador:saleads-optimization-scaling)"
ACK=$(guest_get applied-version)
# Hermes stopped and a start that does not stick (docker start returns but it stays off).
echo false >"$FAKE_DOCKER_STATE"
printf '#!/bin/bash\n[ "$1" = start ] && { echo "start ${2:-}" >>"$FAKE_DOCKER_LOG"; exit 0; }\nexec "%s" "$@"\n' "$HERE/fake-docker.sh" >"$WORK/docker-nostart.sh"
chmod +x "$WORK/docker-nostart.sh"
if HERMES_DOCKER="$WORK/docker-nostart.sh" apply; then ko "with Hermes off hermes-profiles must not ack"; else ok "with Hermes off hermes-profiles fails the apply"; fi
check "no ack while Hermes is off" '[ "$(guest_get applied-version)" = "$ACK" ]'

echo "# 13d. archive keeps every profile memory and the board, never their secrets"
echo true >"$FAKE_DOCKER_STATE"
mkdir -p "$D/profiles/analista/memories" "$D/kanban"
printf 'm' >"$D/profiles/analista/memories/MEMORY.md"; printf 'db' >"$D/profiles/analista/state.db"
printf 'k' >"$D/kanban.db"; printf 'n' >"$D/kanban/board.md"
md_set hermes-archive-url "$BASE/upload/memories/user2.tar.gz?X-Goog-Signature=secret"
apply
curl -sS "$BASE/_ctl/upload" >"$WORK/uploaded2.tgz"
tar -tzf "$WORK/uploaded2.tgz" | sort >"$WORK/uploaded2.list"
check "archive has profiles/<n>/memories, its state.db, kanban.db and kanban/" 'grep -qx "profiles/analista/memories/MEMORY.md" "$WORK/uploaded2.list" && grep -qx "profiles/analista/state.db" "$WORK/uploaded2.list" && grep -qx kanban.db "$WORK/uploaded2.list" && grep -q "^kanban/board.md" "$WORK/uploaded2.list"'
check "archive never carries a profile .env, tokens, config or skills" '! grep -v -x saleads/channels.env "$WORK/uploaded2.list" | grep -q -e "\.env" -e mcp-tokens -e config.yaml -e skills/ -e SOUL.md'
md_del hermes-archive-url; md_del hermes-profiles

echo "# 14. managed Meta replaces inference routes while preserving owner task settings"
cat >"$WORK/meta-config-check.py" <<'PY'
import json, sys
import yaml

TASKS = ("compression", "vision", "approval", "skills_hub", "mcp", "title_generation",
         "background_review", "curator", "review", "triage_specifier", "memory_query_rewrite", "metadata_owned_task")
cfg = yaml.safe_load(open(sys.argv[2]).read())
if sys.argv[1] in ("metadata", "explicit_metadata"):
    cfg["model"] = {"provider": "meta-ai", "default": "muse-spark-1.3-contributor",
                    "base_url": "https://api.meta.ai/v1", "api_key": "", "api_mode": "codex_responses"}
    cfg["fallback_providers"] = []
    cfg["fallback_model"] = ""
    cfg["auxiliary"] = {task: {"provider": "meta-ai", "model": "muse-spark-1.3-contributor",
                               "base_url": "", "api_key": "", "fallback_chain": []} for task in TASKS}
    cfg["delegation"] = {"provider": "meta-ai", "model": "muse-spark-1.3-contributor",
                         "base_url": "", "fallback_providers": []}
    if sys.argv[1] == "explicit_metadata":
        for task in TASKS:
            cfg["auxiliary"][task].update(key_env="MODEL_API_KEY", api_key_env="MODEL_API_KEY", api_mode="codex_responses")
        cfg["delegation"].update(api_key="", key_env="MODEL_API_KEY", api_key_env="MODEL_API_KEY", api_mode="codex_responses")
    print(json.dumps(cfg))
elif sys.argv[1] == "owner":
    cfg["fallback_providers"] = [{"provider": "anthropic", "model": "owner-fallback"}]
    cfg["fallback_model"] = "owner-fallback"
    cfg["auxiliary"] = {task: {"provider": "openrouter", "model": "owner-model", "base_url": "https://owner.invalid/v1",
                               "api_key": "synthetic-owner-auxiliary", "fallback_chain": [{"provider": "gemini"}],
                               "key_env": "OWNER_WRONG_KEY", "api_key_env": "OWNER_OTHER_KEY", "api_mode": "chat_completions",
                               "enabled": False, "max_concurrency": 3} for task in TASKS}
    cfg["auxiliary"]["personal_task"] = {"provider": "owner-only", "enabled": True, "key_env": "CUSTOM_OWNER_KEY"}
    cfg["delegation"] = {"provider": "openrouter", "model": "owner-model", "base_url": "https://owner.invalid/v1",
                         "fallback_providers": [{"provider": "gemini"}], "enabled": False, "max_concurrency": 2,
                         "api_key": "synthetic-owner-delegation", "key_env": "OWNER_WRONG_KEY",
                         "api_key_env": "OWNER_OTHER_KEY", "api_mode": "chat_completions",
                         "owner_setting": "keep"}
    open(sys.argv[2], "w").write(json.dumps(cfg))
elif sys.argv[1] == "assert":
    assert cfg["model"]["provider"] == "meta-ai"
    assert cfg["fallback_providers"] == [] and cfg["fallback_model"] == ""
    for task in TASKS:
        actual = cfg["auxiliary"][task]
        assert {key: actual[key] for key in ("provider", "model", "base_url", "api_key", "fallback_chain")} == {
            "provider": "meta-ai", "model": "muse-spark-1.3-contributor", "base_url": "", "api_key": "", "fallback_chain": []}, task
        if sys.argv[3:] != ["fresh"]:
            assert actual["enabled"] is False and actual["max_concurrency"] == 3, task
        selectors = {key: actual[key] for key in ("key_env", "api_key_env", "api_mode") if key in actual}
        assert selectors == ({"key_env": "MODEL_API_KEY", "api_key_env": "MODEL_API_KEY", "api_mode": "codex_responses"}
                             if sys.argv[3:] == ["explicit"] else {}), task
    assert {key: cfg["delegation"][key] for key in ("provider", "model", "base_url", "fallback_providers")} == {
        "provider": "meta-ai", "model": "muse-spark-1.3-contributor", "base_url": "", "fallback_providers": []}
    if sys.argv[3:] != ["fresh"]:
        assert cfg["auxiliary"]["personal_task"] == {"provider": "owner-only", "enabled": True, "key_env": "CUSTOM_OWNER_KEY"}
        assert cfg["delegation"]["enabled"] is False and cfg["delegation"]["max_concurrency"] == 2
        assert cfg["delegation"]["owner_setting"] == "keep"
    selectors = {key: cfg["delegation"][key] for key in ("api_key", "key_env", "api_key_env", "api_mode") if key in cfg["delegation"]}
    assert selectors == ({"api_key": "", "key_env": "MODEL_API_KEY", "api_key_env": "MODEL_API_KEY", "api_mode": "codex_responses"}
                         if sys.argv[3:] == ["explicit"] else {})
elif sys.argv[1] == "inference":
    print(json.dumps({key: cfg[key] for key in ("fallback_providers", "fallback_model", "auxiliary", "delegation")}, sort_keys=True))
PY
python3 "$WORK/meta-config-check.py" owner "$D/config.yaml"
META_CONFIG=$(python3 "$WORK/meta-config-check.py" metadata "$D/config.yaml")
META_RESTARTS=$(docker_calls restart)
md_set hermes-config "$META_CONFIG"
apply
check "Meta pins every auxiliary/delegation inference field and keeps personal settings" 'python3 "$WORK/meta-config-check.py" assert "$D/config.yaml"'
check "Meta config stays private, restarts once and acknowledges the applied metadata" '[ "$(mode_of "$D/config.yaml")" = 0o600 ] && [ "$(docker_calls restart)" = $((META_RESTARTS + 1)) ] && [ "$(guest_get applied-version)" = "$(expected_version)" ]'
apply
check "identical Meta metadata does not restart again" '[ "$(docker_calls restart)" = $((META_RESTARTS + 1)) ]'

# Simulate a running old watcher that already cached this metadata but dropped its inference pins.
python3 "$WORK/meta-config-check.py" owner "$D/config.yaml"
rm -f "$HERMES_STATE_DIR/config-merge-version.sha"
apply
check "upgraded watcher repairs cached Meta metadata without a metadata rewrite" 'python3 "$WORK/meta-config-check.py" assert "$D/config.yaml" && [ "$(docker_calls restart)" = $((META_RESTARTS + 2)) ]'

META_EXPLICIT_CONFIG=$(python3 "$WORK/meta-config-check.py" explicit_metadata "$D/config.yaml")
md_set hermes-config "$META_EXPLICIT_CONFIG"
apply
check "explicit Meta credential and transport selectors take metadata values" 'python3 "$WORK/meta-config-check.py" assert "$D/config.yaml" explicit'

python3 "$WORK/meta-config-check.py" owner "$D/config.yaml"
INFERENCE_BEFORE=$(python3 "$WORK/meta-config-check.py" inference "$D/config.yaml")
md_set hermes-config "$CONFIG3"
apply
check "non-Meta configuration keeps owner auxiliary, delegation and fallback routes" '[ "$(python3 "$WORK/meta-config-check.py" inference "$D/config.yaml")" = "$INFERENCE_BEFORE" ]'
LEGACY_RESTARTS=$(docker_calls restart)
rm -f "$HERMES_STATE_DIR/config-merge-version.sha"
apply
check "upgrading an unchanged legacy merge does not restart Hermes" '[ "$(docker_calls restart)" = "$LEGACY_RESTARTS" ] && [ "$(python3 "$WORK/meta-config-check.py" inference "$D/config.yaml")" = "$INFERENCE_BEFORE" ]'
check "synthetic task keys are never logged" '! grep -q synthetic-owner-auxiliary "$WORK/watcher.log"'

# The initial activation has config.yaml before the owner model is configured.
export HERMES_ROOT="$WORK/meta-fresh" HERMES_DATA_DIR="$WORK/meta-fresh/data" HERMES_STATE_DIR="$WORK/meta-fresh/state"
D="$HERMES_DATA_DIR"
echo false >"$FAKE_DOCKER_STATE"
md_set hermes-config 'timezone: America/Bogota'
apply
md_set hermes-config "$META_CONFIG"
apply
check "a newly initialized VM receives all Meta inference pins when configured later" 'python3 "$WORK/meta-config-check.py" assert "$D/config.yaml" fresh'

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
