---
name: saleads-connect-channel
description: "Conectar un canal para que el dueño hable contigo (Telegram con el token del bot; WhatsApp con QR): qué pedirle, cómo guardar el token con la CLI de Hermes sin repetirlo, cómo queda activo y cómo se prueba. Úsala cuando el dueño diga que quiere hablarte por Telegram u otro canal, o pregunte por qué no le respondes allá."
version: 1.5.9
metadata:
  hermes:
    category: saleads-channels
    tags: [saleads, telegram, channels, gateway]
  saleads:
    origin: saleads
    confidence: high
---

# Conectar un canal

Hermes ya trae el gateway de mensajería: no instales ni reinstales nada. La CLI está en `/opt/hermes/bin/hermes` (úsala con esa ruta en la terminal). El asistente interactivo `hermes gateway setup` no sirve desde un chat: usa los comandos de abajo.

## Telegram

1. **Pídele al dueño dos cosas**, en lenguaje simple:
   - El token de su bot: en Telegram abre **@BotFather**, envía `/newbot` (o `/token` si ya tiene uno) y copia el token que le da.
   - Su número de usuario: escríbele a **@userinfobot** y copia el número `Id`.
2. **Guarda los dos valores** con la terminal (nunca los repitas en tu respuesta ni los escribas en memoria):
   ```
   /opt/hermes/bin/hermes config set TELEGRAM_BOT_TOKEN <token>
   /opt/hermes/bin/hermes config set TELEGRAM_ALLOWED_USERS <id>
   ```
   Cada comando responde `Set ... in /opt/data/.env`.
3. **Se activa solo, sin reiniciar:** Hermes toma el canal en caliente. Dile al dueño que le escriba `/start` o «hola» a su bot. Si el bot le responde que no lo reconoce y le da un código de emparejamiento, el dueño te pega ese código y tú lo apruebas:
   ```
   /opt/hermes/bin/hermes pairing approve telegram <código>
   ```
   Último recurso, solo si tras un minuto el bot no responde nada: `/opt/hermes/bin/hermes gateway restart` (corta la conversación un minuto; avísale antes).
4. **Canal de inicio:** cuando el dueño te escriba por Telegram, pídele que envíe `/sethome` en ese chat; ahí llegarán tus avisos (propuestas listas, veredictos, aprobaciones pendientes).
5. **Si no responde:** el token pudo quedar mal copiado. Pídele que lo vuelva a copiar de @BotFather y repite el paso 2. Nunca le pidas que ejecute comandos.

La conexión queda guardada: si el asistente se recrea, el canal vuelve conectado.

## WhatsApp (con QR)

**Siempre este procedimiento, sin excepción.** No pongas variables `WHATSAPP_*` a mano (sin escanear el QR, WhatsApp no queda vinculado), no uses Cloud API y no busques en la documentación ni en internet: los pasos están aquí y funcionan.

Se vincula el WhatsApp del dueño escaneando un QR, como WhatsApp Web. No hace falta Meta, ni WhatsApp Business, ni tokens. El ayudante usa el puente oficial de Hermes:

```
cd /opt/hermes && PYTHONPATH=/opt/hermes /opt/hermes/.venv/bin/python3 /opt/data/skills/saleads-connect-channel/scripts/whatsapp_link.py <start|qr|finish|status>
```

1. **Prepara al dueño:** «Abre WhatsApp en tu teléfono → Ajustes (o los tres puntos) → Dispositivos vinculados → Vincular dispositivo. Cuando tengas la cámara lista, dime "listo".» Mientras tanto corre `start`.
2. **Cuando diga "listo":** corre `qr` y pega en tu respuesta, sin cambiar ni un carácter, el bloque `whatsapp-qr` que imprime. La web lo muestra como un código QR. Dile: «Escanéalo ahora; si vence, dime "otro"».
3. **Si dice "otro" o que no funcionó:** corre `qr` otra vez y pega el bloque nuevo (WhatsApp cambia el código cada pocos segundos).
4. **Cuando diga que ya escaneó:** corre `finish`. Si responde ACTIVADO, dile que te escriba en su chat «Tú» de WhatsApp (mensajes a sí mismo). Si en un minuto no le respondes por WhatsApp, avísale y corre `/opt/hermes/bin/hermes gateway restart` como último recurso. Si dice que aún no está vinculado, pídele que lo vuelva a escanear (paso 3).

La vinculación queda guardada: si el asistente se recrea, WhatsApp vuelve conectado. Nunca inventes otros pasos ni menús de SaleADS.

## Otros canales

Discord o Slack: no hay procedimiento probado todavía. Dilo y ofrece Telegram.
