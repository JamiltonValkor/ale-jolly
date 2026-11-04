#!/usr/bin/env bash
# Simula el robot en el Mac: cara (ventana) + voz por el canal robot + brazos si hay Arduino. Empareja igual que la Pi.
#   ./ale_mac.sh            → cara + voz con micrófono (necesita ALE_RUNTIME_URL en voz-hermes/.env)
#   ./ale_mac.sh --sin-cara → solo voz
# Ctrl+C cierra todo. Si la cara se cierra, la voz sigue (y al revés).
set -u
AQUI="$(cd "$(dirname "$0")/.." && pwd)"
REG="$AQUI/voz-hermes/grabaciones"; mkdir -p "$REG"
STAMP="$(date +%Y%m%d-%H%M%S)"
CARA_PID=""; GRAB_PID=""; BRAZOS_PID=""; OJO_PID=""
limpiar() { [ -n "$OJO_PID" ] && { kill "$OJO_PID" 2>/dev/null; wait "$OJO_PID" 2>/dev/null; }; [ -n "$BRAZOS_PID" ] && { kill "$BRAZOS_PID" 2>/dev/null; wait "$BRAZOS_PID" 2>/dev/null; }; [ -n "$CARA_PID" ] && kill "$CARA_PID" 2>/dev/null; [ -n "$GRAB_PID" ] && kill "$GRAB_PID" 2>/dev/null; }
trap limpiar EXIT INT TERM
# Una sola instancia de los brazos: uno viejo se queda con el Arduino y el nuevo no puede moverlos.
pkill -f '[Pp]ython[0-9.]* ([^ ]*/)?brazos\.py' 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f '[Pp]ython[0-9.]* ([^ ]*/)?brazos\.py' >/dev/null 2>&1 || break; sleep 0.3; done
pkill -f "main.py --bus" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do lsof -nP -iTCP:5561 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.3; done
SIN_CARA=0; [ "${1:-}" = "--sin-cara" ] && { SIN_CARA=1; shift; }
if [ "$SIN_CARA" = 0 ]; then
  (cd "$AQUI/cara" && exec .venv/bin/python main.py --bus --registro "$REG/cara-$STAMP.jsonl") &
  CARA_PID=$!
fi
if compgen -G "/dev/cu.usbmodem*" >/dev/null || compgen -G "/dev/ttyACM*" >/dev/null; then         # Arduino de los brazos conectado
  (cd "$AQUI/brazos" && exec .venv/bin/python brazos.py) &
  BRAZOS_PID=$!
fi
if [ "${ALE_OJO:-0}" = 1 ] && [ -d "$AQUI/ojo" ]; then         # cámara y SAM; se reinicia solo
  "$AQUI/ale-robot/bucle_ojo.sh" &
  OJO_PID=$!
  export ALE_EVENTOS=1
fi
(cd "$AQUI/voz-hermes" && exec .venv/bin/python -m cuerpo.grabar "$REG/bus-$STAMP.jsonl" >/dev/null 2>&1) &
GRAB_PID=$!
cd "$AQUI/voz-hermes" && .venv/bin/python voz_hermes.py --robot --cuerpo "$@"
