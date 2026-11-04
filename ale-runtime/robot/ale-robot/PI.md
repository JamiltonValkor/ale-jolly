# La Pi de Jolly: lo que vive fuera de `~/ale`

`llevar_a_pi.sh` solo lleva código y `.env`. Este documento guarda lo demás, para reconstruir el robot. Los valores personales van como variables y nunca entran al repo:

| Variable | Qué es |
|---|---|
| `$ALE_PI_HOST` | Nombre del equipo en Tailscale |
| `$ALE_BT_SALIDAS` | Direcciones Bluetooth, en orden de preferencia |
| `$ALE_WIFI_SSID` | Red Wi-Fi |

## Procedencia

Lo de `~/ale` viene de `db355ab`, el commit local de la Pi, integrado en esta rama por `feat/pi-resguardo`. Lo de `/etc` y `/boot` se reconstruyó de los comandos que lo aplicaron y de las notas del proyecto. **No se leyó de la Pi al escribirlo.** Antes de confiar en una plantilla, compárala con el archivo real (ver [Comprobar](#comprobar)).

## Sistema

- Raspberry Pi 5 de 8 GB, Raspberry Pi OS Lite Trixie, 64 bits, sin escritorio: `systemctl set-default multi-user.target`.
- Acceso por Tailscale con llave SSH: `ssh $ALE_PI_HOST`. Ninguna clave va al repo.
- El dueño también programa en `~/ale`, con git local sin remoto. Por eso `llevar_a_pi.sh` no borra salvo con `--espejo`.

## Servicio `ale`

La unidad es `config/ale.service`, que se copia a `/etc/systemd/system/`. Los drop-ins van en `/etc/systemd/system/ale.service.d/`:

| Drop-in | Plantilla | Contenido |
|---|---|---|
| `pantalla.conf` | `config/pi/pantalla.conf` | `ALE_CARA_GIRO=180`: pantalla montada al revés |
| `audio-pipewire.conf` | `config/pi/audio-pipewire.conf` | `XDG_RUNTIME_DIR=/run/user/<uid>`, para alcanzar el PipeWire del usuario |
| `audio-bt.conf` | `config/pi/audio-bt.conf` | `ALE_BT_SALIDAS`, en orden de preferencia |

**`ale disabled`.** El dueño puede dejar el servicio deshabilitado para no gastar cuota de Meta, y esa decisión es suya: confirma el estado actual con `systemctl is-enabled ale`. `instalar_pi.sh` respeta `disabled`. Si Jolly duerme, `voz-hermes/grabaciones/dormido` lo mantiene dormido tras un reinicio, sin Muse ni micrófono. Por SSH: `ale-robot/jolly.sh dormir|despertar`.

## Pantalla

- MPI3508 por HDMI-A-1, en modo nativo **1280×720**. La cara dibuja en 480×320 lógicos y escala.
- No uses `video=` en `cmdline.txt`, ni pidas 480×320 a SDL: la pantalla queda negra.
- `ALE_CARA_GIRO=180` gira la cara. `fbcon=rotate:2` gira la consola.
- `/boot/firmware/cmdline.txt` y `config.txt`: ver `config/pi/arranque.md`.

## Táctil

XPT2046 por 6 cables a los pines 6, 19, 21, 22, 23 y 26, con el overlay `ads7846,cs=1,penirq=25`. `cara/tactil.py` lee el evdev directo y trae la calibración medida: los ejes van cruzados.

## Audio

- `/etc/asound.conf`, plantilla `config/pi/asound.conf`. La salida es PipeWire y el micrófono USB `Device` va directo. La copia previa queda en `/etc/asound.conf.antes-de-ale`.
- Paquetes: `pipewire`, `pipewire-alsa`, `wireplumber`, `libspa-0.2-bluetooth`.
- **Linger** del usuario, para que PipeWire viva sin sesión abierta: `sudo loginctl enable-linger <usuario>`.
- `XDG_RUNTIME_DIR` en el drop-in de `ale`. Sin él, el servicio no encuentra PipeWire.
- La cara corre con `SDL_AUDIODRIVER=dummy`: no abre el audio.

Para salida directa por HDMI, sin PipeWire: `ALE_AUDIO_TARJETA=vc4hdmi0 ./instalar_pi.sh`. Esa ruta no suena por Bluetooth.

## Bluetooth

`ale-robot/audio_bt.sh` arranca con `arrancar.sh` y conecta la primera salida disponible de `ALE_BT_SALIDAS`. Con una conectada no busca otra, porque buscar corta el audio. Sin ninguna, suena por HDMI.

El vínculo se hace una vez y se guarda en la Pi:

```bash
bluetoothctl pair <dirección>
bluetoothctl trust <dirección>
```

## Sin internet

La cara avisa con `cara/red.py`, y `arrancar.sh` espera a la red sin salir. `ALE_RED_DESTINO` cambia el destino que se comprueba.

## Reconstruir

```bash
ALE_CARA_GIRO=180 ALE_BT_SALIDAS="$ALE_BT_SALIDAS" ./instalar_pi.sh
```

Después aplica `config/pi/arranque.md`, reinicia y corre `./verificar.sh`.

## Comprobar

Solo lectura, en la Pi. No imprime direcciones Bluetooth:

```bash
systemctl is-enabled ale; systemctl is-active ale
systemctl cat ale | sed -E 's/(ALE_BT_SALIDAS=).*/\1…/'
cat /etc/asound.conf
loginctl show-user "$USER" -p Linger
grep -n ads7846 /boot/firmware/config.txt
grep -o 'fbcon=[^ ]*' /boot/firmware/cmdline.txt
head -1 /sys/class/drm/card*-HDMI-A-1/modes
```
