#!/usr/bin/env bash
# Rollback de Stock en una VM: el watcher conserva el perfil al retirar la metadata (S-43), y el trabajo sigue vivo.
# Solo después de sacar al usuario de STOCK_USER_IDS y ver su orqa.synced. Sin --apply, solo imprime lo que haría.
set -euo pipefail

usage() { echo 'uso: stock-retirar-vm.sh --instance NOMBRE --zone ZONA --project PROYECTO [--apply]' >&2; exit 2; }
instance='' zone='' project='' apply=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) instance=${2:-}; shift 2 ;;
    --zone) zone=${2:-}; shift 2 ;;
    --project) project=${2:-}; shift 2 ;;
    --apply) apply=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$instance" ] && [ -n "$zone" ] && [ -n "$project" ] || usage
case "$instance" in sa-assistant-*) ;; *) echo 'solo VMs de asistente' >&2; exit 2 ;; esac

version=$(gcloud compute instances describe "$instance" --zone "$zone" --project "$project" --format=json | python3 -c '
import json, sys
print(next((i["value"] for i in json.load(sys.stdin)["metadata"]["items"] if i["key"] == "hermes-bundle-version"), ""))')
case "$version" in
  '') echo 'no se pudo leer hermes-bundle-version' >&2; exit 1 ;;
  *+stock-*) echo "la VM sigue con $version: saca al usuario de STOCK_USER_IDS y espera orqa.synced" >&2; exit 1 ;;
esac

# El estado del watcher también se borra: sin eso, habilitar de nuevo vería hashes iguales y no reinstalaría el perfil.
read -r -d '' remote <<'REMOTO' || true
set -eu
docker exec hermes python3 -c 'import json;print("\n".join(j["id"] for j in json.load(open("/opt/data/cron/jobs.json"))["jobs"] if j["name"].startswith("saleads:stock-tick:")))' |
while read -r id; do [ -z "$id" ] || docker exec hermes hermes cron remove "$id"; done
docker exec hermes hermes profile delete stock --yes
sudo rm -rf /var/lib/hermes/data/profiles/stock /var/lib/hermes/state/profiles/stock
test ! -e /var/lib/hermes/data/profiles/stock
echo stock-retirado
REMOTO

if [ "$apply" != 1 ]; then
  printf 'simulacro en %s (%s). Con --apply correría:\n%s\n' "$instance" "$version" "$remote"
  exit 0
fi
gcloud compute ssh "$instance" --zone "$zone" --project "$project" --tunnel-through-iap --command "$remote"
