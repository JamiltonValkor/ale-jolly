#!/usr/bin/env bash
# Prepara una Raspberry Pi 5 (Raspberry Pi OS Lite/Trixie, 64 bits) para Ale. Se corre EN la Pi, una vez:
#   cd ~/ale/ale-robot && ./instalar_pi.sh            # todo
#   ALE_AUDIO_TARJETA=vc4hdmi1 ./instalar_pi.sh       # salida directa a esa tarjeta, sin PipeWire ni Bluetooth (aplay -l)
#   ALE_MIC_TARJETA=Device ./instalar_pi.sh           # micrófono (nombre en arecord -l)
#   ALE_CARA_GIRO=180 ./instalar_pi.sh                # pantalla montada al revés
#   ALE_BT_SALIDAS="AA:.. BB:.." ./instalar_pi.sh     # salidas Bluetooth en orden de preferencia (ver audio_bt.sh)
# Idempotente: se puede volver a correr, y si apagaste el servicio no lo enciende. Pide sudo para paquetes, audio y
# servicio. Lo de arranque (táctil, fbcon) no se toca aquí: ver PI.md. Plantillas en config/pi/.
set -euo pipefail
ALE="$(cd "$(dirname "$0")/.." && pwd)"
YO="$(id -un)"
paso() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

paso "Paquetes del sistema (audio, SDL/KMS para la cara, ZeroMQ, compilación)"
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv python3-dev build-essential curl rsync \
  libportaudio2 libasound2-dev alsa-utils ffmpeg \
  libsdl2-2.0-0 libsdl2-image-2.0-0 libsdl2-ttf-2.0-0 libdrm2 libgbm1 libegl1 \
  libzmq5 libjpeg-dev zlib1g-dev fonts-dejavu-core \
  pipewire pipewire-alsa wireplumber bluez libspa-0.2-bluetooth
sudo usermod -aG audio,video,input,dialout,render,bluetooth "$YO" || true

paso "uv (entornos de Python)"
if ! command -v uv >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
export PATH="$HOME/.local/bin:$PATH"

crear_venv() {   # carpeta requisitos
  [ -d "$1" ] || { echo "   (no está $1, se omite)"; return; }
  (cd "$1" && uv venv -q --allow-existing --python 3.12 .venv && uv pip install -q --python .venv/bin/python -r "$2")
  echo "   ✓ $1"
}
paso "Entornos de voz, cara, brazos y ojo"
crear_venv "$ALE/voz-hermes" "$ALE/ale-robot/config/requisitos-voz.txt"
crear_venv "$ALE/cara"       "$ALE/ale-robot/config/requisitos-cara.txt"
crear_venv "$ALE/brazos"     "$ALE/ale-robot/config/requisitos-cara.txt"
crear_venv "$ALE/ojo"        "$ALE/ale-robot/config/requisitos-ojo.txt"

plantilla() {   # archivo de config/pi → destino en /etc
  sed -e "s|@UID@|$(id -u)|g" -e "s|@MIC@|$MIC|g" -e "s|@CTL@|$CTL|g" -e "s|@BT_SALIDAS@|${ALE_BT_SALIDAS:-}|g" \
      -e "s|@GIRO@|${ALE_CARA_GIRO:-}|g" "$ALE/ale-robot/config/pi/$1" | sudo tee "$2" >/dev/null
}
D=/etc/systemd/system/ale.service.d
sudo mkdir -p "$D"
MIC="${ALE_MIC_TARJETA:-Device}"; CTL="${ALE_AUDIO_TARJETA:-vc4hdmi0}"
if [ -f /etc/asound.conf ] && [ ! -f /etc/asound.conf.antes-de-ale ]; then sudo cp /etc/asound.conf /etc/asound.conf.antes-de-ale; fi
if [ -n "${ALE_AUDIO_TARJETA:-}" ]; then
  paso "Audio: voz directa por $CTL y oído por el micrófono USB"
  case "$CTL" in vc4hdmi*) PCM="hdmi:CARD=$CTL,DEV=0";; *) PCM="hw:CARD=$CTL,DEV=0";; esac   # el HDMI solo acepta IEC958
  sudo tee /etc/asound.conf >/dev/null <<ASOUND
pcm.!default {
  type asym
  playback.pcm { type plug; slave.pcm "$PCM" }
  capture.pcm { type plug; slave.pcm "hw:CARD=$MIC,DEV=0" }
}
ctl.!default { type hw; card $CTL }
ASOUND
  sudo rm -f "$D/audio-pipewire.conf"
else
  paso "Audio: voz por PipeWire (Bluetooth si está, si no HDMI) y oído por el micrófono USB"
  plantilla asound.conf /etc/asound.conf
  plantilla audio-pipewire.conf "$D/audio-pipewire.conf"
  sudo loginctl enable-linger "$YO"           # PipeWire de usuario vivo sin sesión abierta: ale corre como servicio
fi
[ -z "${ALE_BT_SALIDAS:-}" ] || plantilla audio-bt.conf "$D/audio-bt.conf"

paso "Arranque sin escritorio (la cara usa la pantalla directo)"
sudo systemctl set-default multi-user.target >/dev/null

paso "Servicio ale (arranca solo al encender)"
ANTES="$(systemctl is-enabled ale.service 2>/dev/null || true)"   # antes de escribir la unidad: si no, siempre daría disabled
sed -e "s|@USUARIO@|$YO|g" -e "s|@ALE@|$ALE|g" "$ALE/ale-robot/config/ale.service" | sudo tee /etc/systemd/system/ale.service >/dev/null
[ -z "${ALE_CARA_GIRO:-}" ] || plantilla pantalla.conf "$D/pantalla.conf"
sudo systemctl daemon-reload
if [ "$ANTES" = disabled ]; then
  echo "   ✓ ale.service actualizado; sigue apagado, como estaba (sudo systemctl enable --now ale)"
else
  sudo systemctl enable ale.service >/dev/null
  echo "   ✓ ale.service habilitado (sudo systemctl start ale · journalctl -u ale -f)"
fi

paso "Listo"
[ -f "$ALE/voz-hermes/.env" ] || echo "   ⚠️ Falta $ALE/voz-hermes/.env (ver config/env.ejemplo, o usa llevar_a_pi.sh desde el Mac)"
echo "   Siguiente: ./verificar.sh  y luego  sudo reboot"
