# saleads-sales-agent 1.5.9

## Cambio frente a 1.5.8 (arreglos sin decisión de negocio, cierre del MVP, 2026-11-03)

Insumo: análisis de la corrida completa 1 (`docs/tasks/saleads-api-agencial-v1/pruebas/analisis-corrida-completa-1/`).

- **CLI 1.5.0:**
  - si la salida recorta una lista, la respuesta trae `recortado` con el aviso de no sumar;
  - `totals`, `budget` y `projection` nunca se recortan (Paola recibió «TOTAL 2.557» contra 3.306 reales);
  - `saleads web` da las direcciones reales de SaleADS (Hernán recibió `saleads.app`, inventada).
- **SOUL:**
  - el manual es de solo lectura (D4 del owner; se suma `skills.write_approval: true` en la config de Hermes);
  - píxel y cuenta con `saleads meta` antes de pedirle nada técnico al dueño;
  - la regla del enlace de subida ahora vive en el SOUL (Laura recibió Drive/WeTransfer).
- `version:` de todos los `SKILL.md` = 1.5.9.

## Cambio frente a 1.5.7 (corrida corta 4 con usuarios simulados, 2026-11-01)

- **Reemplazar una campaña:** primero se pausa la vieja y después se pide el encendido de la nueva. Lo que se le
  promete al dueño se hace antes de pedirle que apruebe. Con Mike quedaron v1 y v2 encendidas: 5.400 US$/mes contra
  3.000 aprobados.
- **Nunca publicar dos veces la misma campaña:** los cambios van con el espejo. Para sumar anuncios a una campaña que
  corre: una v2, se pausa la v1 y se pide el encendido. Hoy un anuncio creado por el espejo nace en pausa y no hay
  aprobación para encenderlo (hueco de producto anotado). Con Mike, la v1 se publicó 4 veces.
- **Pantalla real de límites en el SOUL:** «Mi asistente» → «Límites» (`?tab=limits`), con «Presupuesto mensual
  aprobado» («Monto mensual») y «Tope mensual de créditos» («Créditos al mes»). Ale mandaba a Ajustes, Facturación y
  Preferencias.
- `op` va con el `operation_id` de `campana publicar`, no con el `publication_id`.
- `version:` de todos los `SKILL.md` = 1.5.8.

## Cambio frente a 1.5.6 (corrida corta 3 con usuarios simulados, 2026-10-28)

Resultado de la corta 3: 3 de 3 publicaron y 2 de 3 encendieron. Funcionaron la moneda (133 MXN/día), el enlace de
subida y no declarar ganadora antes de tiempo.

- **Idioma y trato del dueño en USER.md:** Ale nunca anotó que Mike habla inglés y los avisos del loop-tick salían en
  español y con voseo. Ahora lo anota la primera vez, y todo mensaje, también los automáticos, va en ese idioma.
- **Encendido pendiente y presupuesto cambiado:** si cambia el presupuesto de una publicación con el encendido
  pendiente, vuelve a pedirlo; el pedido nuevo reemplaza al anterior. Con Paola, el panel mostraba 333/día y Ale
  decía 133.
- **SOUL:** nunca atribuirle al dueño algo que no dijo. Los créditos no son dinero de pauta: si el dueño los confunde,
  se le aclara.
- **Estratega:** en la primera vuelta, apuestas a compradores distintos, no solo ángulos distintos para el mismo.
- `version:` de todos los `SKILL.md` = 1.5.7.

## Cambio frente a 1.5.5 (corrida corta 2 con usuarios simulados, 2026-10-29)

- **Moneda:** tabla en `formatos.md` §5. COP, CLP y JPY van tal cual; MXN, USD y EUR ×100. Con Paola (MXN), Ale mandó
  `daily_budget: 45` creyendo que eran pesos y quedó en 0,45 MXN al día.
- **Archivos del dueño:** primero por el mismo chat (WhatsApp o Telegram); si no, un enlace de subida por archivo
  (`medios subir signed_url`) ofrecido de entrada. Nada de «carpeta compartida».
- **Loop-tick:** antes de escribir, Ale lee su memoria (idioma del dueño y lo que ya respondió). A Mike le escribió en
  español y le volvió a pedir la calidad de los leads.
- **SOUL, con datos y no con ganas:** ninguna caja es «ganadora» sin el gasto mínimo, y Ale no repite un número
  equivocado del dueño.
- `version:` de todos los `SKILL.md` = 1.5.6.

## Cambio frente a 1.5.4 (corrida corta 1 con usuarios simulados, 2026-10-29)

- **CLI 1.4.0, argumentos según el esquema del comando:**
  - `client_request_id` cuando el comando lo pide, aunque sea de lectura. En dev, cotizar es `readOnlyHint` y lo exige.
  - Sin negocio recordado, toma el seleccionado de la cuenta (`saleads_get_account_overview`).
  - Un valor suelto (`saleads op <id>`) llena el único obligatorio que falte; antes se ignoraba.
  - Campos que no existen: se quitan en lecturas y se rechazan en escrituras. Obligatorios que faltan y valores fuera
    de la lista se explican antes de llamar.
  - Generar usa siempre el id de la cotización, aunque Ale pase otro `--id`.
- **SOUL:**
  - con el dueño, sin tecnicismos («brain», tarjetas, ids, «perfil 70 %»);
  - lo técnico se pide diciendo para qué sirve;
  - ningún plan que dependa de material que el dueño no tiene.
- **`comandos.md`:**
  - ejemplos de `op`, `piezas ver`, `apuestas estado` y `guia`, con los valores fijos;
  - `daily_budget` en la unidad menor de la moneda (en COP son pesos, no centavos).
- `version:` de todos los `SKILL.md` = 1.5.5.

## Cambio frente a 1.5.3

- **CLI 1.3.0: generar reutiliza el `client_request_id` de la cotización.** SaleADS ata la cotización a ese id
  (la operación de suscripción se deriva de negocio + id); generar con uno nuevo daba `QUOTE_CONTENT_MISMATCH` en dev.
  Lo encontró la sesión del laboratorio con usuarios simulados al alinear el simulador con dev.
- `version:` de todos los `SKILL.md` = 1.5.4.

## Cambio frente a 1.5.2 (AAB-024, plan de correcciones del 2026-10-27)

- **Archivos de trabajo en `/opt/data/trabajo/`:** Hermes solo deja escribir dentro de `/opt/data`
  (`HERMES_WRITE_SAFE_ROOT`, igual en la VM real). Con `/tmp`, el `write_file` se negaba, el comando leía un archivo
  viejo o ninguno, y Ale terminó publicando dos veces la misma campaña.
- **Una publicación por apuesta en la vuelta:** si no se sabe si quedó, primero `op` o `traza`.
- **Encendido con `publication_id`** (formato 6 en `references/formatos.md`): Ale lo pedía con el id de la campaña.
- **Evidencia consultiva** (decisión del owner): si la mejor apuesta necesita testimonios, autoridad o resultados,
  Ale no la descarta. Se la propone al dueño y le pide la prueba (capturas de chats, reseñas, fotos); con eso arma
  los testimonios reales. Nunca la inventa. Cambia el SOUL, el estratega y las skills de los tres tipos.
- **Servicio con el método de Juan Diego Libreros** (owner: Juan es para producto físico y servicio; infoproducto
  sigue con el lanzamiento en 4 fases).
- `version:` de todos los `SKILL.md` = 1.5.3.

## Cambio frente a 1.5.1 (AAB-024, laboratorio con V4 Flash, 2026-10-31)

Con 1.5.1, Ale completó por primera vez las 8 fases del canal, pero con 21-34 errores por cada 100 llamadas. El 92 %
venía de dos causas:

- **`business_id` (74 %):** unos comandos lo exigen y otros (`saleads_get_campaign_health`) lo rechazan. El CLI 1.2.0
  recuerda el último negocio usado con éxito: lo agrega donde el esquema del comando lo pide y lo quita donde no
  existe. Regla 8 del CLI.
- **Tope de créditos sin fijar (19 %):** Ale reintentaba la generación. Regla 9 del CLI y fase de piezas: pedirlo
  una vez y seguir con lo que no gasta créditos.
- `version:` de todos los `SKILL.md` = 1.5.2. Sin cambios de permisos, skills ni `jobs.json`.

## 1.5.1

## Cambio frente a 1.5.0 (AAB-024, laboratorio)

- **Formatos del canal del agente** (`skills/saleads-cli/references/formatos.md`): ejemplos exactos de la apuesta
  (`agent-bet.v1`), la pieza maestra y su variación (`master_ref = {job_id, image_index}`), la subida de una pieza a
  Meta y el árbol de campaña en objetos de Graph. Son los que pasaron por la Agent API y Meta en dev el 2026-10-29. En
  la primera tanda del laboratorio Ale inventaba esas formas (`budget`, `audience`, `format`) y fallaba 30-65 de cada
  100 llamadas.
- Regla 8 del CLI: ante `MCP-E-INVALID-INPUT`, corregir exactamente los campos de `details.fields` y volver a llamar.
- `version:` de todos los `SKILL.md` = 1.5.1 en esa versión. Sin cambios de permisos, skills ni `jobs.json`.

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
