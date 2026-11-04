#!/usr/bin/env bash
# OCB-003 — Ajusta SOLO el cliente Keycloak del asistente (dev) para el diseño en un clic (ADR0028).
#
# Uso:  KCADM=<wrapper> scripts/keycloak/one-click-client.sh --dry-run | --apply | --verify
#
# KCADM es un comando que ejecuta kcadm.sh con una sesión ya abierta. Patrón recomendado,
# sin que las credenciales de admin salgan del pod:
#   kubectl -n keycloak exec -i keycloak-0 -c keycloak -- /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/<sesion>.config
#
# Solo toca clients/<id> de mcp-saleads-assistant-dev y la asignación de sus client scopes.
# No modifica el realm, otros clientes, client policies, DCR ni los propios client scopes.
set -euo pipefail

REALM="${REALM:-sale-ads}"
CLIENT_ID="${CLIENT_ID:-mcp-saleads-assistant-dev}"
REDIRECTS='["https://dev.saleads.ai/api/sales-assistant/oauth/callback","http://localhost:3000/api/sales-assistant/oauth/callback"]'
DEFAULT_SCOPES="saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events offline_access"
MARKER_KEY="saleads.one-click.task"
MARKER_VALUE="OCB-003/one-click-v1"
MODE="${1:-}"
: "${KCADM:?Define KCADM (ver cabecera)}"

kc() { $KCADM "$@"; }

client_json() { kc get clients -r "$REALM" -q clientId="$CLIENT_ID" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);assert len(d)==1,"cliente no encontrado";c=d[0];c.pop("secret",None);print(json.dumps(c))'; }
scope_id() { kc get client-scopes -r "$REALM" --fields id,name | python3 -I -c "import json,sys;d={s['name']:s['id'] for s in json.load(sys.stdin)};print(d['$1'])"; }

plan() {
  python3 -I - "$1" "$REDIRECTS" "$DEFAULT_SCOPES" <<'PY'
import json,sys
c=json.loads(sys.argv[1]); want_r=json.loads(sys.argv[2]); want_d=sys.argv[3].split()
diff=[]
if c.get("consentRequired") is not False: diff.append("consentRequired -> false")
if c.get("publicClient") is not True: diff.append("publicClient -> true (PKCE, sin secreto)")
if sorted(c.get("redirectUris",[]))!=sorted(want_r): diff.append(f"redirectUris {c.get('redirectUris')} -> {want_r}")
if c.get("attributes",{}).get("pkce.code.challenge.method")!="S256": diff.append("pkce -> S256")
missing=[s for s in want_d if s not in c.get("defaultClientScopes",[])]
if missing: diff.append(f"default scopes + {missing}")
opt=[s for s in c.get("optionalClientScopes",[]) if s in want_d]
if opt: diff.append(f"optional scopes - {opt}")
print("\n".join(diff) if diff else "SIN CAMBIOS")
PY
}

case "$MODE" in
  --dry-run)
    plan "$(client_json)";;
  --apply)
    C="$(client_json)"; ID=$(python3 -I -c 'import json,sys;print(json.loads(sys.argv[1])["id"])' "$C")
    echo "Plan:"; plan "$C"
    kc update "clients/$ID" -r "$REALM" \
      -s consentRequired=false -s publicClient=true -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
      -s "redirectUris=$REDIRECTS" \
      -s 'attributes."pkce.code.challenge.method"=S256' \
      -s "attributes.\"$MARKER_KEY\"=$MARKER_VALUE"
    for s in $(python3 -I -c 'import json,sys;print(" ".join(json.loads(sys.argv[1]).get("optionalClientScopes",[])))' "$C"); do
      case " $DEFAULT_SCOPES " in *" $s "*) kc delete "clients/$ID/optional-client-scopes/$(scope_id "$s")" -r "$REALM";; esac
    done
    for s in $DEFAULT_SCOPES; do
      python3 -I -c 'import json,sys;sys.exit(0 if sys.argv[2] in json.loads(sys.argv[1]).get("defaultClientScopes",[]) else 1)' "$C" "$s" \
        || kc update "clients/$ID/default-client-scopes/$(scope_id "$s")" -r "$REALM"
    done
    echo "Después:"; plan "$(client_json)";;
  --verify)
    R="$(plan "$(client_json)")"; echo "$R"; [ "$R" = "SIN CAMBIOS" ];;
  *) echo "Uso: $0 --dry-run | --apply | --verify" >&2; exit 2;;
esac
