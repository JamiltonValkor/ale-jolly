---
name: saleads-connect-channel
description: "Connect an owner-requested Telegram bot or WhatsApp QR using the existing official Hermes gateway without exposing secrets."
version: 1.5.11
metadata:
  hermes:
    category: saleads-channels
    tags: [saleads, telegram, channels, gateway]
  saleads:
    origin: saleads
    confidence: high
---

# Connect a channel
Only when the owner asks. Hermes is installed; do not reinstall. Use /opt/hermes/bin/hermes, not interactive gateway setup from chat. Respond in response_locale.

## Telegram
1. Ask for the bot token from @BotFather /newbot or /token, and allowed user numeric Id from @userinfobot. Never repeat or memorize either credential.
2. Set with terminal: /opt/hermes/bin/hermes config set TELEGRAM_BOT_TOKEN <token>, then /opt/hermes/bin/hermes config set TELEGRAM_ALLOWED_USERS <id>. Hermes writes the existing .env; do not print it.
3. Hermes picks up the channel without restart. Ask the owner to send /start or hello to their bot. If pairing is requested, approve only the provided code with /opt/hermes/bin/hermes pairing approve telegram <code>.
4. Ask for /sethome in that Telegram chat for useful notifications. If no response after about a minute, warn before a last-resort /opt/hermes/bin/hermes gateway restart, which interrupts conversation briefly.
5. A badly copied token may require copying it again from BotFather and repeating the config step. Do not ask the owner to run commands. Saved channel settings survive the supported assistant restore.

## WhatsApp QR
Use only the existing official Hermes bridge procedure. No hand-written WHATSAPP_* config, Cloud API or web-search alternative.
Command: cd /opt/hermes && PYTHONPATH=/opt/hermes /opt/hermes/.venv/bin/python3 /opt/data/skills/saleads-connect-channel/scripts/whatsapp_link.py <start|qr|finish|status>
1. Ask the owner to open WhatsApp → Settings/menu → Linked devices → Link a device and say when the camera is ready; run start.
2. When ready run qr and reproduce the complete whatsapp-qr block without altering characters. Ask them to scan now and request another if expired.
3. If needed run qr again and use the new block; QR rotates quickly.
4. After the owner confirms scanning, run finish. ACTIVADO is a stable helper status: ask them to write in their WhatsApp self-chat. If no response within a minute, warn and use gateway restart only as last resort. If not linked, repeat QR scanning.
Linking uses the owner's WhatsApp like WhatsApp Web, without separate Meta Ads credentials. Restore preserves the supported session. Never invent SaleADS menus.
Discord/Slack have no verified procedure in this bundle; state that and offer Telegram.
