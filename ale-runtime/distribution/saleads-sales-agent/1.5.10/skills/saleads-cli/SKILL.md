---
name: saleads-cli
description: "El CLI de SaleADS en la terminal: leer el negocio y las cajas, registrar apuestas, cotizar y generar piezas, publicar campañas en pausa, pedir el encendido, pausar o mover presupuesto dentro de lo aprobado y leer la traza. Solo Ale (necesita terminal). Úsala siempre que vayas a leer o escribir en SaleADS."
version: 1.5.10
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

- `saleads <alias> [opciones]`. Si la terminal dice que `saleads` no existe, llama una vez con la ruta larga, `python3 /opt/data/skills/saleads-cli/scripts/saleads.py <alias> [opciones]`: esa llamada deja instalado el atajo `saleads` para las siguientes.
- Devuelve **una línea JSON**: `{"ok":true,"data":…}` o `{"ok":false,"code":…,"message":…,"next_action":…}`. Sigue `next_action` cuando venga.
- `ayuda` lista los comandos; `ayuda <alias>` o `<alias> --help` dicen qué campos pide (igual que `esquema <alias>`). Un campo corto va con `--campo clave valor` o, si el comando lo tiene, `--clave valor` (`--business_id`, `--bet_id`, `--state`…). Los alias por fase están en `references/comandos.md` y la forma exacta de apuestas, piezas y árboles en `references/formatos.md`.
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
9. **Tope de créditos.** Antes de generar, `piezas cotizar` (o `piezas preparar`) te dice `cap_status`. Si es `not_set`
   o `short` (o generar responde `MCP-E-AGENT-CREDIT-CAP`), insistir no lo cambia: pídeselo al dueño **en el mismo
   mensaje en que le cuentas la vuelta**, con cuánto cuesta, para qué y el enlace `limits_url` (o `action_url`; ya
   lleva el mínimo, y en su idioma si usaste `--idioma`). Sigue con lo que no gasta créditos (apuestas, lectura,
   medios propios del dueño). **En cada vuelta vuelve a leer el tope** (`saleads limites`, que no crea cotizaciones):
   en cuanto esté, genera sin esperar a que el dueño te avise. Si en la vuelta siguiente sigue sin tope, recuérdaselo
   una sola vez más, junto con lo que ya está listo.
10. **Si un comando no existe** (`MCP-E-UNKNOWN-COMMAND`) o la salida 4 se repite, avísale al dueño qué no pudiste hacer. No improvises con el flujo de la web ni con `curl`.
11. **`piezas preparar` tarda de 1 a 3 minutos.** Llama la terminal con `timeout=300` y `--esperar 240`. Sin eso, el
    CLI espera 150 s (la terminal corta a los 180 s). Si vuelve `estado: generando`, repite el mismo comando con el
    mismo `--id`: retoma sin cobrar dos veces.
12. **Idioma del dueño.** Los enlaces de SaleADS salen en el idioma que pidas: `saleads web --idioma en` (o `es`, el de
    USER.md). El CLI recuerda el último `--idioma` y lo pasa solo al pedir el encendido, al espejo y a los comandos que
    arman el enlace de Límites (`limites`, `piezas cotizar`, `piezas preparar`); nunca a `apuestas registrar`, donde
    `locale` es el idioma de las apuestas.
