# saleads-sales-agent 1.5.1

## Cambio frente a 1.5.0 (AAB-024, laboratorio)

- **Formatos del canal del agente** (`skills/saleads-cli/references/formatos.md`): ejemplos exactos de la apuesta
  (`agent-bet.v1`), la pieza maestra y su variación (`master_ref = {job_id, image_index}`), la subida de una pieza a
  Meta y el árbol de campaña en objetos de Graph. Son los que pasaron por la Agent API y Meta en dev el 2026-11-03. En
  la primera tanda del laboratorio Ale inventaba esas formas (`budget`, `audience`, `format`) y fallaba 30-65 de cada
  100 llamadas.
- Regla 8 del CLI: ante `MCP-E-INVALID-INPUT`, corregir exactamente los campos de `details.fields` y volver a llamar.
- `version:` de todos los `SKILL.md` = 1.5.1. Sin cambios de permisos, skills ni `jobs.json`.

## 1.5.0

## Cambio frente a 1.4.0 (ola saleads-api-agencial-v1, AAB-023)

- **Camino del agente por CLI.** `saleads-loop-orchestration` deja el flujo de estrategia, plan y borrador de la web:
  Ale registra apuestas (`saleads apuestas registrar`), cotiza y genera piezas, publica la campaña en pausa
  (`saleads campana publicar`), pide el encendido por campaña (`saleads encendido pedir`), lee por caja
  (`saleads cajas leer`), optimiza con el espejo (`saleads espejo`) y cuenta con la traza (`saleads traza`). Si un
  comando no existe, avisa al dueño y no improvisa con la web. La sección «En cada vuelta de saleads:loop-tick»
  termina con `brain_snapshot_flush` (AAB-013, D27).
- **Permisos D13/D21/D23** en el SOUL y en todas las skills: crear en pausa, pausar y mover presupuesto dentro del
  presupuesto mensual aprobado lo hace Ale y lo cuenta; encender, borrar o pasarse lo aprueba el dueño con un botón en
  el panel de SaleADS, sin código. Las advertencias del jurado son información (D29).
- **CLI 1.1.0** (`skills/saleads-cli/`): alias de dos palabras para los 13 comandos `saleads_agent_*`, catálogo por
  fase en `references/comandos.md` y reglas cortas (`--id` en escrituras, `--archivo`, `APPROVAL_REQUIRED` = enlace
  al dueño, el error de Meta se lee y se corrige).
- **Skill nueva** `skills/functions/saleads-estructura-optimizacion-juan/` (estructurador y optimizador): criterios
  de Juan Diego Libreros con su porqué y sus señales, nunca plantillas ni números obligatorios, siempre dentro del
  presupuesto aprobado. `saleads-optimization-scaling` remite a ella.
- `saleads-prepare-approved-work` queda solo para el plan de la web que pida el dueño.
- Profiles de estructurador y optimizador: nombran la skill nueva y dicen que Ale ejecuta con el CLI.
- `version:` de todos los `SKILL.md` = 1.5.0 (la versión que cuenta en la traza es `saleads-sales-agent@1.5.0`).
- `validate.py` falla si no encuentra ninguna skill.
- `jobs.json` sin cambios.

## Antes (1.4.0, AAB-005)

- Skill `skills/saleads-cli/` con solo lecturas.

## Base (1.3.0)

Propósito (`SOUL.md`), skills y trabajos programados de **Ale**, el experto en
marketing de bolsillo de SaleADS (ola `saleads-agente-marketing-loop-v1`). Son
textos de instrucciones para el Hermes oficial; no contienen lógica de SaleADS.

## Contenido

- `SOUL.md`: Ale orquesta a cinco especialistas y es el único que habla con el
  dueño. Los datos del negocio salen solo de SaleADS (CLI); internet
  (`web_buscar`, `web_leer`) solo para investigar el mercado. Encender, borrar o
  pasarse del presupuesto aprobado lo aprueba el dueño en el panel de SaleADS.
- `skills/` (primer nivel, siempre instaladas): las 18 de 1.2.0 más
  `saleads-loop-orchestration` (fases, reparto, Jev, tarjetas, escrituras del
  cerebro).
- `skills/functions/`: skills de los especialistas, siempre instaladas:
  `saleads-market-research`, `saleads-reading-diagnosis`,
  `saleads-optimization-scaling` (MLB-004).
- `skills/types/<business_type>/`: la estrategia de cada tipo de negocio
  (`physical_product`, `service`, `infoproduct`). El servicio instala solo los
  tipos que el dueño confirmó en sus negocios (la unión, si tiene varios); sin
  ningún tipo confirmado, ninguno (MLB-003).
- `jobs.json`: los 7 trabajos de 1.2.0 más `saleads:loop-tick` (cada 3 h: lee el
  tablero y responde `[SILENT]` o un solo mensaje).
- `validate.py`: valida skills (en cualquier nivel, nombres únicos) y trabajos
  con el parser y el scanner de Hermes.

## Destino en la VM

- `SOUL.md` → `/opt/data/SOUL.md`
- `skills/...` → `/opt/data/skills/...` con la misma ruta (Hermes encuentra las
  skills anidadas).
- `jobs.json` no se copia: el servicio crea por nombre los trabajos que falten.

## Trabajos de 1.2.0

Se conservan los 7 y sus skills: el servicio nunca edita ni borra trabajos
(`orqa-sync.ts`), así que una VM que ya los tenía los sigue corriendo, y borrar
una skill que un trabajo carga lo rompería. `saleads:proactive-digest` y
`saleads:loop-tick` conviven: el primero resume el día, el segundo mueve el
loop y casi siempre responde `[SILENT]`. Si la prueba de varios días (D48)
muestra ruido, se retira el resumen en una versión siguiente.

## Validación

```bash
python validate.py <checkout de hermes-agent a28a5d03a9>
```

Necesita `ruamel.yaml`, `croniter`, `pyyaml` y `python-dotenv`.
