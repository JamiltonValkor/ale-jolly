#!/usr/bin/env bash
# Mantiene vivo a `ojo`. Si muere espera y lo relanza, sin tocar la voz. Al recibir TERM mata a su hijo: un subshell
# matado a secas dejaría a python con el puerto 5562 tomado.
set -u
ALE="$(cd "$(dirname "$0")/.." && pwd)"
ESPERA="${ALE_OJO_ESPERA:-5}"
PY="${ALE_OJO_PYTHON:-$ALE/ojo/.venv/bin/python}"
HIJO=""
parar() { [ -n "$HIJO" ] && { kill "$HIJO" 2>/dev/null; wait "$HIJO" 2>/dev/null; }; exit 0; }
trap parar TERM INT
cd "$ALE/ojo" || exit 1
while :; do
  "$PY" ojo.py & HIJO=$!
  wait "$HIJO"
  HIJO=""
  sleep "$ESPERA" & HIJO=$!
  wait "$HIJO"
  HIJO=""
done
