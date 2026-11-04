#!/usr/bin/env bash
# Ensayo sin red de llevar_a_pi.sh: por defecto no borra, y --espejo solo borra con confirmación.
#   bash robot/ale-robot/test_llevar_a_pi.sh
set -u
ROBOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FALLOS=0
bien() { printf '  ok  %s\n' "$1"; }
mal()  { printf '  MAL %s\n' "$1"; FALLOS=$((FALLOS+1)); }
exigir() { if eval "$2"; then bien "$1"; else mal "$1"; fi; }

cp -R "$ROBOT" "$T/robot"
printf 'ALE_RUNTIME_URL=https://example.invalid\n' > "$T/robot/voz-hermes/.env"
D="$T/destino"; SCRIPT="$T/robot/ale-robot/llevar_a_pi.sh"
sembrar() {
  mkdir -p "$D/cara" "$D/voz-hermes/voces/rellenos"
  touch "$D/cara/extra" "$D/cara/main.py.orig" "$D/voz-hermes/voces/rellenos/audio.pcm"
}
correr() { ALE_DESTINO="$D" "$SCRIPT" local "$@"; }

echo "Por defecto"
sembrar
correr >/dev/null 2>&1; rc=$?
exigir "sale bien" '[ "$rc" = 0 ]'
exigir "copia el código" '[ -f "$D/cara/main.py" ]'
exigir "conserva el archivo extra" '[ -f "$D/cara/extra" ]'

echo "--espejo sin confirmar"
rm "$D/cara/main.py"
salida="$(correr --espejo </dev/null 2>&1)"; rc=$?
exigir "sale con 3" '[ "$rc" = 3 ]'
exigir "muestra el archivo" 'printf "%s" "$salida" | grep -q "cara/extra"'
exigir "no borra" '[ -f "$D/cara/extra" ]'
exigir "no copia" '[ ! -f "$D/cara/main.py" ]'
exigir "no lista lo excluido" '! printf "%s" "$salida" | grep -qE "rellenos|\.orig"'

echo "--espejo con otra respuesta"
printf 'si\n' | correr --espejo >/dev/null 2>&1; rc=$?
exigir "no acepta otra palabra" '[ "$rc" = 3 ] && [ -f "$D/cara/extra" ]'

echo "--espejo confirmado"
printf 'BORRAR\n' | correr --espejo >/dev/null 2>&1; rc=$?
exigir "sale bien" '[ "$rc" = 0 ]'
exigir "borra el extra" '[ ! -f "$D/cara/extra" ]'
exigir "copia el código" '[ -f "$D/cara/main.py" ]'
exigir "conserva los rellenos" '[ -f "$D/voz-hermes/voces/rellenos/audio.pcm" ]'
exigir "conserva el .env" '[ -f "$D/voz-hermes/.env" ]'

echo "--espejo sin nada que borrar"
correr --espejo </dev/null >/dev/null 2>&1; rc=$?
exigir "no pregunta" '[ "$rc" = 0 ]'

echo "Opción desconocida"
sembrar
correr --borrar >/dev/null 2>&1; rc=$?
exigir "sale con 2" '[ "$rc" = 2 ]'

[ "$FALLOS" = 0 ] && { echo "✅ llevar_a_pi.sh sin sorpresas"; exit 0; }
echo "❌ $FALLOS falla(s)"; exit 1
