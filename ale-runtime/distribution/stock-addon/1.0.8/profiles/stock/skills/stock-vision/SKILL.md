---
name: stock-vision
description: Pide fotos al robot, interpreta el conteo de SAM con la imagen numerada y decide reintentos de concepto, variantes dudosas y cajas cerradas.
---

# Visión

SAM cuenta y ubica. Tú interpretas qué es cada cosa y si el total tiene sentido.

## Pedir la foto

1. `saleads_stock_take_photo` con `idempotency_key`, `concepto` y `etiqueta`. Si la tarjeta trae `producto` o `variante_id`, la `etiqueta` es ese producto, hasta 40 caracteres, nunca un lugar como «repisa» o «estante». Si la tarjeta no nombra producto, la `etiqueta` es `por identificar`. El `concepto` va en inglés simple, por ejemplo `jar`, `bottle`, `box` o `lid`. Una foto nueva va sin `photo_id`: ese campo solo sirve para reintentar sobre una foto que ya existe.
2. Según `status`:
   - Resultado: trae conteo, cajas, confianza, `image_url` firmada y `photo_id`.
   - `pending`: guarda el `photo_id` y usa `kanban_block`. Al volver, usa `saleads_stock_get_photo`.
   - `robot_offline`: usa `kanban_block` con la condición «robot apagado». Ale avisa por canal.
   - `tope_diario`: se agotaron las llamadas de SAM de hoy. No reintentes: usa `kanban_block` con ese motivo y repórtalo en tu entrega.
   - `fallida` con `tope_fotos_conteo`: ya van 3 fotos de este conteo. Propón con la mejor que tengas o usa `kanban_block`.

## Mirar la imagen

Llama `vision_analyze` con `image_url`. Compara lo numerado con lo que esperas de `saleads_stock_get_item`. La URL vence: si caducó, pídela de nuevo con `saleads_stock_get_photo`.

## Reintentos

Con cero resultados, repite `saleads_stock_take_photo` con el mismo `photo_id` y otro concepto. Máximo 2 reintentos por foto. Después, pide otra foto o usa `kanban_block`.

## Variantes

Si no distingues una variante, no elijas ni repartas el total entre variantes, aunque coincida con lo esperado. No propongas conteo por variante desde esa foto. Indícalo en tu resultado con «variante dudosa», el total y las opciones que ves, para que Ale pregunte al dueño.

El servidor lo exige (R15). Si propones dos variantes del mismo producto con los mismos objetos de una imagen, responde `estado:"variante_por_confirmar"` con una sola propuesta por producto y vence la anterior. No la vuelvas a repartir: copia en tu resultado `pregunta.texto`, las `opciones` y el `proposal_id`.

Para separar variantes con SAM, reintenta sobre el mismo `photo_id` con un concepto por variante que las distinga (color, etiqueta). Solo sirve si cada concepto encuentra botellas distintas: si los dos encuentran las mismas, el servidor lo trata como la misma foto.

## Cajas cerradas

Cuentas la caja. Las unidades salen de la factura o del dueño.

## Lo que muestra la pantalla

La pantalla de Jolly muestra los objetos numerados y el total. Tu propuesta debe coincidir con lo que la dueña ve, o explicar la diferencia.

Una foto simulada llega marcada. Mantén esa marca en tu resultado.
