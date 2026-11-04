#!/usr/bin/env bash
# Lleva a Ale del Mac a la Raspberry (código + .env del robot). Se corre EN EL MAC:
#   ./llevar_a_pi.sh pi@ale.local                 # copia todo a ~/ale en la Pi
#   ./llevar_a_pi.sh pi@ale.local --instalar      # además corre instalar_pi.sh allá
#   ./llevar_a_pi.sh pi@ale.local --espejo        # además borra allá lo que no está aquí; antes muestra la lista y pide BORRAR
#   ALE_DESTINO=/tmp/ale-prueba ./llevar_a_pi.sh local   # ensayo: copia a una carpeta local
# Por defecto no borra nada en el destino: el dueño también programa en la Pi.
# Del .env del Mac solo viajan las keys del robot (Meta, Cartesia, ALE_RUNTIME_URL/NAME); nunca tu login web.
set -euo pipefail
ROBOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO_HOST="${1:?uso: llevar_a_pi.sh usuario@host [--instalar]}"
INSTALAR=0; ESPEJO=0
for op in "${@:2}"; do
  case "$op" in
    --instalar) INSTALAR=1 ;;
    --espejo) ESPEJO=1 ;;
    *) echo "opción desconocida: $op" >&2; exit 2 ;;
  esac
done
EXCLUIR=(--exclude .venv --exclude __pycache__ --exclude .pytest_cache --exclude grabaciones --exclude .env --exclude datos
         --exclude 'pruebas/*.aiff' --exclude '*.onnx' --exclude '*.onnx.json' --exclude audiciones --exclude capturas --exclude docs --exclude '*.log' --exclude entrega
         --exclude voces/rellenos --exclude '*.orig')
RSYNC=(-a); [ "$ESPEJO" = 1 ] && RSYNC=(-a --delete)
if [ "$DESTINO_HOST" = local ]; then
  DEST="${ALE_DESTINO:?con 'local' define ALE_DESTINO}"; mkdir -p "$DEST"; SITIO="$DEST"
else
  DEST="~/ale"; ssh "$DESTINO_HOST" 'mkdir -p ~/ale'; SITIO="$DESTINO_HOST:ale"; RSYNC+=(-z)
fi
RS() { rsync "${RSYNC[@]}" "${EXCLUIR[@]}" "$1" "$SITIO/$2"; }
CARPETAS=(voz-hermes cara ale-robot); [ -d "$ROBOT/brazos" ] && CARPETAS+=(brazos); [ -d "$ROBOT/ojo" ] && CARPETAS+=(ojo)
if [ "$ESPEJO" = 1 ]; then
  echo "▶ Ensayo: esto se borraría en $DESTINO_HOST:$DEST"
  BORRAR=0
  for c in "${CARPETAS[@]}"; do
    LISTA="$(rsync "${RSYNC[@]}" -nv "${EXCLUIR[@]}" "$ROBOT/$c/" "$SITIO/$c" 2>/dev/null | sed -n 's/^deleting //p')" || true
    [ -n "$LISTA" ] || continue
    printf '%s\n' "$LISTA" | sed "s|^|   $c/|"
    BORRAR=1
  done
  if [ "$BORRAR" = 1 ]; then
    printf 'Escribe BORRAR para copiar y borrar eso: '
    IFS= read -r RESPUESTA || RESPUESTA=""
    [ "$RESPUESTA" = BORRAR ] || { echo; echo "Sin confirmar: no se copió ni se borró nada."; exit 3; }
  else
    echo "   (nada)"
  fi
fi
echo "▶ Copiando código a $DESTINO_HOST:$DEST"
for c in "${CARPETAS[@]}"; do RS "$ROBOT/$c/" "$c"; done
echo "▶ .env del robot (solo las keys que necesita)"
ENV_MAC="$ROBOT/voz-hermes/.env"
TMP="$(mktemp)"; chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
grep -E '^(META_API_KEY|CARTESIA_API_KEY|ALE_RUNTIME_URL|ALE_ROBOT_NAME)=' "$ENV_MAC" > "$TMP" || true
grep -q '^ALE_RUNTIME_URL=' "$TMP" || { echo '❌ Falta ALE_RUNTIME_URL en voz-hermes/.env'; exit 1; }
if [ "$DESTINO_HOST" = local ]; then
  [ -f "$DEST/voz-hermes/.env" ] && grep -E '^ALE_DEVICE_(TOKEN|ID)=' "$DEST/voz-hermes/.env" >> "$TMP" || true
  install -m 600 "$TMP" "$DEST/voz-hermes/.env"
else
  # conserva la credencial del robot si ya estaba emparejado
  ssh "$DESTINO_HOST" "grep -E '^ALE_DEVICE_(TOKEN|ID)=' ~/ale/voz-hermes/.env 2>/dev/null" >> "$TMP" || true
  scp -q "$TMP" "$DESTINO_HOST:ale/voz-hermes/.env"; ssh "$DESTINO_HOST" 'chmod 600 ~/ale/voz-hermes/.env'
fi
echo "   ✓ $(cut -d= -f1 "$TMP" | tr '\n' ' ')"

if [ "$INSTALAR" = 1 ] && [ "$DESTINO_HOST" != local ]; then
  ssh -t "$DESTINO_HOST" 'cd ~/ale/ale-robot && ./instalar_pi.sh'
fi
echo "✅ Listo. En la Pi: cd ~/ale/ale-robot && ./verificar.sh"
