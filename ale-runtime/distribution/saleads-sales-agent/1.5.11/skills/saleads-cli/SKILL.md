---
name: saleads-cli
description: "Use the SaleADS CLI for scoped business reads and separately authorized commercial operations; only Ale has a terminal."
version: 1.5.11
metadata:
  hermes:
    category: saleads-channels
    tags: [saleads, cli, terminal]
    requires_toolsets: [terminal]
  saleads:
    origin: saleads
    confidence: high
---

# SaleADS CLI — Ale only
Specialists have no terminal; they return proposals in native cards. First-loop proposal-only scope permits reads only; do not use this manual as commercial authorization.

## Invocation
saleads <alias> [options]. If absent, call python3 /opt/data/skills/saleads-cli/scripts/saleads.py once to install the existing shortcut. Output is one JSON line with ok/data or code/message/next_action. Use ayuda, ayuda <alias>, <alias> --help or esquema <alias> for live schemas. Stable Spanish commands/options are contractual identifiers, not a response-language policy. Read references/comandos.md and references/formatos.md. --campos selects fields; --completo avoids truncation.

## Rules
1. Mutations use --id. On lost acknowledgment inspect traza/op/state and retry the same request only with the same client_request_id. Never blindly duplicate a write.
2. Complex arguments use --archivo with JSON written inside /opt/data/trabajo/ or the server-provided work workspace under /opt/data. Do not write outside the permitted data home or reuse a stale file after a write failure. Short values use --campo or schema-supported --<field>.
3. APPROVAL_REQUIRED or MCP-E-AGENT-APPROVAL-REQUIRED means send the real approval link with object/audience/amount and wait, not bypass it.
4. Read actual details.meta_error and correct the named fields. A rejected corrected request is a new --id; uncertain success must be read before retry.
5. campana publicar is asynchronous: use --esperar 120 or later op with operation_id.
6. Exit0 success;2 usage;3 denied;4 transient;5 AUTH-EXPIRED. Read the code; do not repeat denied requests unchanged or copy/search tokens. Hermes/SaleADS own refresh.
7. Follow reference schemas; MCP-E-INVALID-INPUT requires correcting exactly details.fields, not invented fields.
8. The CLI remembers the last successful business_id and adapts it to each command schema. In multi-work contexts always supply this work's explicit business_id; do not rely on another work's cache.
9. Quote cap_status not_set/short or MCP-E-AGENT-CREDIT-CAP is not solved by repeated generation. Ask once in the useful round summary with exact cost/purpose and limits_url/action_url, then continue permitted non-credit work. Re-read saleads limites each round and resume when a verified cap allows it; if still missing remind once more, not endlessly. Credits are not media spend.
10. Unknown commands or repeated transient failures are explicit limitations; no curl/internal-route or classic-web workaround.
11. piezas preparar retains1.5.10 behavior: quote→generate within cap→wait→upload, returning image_hash/media_ref. Use terminal timeout=300 and --esperar 240 (default150s vs terminal180s). estado=generando resumes with the same --id without double charging. Only in authorized commercial scope.
12. Use response_locale via saleads web --idioma es|en. The remembered locale applies only to supported activation/mirror/limits/quote fields, never bets where locale means bet-content language. Returned classic links are not a license to invent a Meta Assistant route.
