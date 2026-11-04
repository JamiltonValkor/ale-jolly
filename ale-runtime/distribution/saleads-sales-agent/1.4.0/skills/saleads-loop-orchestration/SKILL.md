---
name: saleads-loop-orchestration
description: "Cómo Ale dirige el loop de marketing con su equipo persistente: fases (investigar, apostar, estructurar y lanzar con permiso, leer, optimizar, aprender, crear la siguiente vuelta), a qué especialista le toca cada tarea, cuándo contestar directo, cuándo pedir una señal a Jev (brain_decide), cómo escribir tarjetas acotadas en el tablero y qué se guarda en el cerebro. Úsala en cada pedido del dueño que implique trabajo de marketing y en cada vuelta del trabajo saleads:loop-tick."
version: 1.3.0
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
| `estructurador` | La propuesta de lanzamiento: CBO o ABO, anuncios por caja, presupuesto de aprendizaje, destino | la skill del tipo de negocio |
| `analista` | Leer resultados propios y la calidad de los leads, diagnosticar, dar el veredicto por caja | `saleads-reading-diagnosis` |
| `optimizador` | Qué hacer con una campaña que ya corre: escalar, agregar anuncios, cortar, límite de costo | `saleads-optimization-scaling` |

La skill del tipo depende del negocio: `saleads-type-physical-product`, `saleads-type-service` o `saleads-type-infoproduct`. Si un dueño tiene varios negocios, elige la del `business_id` de la tarea.

## 2. Contestar directo o delegar

- **Internet lo investiga el investigador:** tú no tienes `web_buscar` ni `web_leer`.
- **Contesta tú** las lecturas simples («¿cómo van las cajas?», «¿cuánto llevo gastado?»): una o dos tools del MCP y respondes. Es más rápido y más barato para el dueño.
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

Las tarjetas que dependen de otra van como hijas (`parents`): por ejemplo, investigar → apostar → estructurar. Toda tarjeta es para un especialista: lo que te toca a ti (cargar en SaleADS, pedir aprobaciones, escribir aprendizajes) lo haces tú en el turno, nunca en una tarjeta.

## 4. Las fases del loop

1. **Investigar** (investigador): candidatos con fuente y fecha en el resultado de la tarjeta. Lo que sirve para el negocio lo registras tú.
2. **Apostar** (estratega): pocas apuestas fuertes y distintas, cada una con avatar, ángulo, formato y caja (`brain_record_bet`). Nunca una apuesta que ya perdió; sí una variación de la que ganó.
3. **Estructurar y lanzar con permiso** (estructurador → tú): con la propuesta lista, tú la cargas en SaleADS (sección 5) y pides el lanzamiento; el dueño aprueba en la web con su código. Sin aprobación no se lanza.
4. **Leer** (analista): después del gasto mínimo, veredicto por caja de la misma campaña y la misma ventana, contrastado con lo que el dueño dice de los leads. Si el dueño no ha contado nada de los leads, pregúntale tú en una línea.
5. **Optimizar** (optimizador): propuesta de qué escalar, agregar o cortar; también pasa por `saleads_request_approval`.
6. **Aprender** (tú): el analista ya dejó el resultado (`brain_record_result`) y el veredicto (`brain_record_verdict`); tú escribes el aprendizaje (`brain_record_learning`), conectado a su apuesta. Solo tú escribes aprendizajes.
7. **Crear la siguiente vuelta** (estratega): con lo que ganó y sin lo que perdió. Si nada ganó, la vuelta cuestiona audiencia, oferta o producto.

## 5. Cargar las apuestas en SaleADS y pedir el lanzamiento

Los especialistas solo leen SaleADS; las escrituras las haces tú, en este orden y sin pedir permiso en el chat: cargar no gasta. El único permiso que cuenta es la aprobación del lanzamiento en la web, con el código del dueño. Las imágenes las genera SaleADS al preparar cada campaña; no se las pidas al dueño salvo que él quiera usar las suyas.

1. `saleads_list_offerings` y `saleads_start_strategy` con la oferta, el presupuesto mensual, la moneda y el destino que confirmó el dueño. Si responde `existing_plan` y ese plan ya se lanzó, la vuelta nueva va con `saleads_regenerate_strategy`. Las operaciones se leen con `saleads_get_operation`.
2. `saleads_approve_strategy` crea el plan; `saleads_get_plan` te dice cuántas campañas tiene. **Cada campaña del plan es una apuesta** (una caja con sus 3 anuncios). Si hay más apuestas que campañas, van las más fuertes; nunca mezcles dos apuestas en una campaña.
3. Por cada campaña: `saleads_prepare_campaign`, luego `saleads_update_campaign_copies` con los 3 textos de esa apuesta (los tres hablan al mismo avatar, con el mismo ángulo y formato, y se nombran tal cual en el texto), y `saleads_approve_campaign`. Nunca apruebes una campaña con los textos genéricos que trae SaleADS: cada campaña lleva su apuesta. En una vuelta nueva, las apuestas son las de la vuelta nueva, no las de la anterior.
4. `saleads_request_plan_launch` (o `saleads_request_approval` con `kind=launch_plan`): le mandas al dueño el enlace, qué se lanza, a quién y con cuánto.
5. Cada apuesta queda en el cerebro con `brain_record_bet` (avatar, ángulo, formato, `round`): normalmente la registró el estratega; si no, regístrala tú. Cuando ya está lanzada, conecta su caja con `brain_attach_adset` (el id de la caja sale de `saleads_get_box_metrics` o `saleads_get_campaign_ads`).

## 6. En cada vuelta de saleads:loop-tick

1. `kanban_list`: ¿hay tarjetas terminadas que no le contaste al dueño? ¿alguna bloqueada o atascada?
2. ¿Hay una propuesta del estructurador terminada que no está en SaleADS? Cárgala (sección 5) y pide el lanzamiento.
3. Para cada campaña activa: ¿toca una lectura? Toca cada 3 o 4 días desde el lanzamiento o desde la última lectura (la fecha va en la tarjeta anterior del analista y en el cerebro). Si toca, **una sola tarjeta** al analista con todas las campañas del plan (sus `campaign_id`, ids de caja y apuestas), para que las compare en la misma ventana. ¿Hay cajas lanzadas sin conectar a su apuesta? Conéctalas todas antes de pedir la lectura.
4. ¿El analista terminó una lectura? Revisa que sus veredictos estén en el cerebro (`brain_query`); si la tarjeta los trae y el cerebro no, regístralos tú (`brain_record_result` por caja y `brain_record_verdict` por apuesta). ¿Hay veredictos nuevos? Escribe el aprendizaje (`brain_record_learning` con `anchor_uuid` = el `verdict_uuid` o el `bet_uuid` de la apuesta; nunca un id inventado) y cierra la vuelta: pide pausar lo que perdió (`saleads_request_approval` con `kind=pause_campaign`) y abre la siguiente con la cadena estratega → estructurador: variaciones de lo que ganó, nada de lo que perdió, y la carga en SaleADS con `saleads_regenerate_strategy`. Una vuelta dura como máximo dos lecturas: si tras la segunda nada ganó, la siguiente cuestiona audiencia u oferta.
5. ¿Hay una aprobación pendiente del dueño que vale la pena recordar una sola vez?
6. Si algo aporta (un veredicto, una propuesta lista, un riesgo real, un lanzamiento por aprobar), mandas **un solo mensaje** que lo cuente y diga qué necesitas del dueño. Si no, `[SILENT]`.

## 7. Qué nunca haces

- Gastar, pausar, lanzar o redistribuir sin la aprobación del dueño en la web.
- Dejar que un especialista hable con el dueño o escriba aprendizajes.
- Inventar datos del negocio: salen solo del MCP de SaleADS. Internet es para el mercado.
- Declarar causas universales: «ganó en esta prueba».
