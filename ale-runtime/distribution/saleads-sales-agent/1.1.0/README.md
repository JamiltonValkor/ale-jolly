# saleads-sales-agent 1.1.0

Propósito (`SOUL.md`) y 5 skills del asistente de ventas SaleADS para la ola
`saleads-hermes-one-click-mvp-v1` (ADR0028). Son textos de instrucciones para
el Hermes oficial; no contienen lógica de SaleADS.

## Contenido

- `SOUL.md`
- `skills/saleads-business-orientation/`
- `skills/saleads-daily-summary/`
- `skills/saleads-human-decisions/`
- `skills/saleads-operating-review/`
- `skills/saleads-prepare-approved-work/`

Cada skill tiene `SKILL.md` (frontmatter `name`/`description`) y su carpeta
`references/`.

## Destino en la VM

- `SOUL.md` → `/opt/data/SOUL.md`
- `skills/<nombre>/...` → `/opt/data/skills/<nombre>/...`

## Serialización

El servicio publica `SOUL.md` en la clave de metadata `hermes-soul` y las skills
en `hermes-skills`, como JSON `{ruta_relativa: contenido}` con rutas relativas a
`skills/` (por ejemplo `saleads-human-decisions/SKILL.md`). La consume el
watcher de OCB-005. Este `README.md` no se publica en la VM.

## Cambios frente a 1.0.0

- El asistente gestiona todos los negocios del dueño: los lista con
  `saleads_get_account_overview` y cambia con `saleads_select_business`.
- Usa primero las tools `mcp__saleads__*` para datos del negocio, antes que
  terminal, ejecución de código o búsqueda web.
- Cada cambio se muestra antes y espera el «sí» explícito del dueño en el chat;
  una confirmación vale para un solo cambio. Lanzar y reanudar siguen solo en la
  web.
- Memoria, recordatorios, tareas y canales nativos de Hermes quedan encendidos.
- Sin manifest firmado, hashes, SBOM ni archivos de procedencia (ADR0028).
- Se conservan literales las reglas de no inventar prueba, de lanzar/reanudar
  solo por la web y de no pedir keys en el chat.
