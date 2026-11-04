#!/usr/bin/env bash
# Revisa que el robot tenga todo para arrancar. Se corre EN la Pi:  ./verificar.sh   (no hace ruido)
#   ./verificar.sh --sonido     → además suena un tono corto por el parlante (avisa antes a quien esté cerca)
set -u
ALE="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ALE/voz-hermes/.env"
FALLOS=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
mal()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FALLOS=$((FALLOS+1)); }
aviso(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
val()  { grep -E "^$1=" "$ENV" 2>/dev/null | head -1 | cut -d= -f2-; }

echo "Código y entornos"
for d in voz-hermes cara; do [ -x "$ALE/$d/.venv/bin/python" ] && ok "$d/.venv" || mal "$d/.venv (corre ./instalar_pi.sh)"; done
[ -d "$ALE/brazos" ] && { [ -x "$ALE/brazos/.venv/bin/python" ] && ok "brazos/.venv" || aviso "brazos sin .venv"; }

echo "Configuración (.env)"
[ -f "$ENV" ] && ok "$ENV" || mal "falta $ENV (config/env.ejemplo o llevar_a_pi.sh)"
for k in META_API_KEY CARTESIA_API_KEY ALE_RUNTIME_URL; do [ -n "$(val $k)" ] && ok "$k" || mal "$k vacío"; done
[ -n "$(val ALE_DEVICE_TOKEN)" ] && ok "robot emparejado (ALE_DEVICE_TOKEN)" || aviso "sin emparejar: al arrancar mostrará el código"

echo "Audio"
if command -v arecord >/dev/null; then
  arecord -l 2>/dev/null | grep -q '^card' && ok "micrófono: $(arecord -l | grep '^card' | head -1 | cut -d: -f2- | cut -c1-50)" || mal "no hay micrófono (¿mic USB conectado?)"
  aplay -l 2>/dev/null | grep -q '^card' && ok "salida: $(aplay -l | grep '^card' | head -1 | cut -d: -f2- | cut -c1-50)" || mal "no hay salida de audio"
else aviso "alsa-utils no instalado"; fi
if [ "${1:-}" = "--sonido" ]; then
  "$ALE/voz-hermes/.venv/bin/python" - <<'PY' && ok "tono reproducido (¿se escuchó?)" || mal "no pude reproducir audio"
import numpy as np, sounddevice as sd
t = np.linspace(0, 0.4, 9600, False); sd.play((0.2*np.sin(2*np.pi*660*t)).astype(np.float32), 24000); sd.wait()
PY
fi

grep -q pipewire /etc/asound.conf 2>/dev/null && ok "salida por PipeWire (asound.conf)" || aviso "asound.conf sin PipeWire: sin Bluetooth (./instalar_pi.sh)"
loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes && ok "linger de $(id -un)" || aviso "sin linger: el servicio no alcanza PipeWire"
systemctl cat ale 2>/dev/null | grep -q XDG_RUNTIME_DIR && ok "XDG_RUNTIME_DIR en ale" || aviso "ale sin XDG_RUNTIME_DIR (drop-in audio-pipewire.conf)"

echo "Pantalla"
ls /dev/dri/card* >/dev/null 2>&1 && ok "KMS/DRM disponible ($(ls /dev/dri/card* | tr '\n' ' '))" || mal "sin /dev/dri (¿pantalla HDMI conectada?)"
MODO="$(head -1 /sys/class/drm/card*-HDMI-A-1/modes 2>/dev/null | head -1)"
[ "$MODO" = 1280x720 ] && ok "modo nativo 1280x720" || aviso "modo de HDMI-A-1: ${MODO:-sin dato} (se espera 1280x720)"
CMD=/boot/firmware/cmdline.txt; [ -f "$CMD" ] || CMD=/boot/cmdline.txt
grep -q 'video=' "$CMD" 2>/dev/null && aviso "$CMD fuerza video=: con 480x320 la pantalla queda negra" || ok "sin video= en cmdline"
systemctl cat ale 2>/dev/null | grep -q ALE_CARA_GIRO && ok "giro en ale ($(systemctl cat ale | grep -o 'ALE_CARA_GIRO=[0-9]*' | tail -1))" || aviso "ale sin ALE_CARA_GIRO: la cara sale al derecho"
ls /dev/input/by-path/*spi*event >/dev/null 2>&1 && ok "táctil ads7846" || aviso "sin táctil: overlay ads7846 (PI.md)"

echo "Cámara y ojo"
[ -x "$ALE/ojo/.venv/bin/python" ] && ok "ojo/.venv" || aviso "ojo sin .venv (./instalar_pi.sh)"
command -v ffmpeg >/dev/null && ok "ffmpeg" || aviso "sin ffmpeg: no captura con v4l2"
ls /dev/video* >/dev/null 2>&1 && ok "cámara: $(ls /dev/video* | head -1)" || aviso "sin cámara: usa ALE_CAMARA=carpeta:… o muse:…"

echo "Red"
URL="$(val ALE_RUNTIME_URL)"
if [ -n "$URL" ]; then
  # Solo aviso: detrás del gateway /healthz puede no estar en esa ruta aunque el canal funcione.
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/healthz")
  [ "$C" = 200 ] && ok "ale-runtime responde ($URL)" || aviso "$URL/healthz da $C (el canal se revisa abajo)"
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST -H 'content-type: application/json' -d '{}' "$URL/devices/pairing/00000000-0000-4000-8000-000000000000/poll")
  [ "$C" = 404 ] || [ "$C" = 400 ] && ok "canal robot activo en ale-runtime" || mal "el canal robot no responde (¿ROBOT_CHANNEL_ENABLED?) código $C"
fi
for h in api.meta.ai api.cartesia.ai; do getent hosts "$h" >/dev/null 2>&1 && ok "DNS $h" || mal "no resuelve $h (¿internet?)"; done

echo
[ "$FALLOS" = 0 ] && echo "✅ Todo listo: sudo systemctl restart ale" || { echo "❌ $FALLOS problema(s) arriba"; exit 1; }
