---
name: saleads-cli
description: "El CLI de SaleADS en la terminal: leer el negocio y las cajas, registrar apuestas, cotizar y generar piezas, publicar campañas en pausa, pedir el encendido, pausar o mover presupuesto dentro de lo aprobado y leer la traza. Solo Ale (necesita terminal). Úsala siempre que vayas a leer o escribir en SaleADS."
version: 1.5.5
metadata:
  hermes:
    category: saleads-channels
    tags: [saleads, cli, terminal]
    requires_toolsets: [terminal]
  saleads:
    origin: saleads
    confidence: high
---

# CLI de SaleADS (solo Ale)

Los especialistas no tienen terminal: esta skill es solo tuya. Ellos proponen en la tarjeta y tú ejecutas.

## Cómo se llama

- `python3 /opt/data/skills/saleads-cli/scripts/saleads.py <alias> [opciones]`. En las skills se escribe corto: `saleads apuestas registrar …` significa `python3 /opt/data/skills/saleads-cli/scripts/saleads.py apuestas registrar …`.
- Devuelve **una línea JSON**: `{"ok":true,"data":…}` o `{"ok":false,"code":…,"message":…,"next_action":…}`. Sigue `next_action` cuando venga.
- `ayuda` lista los comandos; `esquema <alias>` dice qué campos pide. Los alias por fase están en `references/comandos.md` y la forma exacta de apuestas, piezas y árboles en `references/formatos.md`.
- La salida viene recortada; `--campos a,b` elige campos y `--completo` la trae entera.

## Reglas cortas

1. **Escrituras siempre con `--id`.** La primera vez el CLI genera el `client_request_id` y lo devuelve; si la escritura falla o no responde, consulta el estado (`traza`, `op`) y repite **solo** con `--id <ese valor>`. Nunca repitas una escritura sin `--id`: podrías crear dos veces lo mismo.
2. **Argumentos complejos por `--archivo`.** Apuestas, árboles de campaña y pedidos de pieza van en un JSON que escribes antes con `write_file` **dentro de `/opt/data/trabajo/`** (`--archivo /opt/data/trabajo/arbol.json`). Hermes solo deja escribir dentro de `/opt/data`: en `/tmp` la escritura se niega y el comando usaría un archivo viejo o ninguno. `--campo clave valor` es para valores cortos.
3. **`APPROVAL_REQUIRED` (o `MCP-E-AGENT-APPROVAL-REQUIRED`) significa «mandar el enlace al dueño».** No es un error: la acción pide su botón en el panel de SaleADS. Le mandas el enlace con qué se hace, a quién y cuánto, y esperas.
4. **El error de Meta se lee y se corrige.** Viene tal cual en `details.meta_error`: lee el mensaje, ajusta el árbol o el campo que Meta señala y vuelve a publicar con un `--id` nuevo (es otro pedido). No inventes un motivo distinto del que dice Meta.
5. **Lo asíncrono se espera:** `campana publicar` devuelve `operation_id`; usa `--esperar 120` o léelo después con `op`.
6. **Salidas:** 0 bien; 2 uso (revisa el comando); 3 negado (no reintentes igual: lee `code`); 4 transitorio (reintenta más tarde con el mismo `--id`); 5 sesión vencida (`AUTH-EXPIRED`: espera unos minutos y reintenta; no busques ni copies el token).
7. **Formatos:** antes de escribir una apuesta, una pieza, una subida o un árbol de campaña, abre
   `references/formatos.md` y copia su forma. Si la respuesta es `MCP-E-INVALID-INPUT`, corrige **exactamente** los
   campos de `details.fields` y vuelve a llamar; no cambies otra cosa ni inventes campos.
8. **El negocio lo pone el CLI.** Después de la primera llamada con `business_id`, el CLI lo recuerda: lo agrega en los comandos
   que lo piden y lo quita en los que no lo admiten. Pásalo solo si trabajas con otro negocio.
9. **Tope de créditos (`MCP-E-AGENT-CREDIT-CAP`).** Si dice que el dueño no lo ha fijado (`CAP_NOT_SET`), o que ya no
   alcanza, insistir no lo cambia. Pídeselo al dueño **una vez**, con cuánto cuesta lo que querías generar y
   para qué, y sigue con lo que no gasta créditos (apuestas, lectura, medios propios del dueño) hasta que te avise.
10. **Si un comando no existe** (`MCP-E-UNKNOWN-COMMAND`) o la salida 4 se repite, avísale al dueño qué no pudiste hacer. No improvises con el flujo de la web ni con `curl`.
