---
name: saleads-cli
description: "Leer datos de SaleADS desde la terminal con el CLI de SaleADS (contexto del negocio, ofertas, Meta, campañas, cajas, anuncios, resultados) gastando muy pocos tokens. Úsala cuando necesites datos de SaleADS y tengas la terminal."
version: 1.4.0
metadata:
  hermes:
    category: saleads-channels
    tags: [saleads, cli, terminal]
    requires_toolsets: [terminal]
  saleads:
    origin: saleads
    confidence: high
---

# CLI de SaleADS

- Invócalo así: `python3 /opt/data/skills/saleads-cli/scripts/saleads.py <comando> [opciones]`.
- Devuelve **una línea JSON**: `{"ok":true,"data":…}` o `{"ok":false,"code":…,"message":…,"next_action":…}`. Sigue `next_action` cuando venga.
- `ayuda` lista los comandos; `ayuda <comando>` o `esquema <comando>` dicen qué campos pide. Los alias están en `references/comandos.md`.
- Los argumentos van con `--campo clave valor` (el valor puede ser JSON) o, si son largos o complejos, en un archivo JSON con `--archivo /tmp/args.json` (escríbelo antes con `write_file`).
- La salida viene recortada; `--campos a,b` elige campos y `--completo` la trae entera.
- **Escrituras:** la salida trae `client_request_id`. Si una escritura falla o no responde, reintenta **solo** con `--id <ese valor>`; nunca la repitas sin `--id`.
- Lo que gasta o enciende campañas pide la aprobación del dueño en la web de SaleADS: el CLI no lo salta.
- Si sale `AUTH-EXPIRED`, espera unos minutos y reintenta; no busques ni copies el token.
