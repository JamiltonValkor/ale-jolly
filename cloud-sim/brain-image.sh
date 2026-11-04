#!/usr/bin/env bash
# Publica saleads-brain en el Artifact Registry imitado (cloud-sim-ar) y fija su
# digest en local/.env como BRAIN_IMAGE y STOCK_BRAIN_IMAGE.
#
# El watcher de la VM solo acepta `us-central1-docker.pkg.dev/...@sha256:` y
# ale-runtime exige `.../saleads-brain/...` (src/config.ts). Dentro de la red
# `ale` ese nombre es Caddy → cloud-sim-ar; desde este computador se sube por
# 127.0.0.1:$CLOUD_SIM_AR_PORT. El digest es el mismo con cualquiera de los dos nombres.
#
# Uso (lo llama local/demo.sh up): ALE_RUNTIME_SRC=<ale-runtime> cloud-sim/brain-image.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
LOCAL="$HERE/../local"
: "${ALE_RUNTIME_SRC:?ALE_RUNTIME_SRC}"
PORT="${CLOUD_SIM_AR_PORT:-5055}"
REPO="ale-local/saleads-brain/saleads-brain"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose -p ale-jolly -f docker-compose.yml}"

[ -d "$ALE_RUNTIME_SRC/brain" ] || { echo "no está $ALE_RUNTIME_SRC/brain" >&2; exit 1; }

# 1. El registro tiene que estar arriba para subir.
(cd "$LOCAL" && $COMPOSE_CMD up -d cloud-sim-ar >/dev/null)
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/v2/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/v2/" >/dev/null || { echo "cloud-sim-ar no responde en 127.0.0.1:$PORT" >&2; exit 1; }

# 2. Construir para la plataforma del motor Docker (la de las VMs) y subir.
platform="linux/$(docker version -f '{{.Server.Arch}}')"
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT
echo "Construyendo saleads-brain ($platform) y subiéndolo al Artifact Registry local…"
docker buildx build --quiet --platform "$platform" --provenance=false --sbom=false \
  --metadata-file "$meta" -t "127.0.0.1:$PORT/$REPO:local" --push "$ALE_RUNTIME_SRC/brain" >/dev/null
digest=$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$meta" | head -n 1)
[ -n "$digest" ] || { echo "no se obtuvo el digest de la imagen" >&2; exit 1; }
image="us-central1-docker.pkg.dev/$REPO@$digest"

# 3. Fijarlo en .env (reemplaza los valores anteriores).
env="$LOCAL/.env"
touch "$env"
sed -i.bak -e '/^BRAIN_IMAGE=/d' -e '/^STOCK_BRAIN_IMAGE=/d' "$env" && rm -f "$env.bak"
printf 'BRAIN_IMAGE=%s\nSTOCK_BRAIN_IMAGE=%s\n' "$image" "$image" >>"$env"
echo "saleads-brain: $image"
