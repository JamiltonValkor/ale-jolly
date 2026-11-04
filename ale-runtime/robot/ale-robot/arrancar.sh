#!/usr/bin/env bash
# Arranca a Ale en el robot: cara (pantalla completa) + brazos (si hay Arduino) + voz por el canal robot.
# Lo llama ale.service al encender; también se puede correr a mano:  ~/ale/ale-robot/arrancar.sh
# Sin credencial, la voz pide un código de emparejamiento y la cara lo muestra (ver README).
set -u
ALE="$(cd "$(dirname "$0")/.." && pwd)"
REG="$ALE/voz-hermes/grabaciones"; mkdir -p "$REG"
STAMP="$(date +%Y%m%d-%H%M%S)"
PIDS=()
limpiar() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; [ -n "${BRAZOS_PID:-}" ] && wait "$BRAZOS_PID" 2>/dev/null; }
trap limpiar EXIT INT TERM

# Una sola instancia de los brazos: uno viejo se queda con el Arduino y el nuevo no puede moverlos.
pkill -f '[Pp]ython[0-9.]* ([^ ]*/)?brazos\.py' 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f '[Pp]ython[0-9.]* ([^ ]*/)?brazos\.py' >/dev/null 2>&1 || break; sleep 0.3; done

# Cara: en la Pi sin escritorio, SDL dibuja directo en la pantalla (KMS/DRM).
if [ "${ALE_SIN_CARA:-0}" != 1 ]; then
  (cd "$ALE/cara" && SDL_AUDIODRIVER=dummy SDL_VIDEODRIVER="${SDL_VIDEODRIVER:-kmsdrm}" .venv/bin/python main.py --bus --pantalla-completa --fps 30 \
     --registro "$REG/cara-$STAMP.jsonl") &
  PIDS+=($!)
fi

# Brazos: solo si hay un Arduino conectado.
if { compgen -G "/dev/ttyACM*" >/dev/null || compgen -G "/dev/ttyUSB*" >/dev/null; } && [ -d "$ALE/brazos" ]; then
  (cd "$ALE/brazos" && exec .venv/bin/python brazos.py) &
  BRAZOS_PID=$!
  PIDS+=($BRAZOS_PID)
fi

# Grabador del bus (para revisar sesiones después).
(cd "$ALE/voz-hermes" && .venv/bin/python -m cuerpo.grabar "$REG/bus-$STAMP.jsonl" >/dev/null 2>&1) &
PIDS+=($!)

# Ojo: cámara y SAM, solo con ALE_OJO=1. Su propio bucle lo reinicia, y la voz recibe las órdenes de Stock.
if [ "${ALE_OJO:-0}" = 1 ] && [ -d "$ALE/ojo" ]; then
  "$ALE/ale-robot/bucle_ojo.sh" &
  PIDS+=($!)
  export ALE_EVENTOS=1
fi

# Bluetooth: conecta la primera salida disponible; se reintenta solo.
"$ALE/ale-robot/audio_bt.sh" &
PIDS+=($!)

# La voz espera la red el tiempo que haga falta: salir aquí cerraría la cara en bucle. La cara avisa que no hay internet.
until curl -s -m 3 -o /dev/null "https://${ALE_RED_DESTINO:-api.cartesia.ai}"; do sleep 2; done

# Voz: oído (Muse) + Ale por el canal robot + voz (Cartesia) + director del cuerpo.
cd "$ALE/voz-hermes" && .venv/bin/python voz_hermes.py --robot --cuerpo "$@"
