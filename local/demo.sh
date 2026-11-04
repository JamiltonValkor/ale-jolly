#!/usr/bin/env bash
# Ale + Jolly en local.
#   ./demo.sh doctor   revisa lo necesario
#   ./demo.sh up       genera certs/ y .env la primera vez, y levanta todo
#   ./demo.sh down     apaga (los datos quedan)
#   ./demo.sh reset    apaga y borra datos, certs y .env
set -euo pipefail
cd "$(dirname "$0")"

: "${ALE_RUNTIME_SRC:=$(cd .. && pwd)/ale-runtime}"
export ALE_RUNTIME_SRC
export ALE_CA_CERT="$PWD/certs/ca.crt"
case "$(uname -m)" in arm64|aarch64) : "${BUILD_PLATFORM:=linux/arm64}" ;; *) : "${BUILD_PLATFORM:=linux/amd64}" ;; esac
export BUILD_PLATFORM
COMPOSE=(docker compose -p ale-jolly -f docker-compose.yml)

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
mal() { printf '  \033[31m✗\033[0m %s\n' "$1"; FALLO=1; }

doctor() {
  FALLO=0
  echo "Revisando lo necesario:"
  command -v docker >/dev/null && ok "docker" || mal "docker no está instalado"
  docker info >/dev/null 2>&1 && ok "docker está corriendo" || mal "docker no responde: abre Docker Desktop"
  docker compose version >/dev/null 2>&1 && ok "docker compose v2" || mal "falta docker compose v2"
  command -v openssl >/dev/null && ok "openssl" || mal "falta openssl"
  [ -d "$ALE_RUNTIME_SRC" ] && ok "código de ale-runtime en $ALE_RUNTIME_SRC" || mal "no está ale-runtime en $ALE_RUNTIME_SRC (ALE_RUNTIME_SRC)"
  for p in "${FRONT_PORT:-3000}" 8060 8443; do
    if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then mal "el puerto $p está ocupado"; else ok "puerto $p libre"; fi
  done
  if [ -f .env ] && grep -q '^META_API_KEY=.\+' .env; then ok "llave de Meta en .env"; else mal "falta META_API_KEY en local/.env"; fi
  [ "$FALLO" = 0 ] && echo "Todo listo." || { echo "Corrige lo marcado con ✗ y vuelve a correr ./demo.sh doctor"; return 1; }
}

CERT_NAMES="saleads.local posthog.local relay.local storage.googleapis.com us-central1-docker.pkg.dev"

certs() {
  # El certificado se rehace (con la misma CA) si le falta algún nombre.
  if [ -f certs/local.crt ]; then
    local san missing=0 n
    san=$(openssl x509 -in certs/local.crt -noout -ext subjectAltName 2>/dev/null || true)
    for n in $CERT_NAMES; do case "$san" in *"DNS:$n"*) ;; *) missing=1 ;; esac; done
    # Python 3.13+ (Hermes) exige keyUsage en la CA: una CA vieja sin esa extensión se rehace.
    openssl x509 -in certs/ca.crt -noout -ext keyUsage 2>/dev/null | grep -q "Certificate Sign" || { missing=1; rm -f certs/ca.crt certs/ca.key; }
    [ "$missing" = 0 ] && return
  fi
  mkdir -p certs
  if [ ! -f certs/ca.crt ] || [ ! -f certs/ca.key ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=Ale Jolly local CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" \
      -keyout certs/ca.key -out certs/ca.crt 2>/dev/null
  fi
  openssl req -newkey rsa:2048 -nodes -subj "/CN=saleads.local" \
    -keyout certs/local.key -out certs/local.csr 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' "$(printf 'DNS:%s,' $CERT_NAMES | sed 's/,$//')" > certs/ext.cnf
  openssl x509 -req -in certs/local.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial \
    -days 825 -extfile certs/ext.cnf -out certs/local.crt 2>/dev/null
  rm -f certs/local.csr certs/ext.cnf
  chmod 600 certs/*.key
  echo "Certificados locales creados en local/certs/ (solo sirven en esta máquina)."
}

envfile() {
  if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
  fi
  # Secretos locales generados una sola vez.
  grep -q '^FIELD_ENCRYPTION_KEY=.\+' .env || echo "FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
  grep -q '^INTERNAL_API_TOKEN=.\+' .env || echo "INTERNAL_API_TOKEN=$(openssl rand -hex 32)" >> .env
  if ! grep -q '^META_API_KEY=.\+' .env; then
    read -rsp "Pega tu llave de la API de Meta (META_API_KEY): " k; echo
    sed -i.bak '/^META_API_KEY=/d' .env && rm -f .env.bak
    echo "META_API_KEY=$k" >> .env
  fi
  # El backend lee la llave de Meta con el nombre del modo administrado.
  k=$(grep '^META_API_KEY=' .env | head -1 | cut -d= -f2-)
  sed -i.bak '/^MANAGED_META_API_KEY=/d' .env && rm -f .env.bak
  echo "MANAGED_META_API_KEY=$k" >> .env
}

case "${1:-up}" in
  doctor) doctor ;;
  up)
    certs; envfile; doctor
    # Cerebro del negocio (saleads-brain) en el Artifact Registry imitado; escribe su digest en .env.
    COMPOSE_CMD="${COMPOSE[*]}" ../cloud-sim/brain-image.sh
    "${COMPOSE[@]}" up -d --build
    echo
    echo "Listo: abre http://localhost:${FRONT_PORT:-3000} (usuario demo, sin contraseña)."
    echo "Jolly en este computador: ../jolly-sim/start.sh"
    ;;
  down) "${COMPOSE[@]}" down ;;
  reset)
    "${COMPOSE[@]}" down -v
    rm -rf certs .env
    echo "Borrado. ./demo.sh up empieza de cero."
    ;;
  logs) shift; "${COMPOSE[@]}" logs -f "$@" ;;
  *) echo "uso: $0 doctor|up|down|reset|logs [servicio]"; exit 2 ;;
esac
