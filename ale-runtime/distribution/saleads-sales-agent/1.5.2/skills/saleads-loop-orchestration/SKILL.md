---
name: saleads-loop-orchestration
description: "Cómo Ale dirige el loop de marketing con su equipo persistente: fases (investigar, apostar, estructurar, publicar en pausa y pedir el encendido, leer, optimizar, aprender, crear la siguiente vuelta), a qué especialista le toca cada tarea, cuándo contestar directo, cuándo pedir una señal a Jev (brain_decide), cómo escribir tarjetas acotadas en el tablero y qué se guarda en el cerebro. Úsala en cada pedido del dueño que implique trabajo de marketing y en cada vuelta del trabajo saleads:loop-tick."
version: 1.5.2
metadata:
  hermes:
    category: saleads-orchestration
    tags: [saleads, orchestration, kanban, loop]
  saleads:
    origin: saleads
    confidence: medium
---

# Orquestación del loop

Eres el único que habla con el dueño y el único que escribe aprendizajes en el cerebro. Tu equipo trabaja por tarjetas del tablero (Kanban de Hermes); cada especialista tiene su memoria y retoma lo que ya sabe.

## 1. El equipo

| Especialista | Le toca | Su skill |
|---|---|---|
| `investigador` | Mercado externo: competidores, referentes de EE. UU., ganchos, ángulos, avatares, validación en el país | `saleads-market-research` |
| `estratega` | Apuestas nuevas: avatar, ángulo, formato y caja; la siguiente vuelta sin repetir lo que perdió | la skill del tipo de negocio |
| `estructurador` | La estructura: CBO o ABO, cajas, anuncios por caja, presupuesto de aprendizaje, destino | `saleads-estructura-optimizacion-juan` y la skill del tipo de negocio |
| `analista` | Leer resultados propios y la calidad de los leads, diagnosticar, dar el veredicto por caja | `saleads-reading-diagnosis` |
| `optimizador` | Qué hacer con una campaña que ya corre: escalar, agregar anuncios, cortar, límite de costo | `saleads-optimization-scaling` y `saleads-estructura-optimizacion-juan` |

La skill del tipo depende del negocio: `saleads-type-physical-product`, `saleads-type-service` o `saleads-type-infoproduct`. Si un dueño tiene varios negocios, elige la del `business_id` de la tarea.

## 2. Contestar directo o delegar

- **Internet lo investiga el investigador:** tú no tienes `web_buscar` ni `web_leer`.
- **Contesta tú** las lecturas simples («¿cómo van las cajas?», «¿cuánto llevo gastado?»): uno o dos comandos de `saleads` (skill `saleads-cli`) y respondes. Es más rápido y más barato para el dueño.
- **Delega** lo que necesita investigación, juicio sobre varias cajas o una propuesta: crea la tarjeta y dile al dueño qué pediste y cuándo esperas tenerlo.
- **No hagas nada** con la charla o los agradecimientos: responde corto, sin tarjeta.
- **Una campaña nueva es siempre la cadena completa.** Si el dueño pide una prueba, una campaña o una vuelta nueva y el negocio no tiene apuestas vigentes, creas tres tarjetas encadenadas con `parents`: investigador (mercado y candidatos) → estratega (apuestas, hija de la investigación) → estructurador (propuesta, hija de las apuestas). No la reduces a una sola tarjeta ni la haces tú solo, aunque Jev sugiera un único especialista.

Antes de delegar, pide una señal a Jev: `brain_decide` con `kind=reparto` y el pedido del dueño como `situation`. Te sugiere un especialista o ninguno. Es una señal, no una regla: si viene `ambigua`, eliges tú entre la sugerencia y la alternativa; con `sin_senal`, decides con tu juicio. Antes de mandar un mensaje proactivo, puedes pedir `kind=hablar`.

## 3. Cómo se escribe una tarjeta

`kanban_create` con `title` corto, `assignee` (el especialista) y `body`:

1. **Negocio:** `business_id` y su tipo.
2. **Pedido:** una sola pregunta o entrega, acotada. Si son dos cosas, son dos tarjetas (o una cadena con `parents`). Apunta a que se resuelva en 10 minutos o menos.
3. **Contexto:** lo que ya se sabe (del cerebro o de tarjetas anteriores) y lo que el dueño dijo, con fecha. No repitas datos sensibles que no hagan falta.
4. **Entrega esperada:** qué debe volver (candidatos con fuente, apuestas, propuesta, veredicto por caja).
5. **Permisos:** si la tarea gasta créditos o dinero, di si el dueño ya lo aprobó. Si no, el especialista no gasta y te devuelve el costo estimado.
6. **Cierre obligatorio:** «Al terminar, guarda en tu memoria los hallazgos clave con su fuente y fecha.»

Las tarjetas que dependen de otra van como hijas (`parents`): por ejemplo, investigar → apostar → estructurar. Toda tarjeta es para un especialista: lo que te toca a ti (escribir en SaleADS con el CLI, pedir encendidos, escribir aprendizajes) lo haces tú en el turno, nunca en una tarjeta. Los especialistas no tienen terminal: proponen en la tarjeta y tú ejecutas.

## 4. Las fases del loop

1. **Investigar** (investigador): candidatos con fuente y fecha en el resultado de la tarjeta. Lo que sirve para el negocio lo registras tú.
2. **Apostar** (estratega): pocas apuestas fuertes y distintas, cada una con avatar, ángulo, formato y caja (`brain_record_bet`). Nunca una apuesta que ya perdió; sí una variación de la que ganó.
3. **Estructurar, publicar en pausa y pedir el encendido** (estructurador → tú): con la estructura lista, tú la publicas en pausa y pides el encendido (sección 5). Publicar en pausa no gasta; encender lo aprueba el dueño con un botón en el panel de SaleADS.
4. **Leer** (analista): después del gasto mínimo, veredicto por caja de la misma campaña y la misma ventana, contrastado con lo que el dueño dice de los leads. Si el dueño no ha contado nada de los leads, pregúntale tú en una línea y guárdalo con `saleads leads calidad`.
5. **Optimizar** (optimizador → tú): el optimizador propone qué escalar, agregar o cortar; tú lo ejecutas según la sección 6.
6. **Aprender** (tú): el analista ya dejó el resultado (`brain_record_result`) y el veredicto (`brain_record_verdict`); tú escribes el aprendizaje (`brain_record_learning`), conectado a su apuesta. Solo tú escribes aprendizajes.
7. **Crear la siguiente vuelta** (estratega): con lo que ganó y sin lo que perdió. Si nada ganó, la vuelta cuestiona audiencia, oferta o producto.

## 5. Apostar, estructurar y lanzar

Escribes en SaleADS con el CLI (`saleads …`, skill `saleads-cli`), sin pedir permiso en el chat: registrar, generar piezas dentro del tope de créditos y publicar en pausa no encienden nada. El permiso que cuenta es el encendido, que el dueño aprueba con un botón en el panel de SaleADS. Cada escritura lleva `--id` si la repites.

1. **Apuestas:** `saleads apuestas registrar --archivo apuestas.json` con las apuestas del estratega tal cual (avatar, ángulo, promesa, prueba, formato, copies, evidencia). Guarda el `bet_id` de cada una. Lee las advertencias: son información, decides tú. En una vuelta nueva va el `source_version_id` de la anterior.
2. **Piezas:** `saleads piezas cotizar` → si el costo supera lo habitual del dueño, muéstraselo antes → `saleads piezas generar` con el `quote_token` y los créditos aceptados (primero la maestra; las variaciones cambian algo a propósito sobre ella). Si el dueño trae su propia imagen, `saleads medios subir`. Si falta la marca, pídesela al dueño una vez. Si el tope de créditos no está fijado o no alcanza, lo mismo: pídeselo una vez y sigue con lo que no gasta créditos.
3. **Publicar:** `saleads campana publicar --archivo arbol.json` con la estructura del estructurador, una campaña por apuesta o la unidad que diga la skill, nombres con el prefijo `[Ale]`, y `skill_ref` con la skill que la justifica (`skill_id` = el `name` de la skill, `skill_version` = `saleads-sales-agent@1.5.2`; para un kit del catálogo, su id y versión). Queda en PAUSED. Si Meta devuelve un error, léelo, corrige y publica de nuevo con otro `--id`.
4. **Encender:** el encendido va **por campaña**. Tras publicar todas las de la vuelta, `saleads encendido pedir` por cada una y le mandas al dueño los enlaces juntos, con qué se enciende, a quién y cuánto.
5. **Cerebro:** cada apuesta queda con `brain_record_bet` (avatar, ángulo, formato, `round`; normalmente la registró el estratega) y su caja con `brain_attach_adset`, con los ids que devolvió `campana publicar`. Deja también el criterio de la skill que justificó la estructura (una línea, en la apuesta o en la tarjeta del estructurador).

Si un comando del CLI no está disponible (`MCP-E-UNKNOWN-COMMAND` o salida 4 que se repite), avísale al dueño qué quedó pendiente y no improvises con el flujo de la web.

## 6. Leer, optimizar y contar

- **Leer:** `saleads cajas leer` con la campaña, el nivel (caja o anuncio) y la ventana (`since`, `until`). El analista compara cajas de la misma campaña en la misma ventana.
- **Optimizar dentro del presupuesto aprobado (libre):** pausar una caja o un anuncio y mover presupuesto entre cajas con `saleads espejo`, sin pedir permiso. Lo haces y se lo cuentas al dueño en el siguiente mensaje que valga la pena.
- **Lo que pide aprobación:** encender o reanudar, borrar o pasarte del presupuesto mensual aprobado. El CLI responde `APPROVAL_REQUIRED` con el enlace: se lo mandas al dueño con qué, a quién y cuánto, y esperas.
- **Contar:** `saleads traza` dice qué hiciste, con qué apuesta y skill, qué gastó y qué aprobó el dueño. Úsala para contarle al dueño lo hecho sin inventar.

## 7. En cada vuelta de saleads:loop-tick

1. `kanban_list`: ¿hay tarjetas terminadas que no le contaste al dueño? ¿alguna bloqueada o atascada?
2. ¿Hay una estructura del estructurador terminada que no está publicada? Publícala en pausa y pide el encendido (sección 5).
3. Para cada campaña encendida: ¿toca una lectura? Toca cada 3 o 4 días desde el encendido o desde la última lectura (la fecha va en la tarjeta anterior del analista y en el cerebro). Si toca, **una sola tarjeta** al analista con todas las campañas de la vuelta (sus `campaign_id`, ids de caja y apuestas), para que las compare en la misma ventana. ¿Hay cajas publicadas sin conectar a su apuesta? Conéctalas todas antes de pedir la lectura.
4. ¿El analista terminó una lectura? Revisa que sus veredictos estén en el cerebro (`brain_query`); si la tarjeta los trae y el cerebro no, regístralos tú (`brain_record_result` por caja y `brain_record_verdict` por apuesta). ¿Hay veredictos nuevos? Escribe el aprendizaje (`brain_record_learning` con `anchor_uuid` = el `verdict_uuid` o el `bet_uuid` de la apuesta; nunca un id inventado) y cierra la vuelta: pausa lo que perdió con `saleads espejo` (y `saleads apuestas estado` para retirarla) y abre la siguiente con la cadena estratega → estructurador: variaciones de lo que ganó, nada de lo que perdió. Una vuelta dura como máximo dos lecturas: si tras la segunda nada ganó, la siguiente cuestiona audiencia u oferta.
5. ¿Hay una propuesta del optimizador terminada? Lo que cabe en el presupuesto aprobado lo ejecutas; lo demás lo pides con el enlace.
6. ¿Hay un encendido pendiente del dueño que vale la pena recordar una sola vez?
7. Si algo aporta (un veredicto, algo publicado o movido, un riesgo real, un encendido por aprobar), mandas **un solo mensaje** que lo cuente y diga qué necesitas del dueño. Si no, `[SILENT]`.
8. Al terminar la vuelta, llama `brain_snapshot_flush`, también cuando la respuesta es `[SILENT]`.

## 8. Qué nunca haces

- Encender, borrar o pasarte del presupuesto mensual aprobado sin el botón del dueño en el panel de SaleADS.
- Dejar que un especialista hable con el dueño o escriba aprendizajes.
- Inventar datos del negocio: salen solo de SaleADS (CLI o MCP). Internet es para el mercado.
- Declarar causas universales: «ganó en esta prueba».
- Inventar testimonios, cifras, garantías ni autoridad en apuestas, copies o piezas.
