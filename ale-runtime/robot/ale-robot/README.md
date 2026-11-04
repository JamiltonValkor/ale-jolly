# Jolly: el robot de Ale Runtime, de cero a conversando

Jolly es el compañero físico de quien emprende solo. El backend es Ale Runtime (este repositorio); en `robot/` vive su cuerpo. Hoy se prueba en un Mac con `ale_mac.sh` y su destino es una Raspberry Pi 5:
- **oído**: micrófono USB + Muse Voice Transcribe;
- **voz**: Cartesia;
- **cara**: pantalla MPI3508 táctil, modo nativo 1280×720 por HDMI (la cara dibuja en 480×320 lógicos);
- **brazos**: SG90 por Arduino, opcionales.

El robot se vincula con SaleADS desde la cara: muestra un código o QR, lo escaneas desde SaleADS y queda emparejado.

```
robot/ (este repo)           Raspberry Pi 5 (~/ale)
  voz-hermes/   ──rsync──►    oído + canal robot + voz + director del cuerpo
  cara/         ──rsync──►    cara (pygame, KMS, pantalla completa)
  brazos/       ──rsync──►    brazos (si hay Arduino)
  ale-robot/    ──rsync──►    instalador, arranque, servicio, verificación
```

Audio y voz corren en el robot; a ale-runtime solo va texto, por `/devices/*`.

## Probar en el Mac (sin Raspberry)
1. Crea `voz-hermes/.env` desde `ale-robot/config/env.ejemplo`, con tus keys y `ALE_RUNTIME_URL`.
2. Crea los entornos `.venv` de `voz-hermes/` y `cara/`.
3. Corre `ale-robot/ale_mac.sh`: la ventana muestra el código, igual que la pantalla del robot.

## 1. Preparar la tarjeta SD (una vez)
1. Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit, Trixie)**.
2. En las opciones: nombre de equipo `ale`, tu usuario, el Wi-Fi y **SSH activado**.
3. Conecta la pantalla por HDMI, el micrófono USB y el audio (salida de la pantalla o tarjeta USB hacia tu amplificador). Enciéndela.

## 2. Llevar el código desde el Mac
```bash
cd robot/ale-robot
./llevar_a_pi.sh tu_usuario@ale.local --instalar
```
- Copia voz, cara, brazos y este proyecto a `~/ale` en la Pi, sin `.venv`, grabaciones ni las voces Piper. No borra nada allá; `--espejo` sí, tras mostrar la lista y pedir confirmación.
- Arma el `.env` del robot **solo** con `META_API_KEY`, `CARTESIA_API_KEY` y `ALE_RUNTIME_URL`. Tu login web de SaleADS no viaja.
- `--instalar` corre `instalar_pi.sh` allá, que hace esto:
  - paquetes del sistema y `uv`;
  - entornos de Python;
  - el audio y el arranque sin escritorio;
  - el servicio `ale`.

## 3. Verificar y arrancar (en la Pi)
```bash
ssh tu_usuario@ale.local
cd ~/ale/ale-robot && ./verificar.sh          # sin ruido; ./verificar.sh --sonido para probar el parlante
sudo reboot                                    # aplica grupos y arranque; Jolly arranca solo
```

## 4. Vincular a tu compañero
1. Al arrancar sin credencial, la cara muestra un código como `K7QM-3XPA`, y un QR si `ROBOT_CLAIM_URL` está configurada.
2. En SaleADS, en la página del agente, entra a **Vincular mi compañero** y escribe el código, o escanea el QR.
3. En unos segundos Jolly dice que ya está vinculado. La credencial queda en `~/ale/voz-hermes/.env`, así que no hay que repetirlo.
4. Si lo desvinculas en SaleADS, el robot vuelve a mostrar un código.

Di **"Jolly, …"** (también lo entiende como "Yoli", "Jóli", "Yolly"…). Después de cada respuesta tienes 20 s para seguir sin repetir el nombre. Habla en español o en inglés.

## Día a día
| Para | Comando (en la Pi) |
|---|---|
| Ver lo que pasa | `journalctl -u ale -f` |
| Reiniciar | `sudo systemctl restart ale` |
| Parar | `sudo systemctl stop ale` |
| Correr a mano | `sudo systemctl stop ale && ~/ale/ale-robot/arrancar.sh` |
| Solo voz (sin cara) | `ALE_SIN_CARA=1 ~/ale/ale-robot/arrancar.sh` |
| Actualizar el código | (en el Mac) `./llevar_a_pi.sh tu_usuario@ale.local` y luego `sudo systemctl restart ale` |

Lo que vive fuera de `~/ale` (audio, systemd, arranque, Bluetooth, Tailscale) está en [PI.md](PI.md).

## Problemas comunes
- **No suena**: `aplay -l` muestra las tarjetas. Elige la correcta con `ALE_AUDIO_TARJETA=<n> ./instalar_pi.sh`. La Pi 5 no tiene jack: usa el audio HDMI de la pantalla o una tarjeta USB.
- **La pantalla no muestra nada**: `ALE_SIN_CARA=1` descarta la cara; la cara usa el modo nativo de la pantalla, no fuerces `video=` en `cmdline.txt`.
- **"ale-runtime no responde"**: revisa `ALE_RUNTIME_URL` en `~/ale/voz-hermes/.env`.
- **"el canal robot no responde"**: el backend necesita `ROBOT_CHANNEL_ENABLED=true` y la migración V18.

## Seguridad
- El `.env` del robot (modo 600) tiene las keys de Meta y Cartesia y la credencial del robot. No lo subas a ningún repo.
- La credencial del robot solo sirve para hablar por su canal; no abre la cuenta de SaleADS. Se revoca desde SaleADS.
