#!/usr/bin/env bash
# Barrido de secretos y datos internos antes de cada commit. Sin argumentos revisa jolly-sim/ y evidence/.
#   evidence/barrido-secretos.sh [ruta…]
# Falla (1) con tokens de dispositivo, llaves sk-/AIza/ghp_, JWT, claves privadas, correos, IPs internas, rutas
# /home/pi o, en archivos de datos (json, jsonl, md, txt, log), UUIDs fuera de los ids públicos de la demo. Nunca imprime el valor encontrado: solo archivo y regla.
# Con JOLLY_ENV_REALES=archivo1:archivo2 también busca los valores literales de esos .env (llaves reales a rotar).
set -u
cd "$(dirname "$0")/.."
[ $# -eq 0 ] && set -- jolly-sim evidence
PUBLICOS='a6b8e93d-386f-4141-96ff-4b49e137728a|00000000-0000-4000-a000-000000000001|00000000-0000-4000-8000-000000000001'   # negocio y usuario de demo (CONTRATO-LOCAL.md) y el id de prueba de ale_falso
REGLAS=(
  'token de dispositivo|ale_dev_[A-Za-z0-9_-]{20,}'
  'llave sk-|sk-[A-Za-z0-9_-]{16,}'
  'llave de Google|AIza[0-9A-Za-z_-]{30,}'
  'token de GitHub|gh[pousr]_[A-Za-z0-9]{30,}'
  'token de Slack|xox[abpr]-[A-Za-z0-9-]{10,}'
  'JWT|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
  'clave privada|-----BEGIN [A-Z ]*PRIVATE KEY'
  'correo|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  'IP interna|(^|[^0-9.])(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01])|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)'
  'ruta de la Pi|/home/pi'
  'UUID|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
)
EXCLUIR=(--exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=node_modules --exclude=barrido-secretos.sh)
hallazgos=0
for regla in "${REGLAS[@]}"; do
  nombre="${regla%%|*}"; patron="${regla#*|}"
  while IFS= read -r archivo; do
    [ -z "$archivo" ] && continue
    if [ "$nombre" = UUID ]; then
      grep -IEo "$patron" "$archivo" | grep -Evq "^($PUBLICOS)$" || continue
    fi
    echo "❌ $nombre: $archivo"; hallazgos=$((hallazgos + 1))
  done < <(if [ "$nombre" = UUID ]; then DATOS=(--include='*.json' --include='*.jsonl' --include='*.md' --include='*.txt' --include='*.log' --include='*.tsv'); else DATOS=(); fi
           grep -rIlE "${EXCLUIR[@]}" ${DATOS[@]+"${DATOS[@]}"} "$patron" "$@" 2>/dev/null)
done
# Ningún .env, .tgz ni credencial versionada en las rutas revisadas.
while IFS= read -r archivo; do
  echo "❌ archivo prohibido: $archivo"; hallazgos=$((hallazgos + 1))
done < <(find "$@" \( -name '*.env' -o -name '.env' -o -name '*.tgz' -o -name '*credencial*' \) -not -path '*/.venv/*' 2>/dev/null)
IFS=: read -ra REALES <<< "${JOLLY_ENV_REALES:-}"
for env in "${REALES[@]:-}"; do
  [ -f "$env" ] || continue
  while IFS= read -r valor; do
    [ ${#valor} -ge 12 ] || continue
    if grep -rIlF "${EXCLUIR[@]}" -e "$valor" "$@" >/dev/null 2>&1; then
      echo "❌ valor real de $(basename "$env") en: $(grep -rIlF "${EXCLUIR[@]}" -e "$valor" "$@" | tr '\n' ' ')"; hallazgos=$((hallazgos + 1))
    fi
  done < <(sed -n 's/^[A-Z_]*=//p' "$env" | tr -d '"'"'")
done
if [ "$hallazgos" -gt 0 ]; then echo "$hallazgos hallazgo(s)."; exit 1; fi
echo "✅ barrido limpio: $*"
