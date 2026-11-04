#!/bin/bash
# Arranque de una «VM» de cloud-sim (decisión D6). Hace lo que en GCE hacen el
# arranque de COS, el startup-script y systemd, sin tocar el watcher:
#   1. confía en la CA local (D1) que sirve cloud-sim;
#   2. reenvía DNS para que Hermes (contenedor anidado) resuelva los nombres de
#      la red `ale` (saleads.local, storage.googleapis.com, relay.local…);
#   3. arranca dockerd;
#   4. baja el `startup-script` de SU metadata, como GCE en cada arranque;
#   5. prepara la imagen de Hermes fijada por digest en ese script, con la CA
#      local agregada en una capa encima (la oficial no la conoce);
#   6. corre `startup-script.sh watch` y lo reinicia si sale (Restart=always).
set -euo pipefail

: "${HERMES_MD_URL:?}" "${CLOUD_SIM_URL:?}"
ROOT=/var/lib/hermes
SCRIPT="$ROOT/bin/hermes-vm.sh"
CA=/usr/local/share/ca-certificates/ale-local-ca.crt

log() { printf '%s vm-boot: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
mkdir -p "$ROOT/bin"
chmod 0700 "$ROOT" "$ROOT/bin"

# 1. CA local.
if curl -fsS --max-time 10 "$CLOUD_SIM_URL/vm/ca.crt" -o "$CA.tmp"; then
  mv "$CA.tmp" "$CA"
  update-ca-certificates >/dev/null 2>&1 || cat "$CA" >>/etc/ssl/certs/ca-certificates.crt
  log "local CA trusted"
else
  rm -f "$CA.tmp"
  log "no local CA served; only public roots"
fi

# 2. DNS: los contenedores anidados no alcanzan 127.0.0.11 (DNS de Docker).
IP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
dnsmasq --no-resolv --server=127.0.0.11 --listen-address="$IP" --bind-interfaces \
  --no-hosts --cache-size=500 --user=root

# 3. dockerd.
args=(dockerd --dns "$IP")
if [ -n "${CLOUD_SIM_REGISTRY_MIRROR:-}" ]; then
  args+=(--registry-mirror "http://$CLOUD_SIM_REGISTRY_MIRROR" --insecure-registry "$CLOUD_SIM_REGISTRY_MIRROR")
fi
rm -f /var/run/docker.pid
dockerd-entrypoint.sh "${args[@]}" >/var/log/dockerd.log 2>&1 &
DOCKERD=$!
for _ in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { log "dockerd did not start"; tail -n 50 /var/log/dockerd.log >&2; exit 1; }
log "dockerd up ip=$IP"

shutdown() {
  log "stopping"
  [ -n "${WATCH:-}" ] && kill "$WATCH" 2>/dev/null || true
  docker ps -q | xargs -r docker stop -t 20 >/dev/null 2>&1 || true
  kill -TERM "$DOCKERD" 2>/dev/null || true
  wait "$DOCKERD" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# 4. startup-script desde la metadata de la instancia.
until curl -fsS --max-time 10 -H 'Metadata-Flavor: Google' \
  "$HERMES_MD_URL/instance/attributes/startup-script" -o "$SCRIPT.tmp"; do
  log "waiting for metadata startup-script"; sleep 3
done
install -m 0700 "$SCRIPT.tmp" "$SCRIPT"; rm -f "$SCRIPT.tmp"

# 5. Imagen de Hermes: la fijada en el script, más la CA local.
OFFICIAL=$(sed -n 's/^HERMES_IMAGE="\${HERMES_IMAGE:-\(.*\)}"$/\1/p' "$SCRIPT" | head -n 1)
[ -n "$OFFICIAL" ] || { log "pinned HERMES_IMAGE not found in startup-script"; exit 1; }
export HERMES_IMAGE="$OFFICIAL"
if [ -f "$CA" ]; then
  tag="ale-local/hermes-agent:$(printf '%s' "$OFFICIAL" | cat - "$CA" | sha256sum | cut -c1-16)"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    until docker image inspect "$OFFICIAL" >/dev/null 2>&1 || docker pull -q "$OFFICIAL" >/dev/null; do
      log "pull of pinned Hermes image failed; retrying"; sleep 10
    done
    ctx=$(mktemp -d)
    cp "$CA" "$ctx/ale-local-ca.crt"
    user=$(docker image inspect -f '{{.Config.User}}' "$OFFICIAL")
    {
      echo "FROM $OFFICIAL"
      echo "USER root"
      echo "COPY ale-local-ca.crt /usr/local/share/ca-certificates/ale-local-ca.crt"
      echo "RUN cat /usr/local/share/ca-certificates/ale-local-ca.crt >>/etc/ssl/certs/ca-certificates.crt; \\"
      echo "    for f in \$(find / -xdev -name cacert.pem -path '*certifi*' 2>/dev/null); do \\"
      echo "      cat /usr/local/share/ca-certificates/ale-local-ca.crt >>\"\$f\"; done"
      echo "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ale-local-ca.crt"
      [ -z "$user" ] || echo "USER $user"
    } >"$ctx/Dockerfile"
    docker build -q -t "$tag" "$ctx" >/dev/null
    rm -rf "$ctx"
    log "built $tag (pinned Hermes + local CA)"
  fi
  export HERMES_IMAGE="$tag"
fi

# 6. Watcher, como hermes-watcher.service (Restart=always, RestartSec=5).
export HERMES_DOCKER_CRED="${HERMES_DOCKER_CRED:-true}"
while :; do
  bash "$SCRIPT" watch &
  WATCH=$!
  wait "$WATCH" || log "watcher exited rc=$?"
  sleep 5
done
