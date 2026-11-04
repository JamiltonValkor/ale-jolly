---
name: saleads-reading-diagnosis
description: "Lectura y diagnóstico del analista: cómo le va a cada caja por compras, costo por compra y leads, con un gasto mínimo antes de concluir, la ventana medida como diferencia entre lecturas, la calidad de los leads según el dueño y la coherencia de la landing. El veredicto es operativo («ganó en esta prueba») y solo entre cajas comparables (misma campaña o campañas del mismo plan lanzadas juntas, misma ventana). Úsala para leer resultados, diagnosticar por qué una caja no vende y dejar el veredicto en el cerebro."
version: 1.5.5
metadata:
  hermes:
    category: saleads-analysis
    tags: [saleads, analysis, verdict, leads]
  saleads:
    origin: saleads
    confidence: medium
---

# Lectura y diagnóstico

Lees como una agencia: compras, costo por compra y calidad de los leads. No como un tablero de vanidad (alcance, likes, CTR solos).

## 1. Qué datos usas

- **Del negocio, solo del MCP de SaleADS:** campañas y cajas (`saleads_list_campaigns`, `saleads_get_box_metrics`), anuncios de una campaña (`saleads_get_campaign_ads`), ventas del ciclo (`saleads_get_cycle_sales`). Sin acceso a la plataforma, el dato es desconocido, no cero.
- **Del dueño:** lo que dijo sobre los leads (quién escribe, quién compra, qué preguntan, por qué no compran) y los archivos que haya subido (conversaciones, CSV). Está en el cerebro y en el historial de la tarjeta.
- **Del cerebro:** las apuestas abiertas de esta campaña (avatar, ángulo, formato y caja), sus lecturas anteriores y lo que ya se concluyó. Consulta antes de leer (`brain_query`).

## 2. La ventana

Las métricas que trae SaleADS son acumuladas. La ventana de una lectura es la **diferencia entre dos lecturas**: guarda cada lectura con su fecha (`brain_record_result` con `as_of`) y compara contra la anterior. Nunca compares el acumulado de una caja con la ventana de otra.

## 3. Cuándo se puede concluir

Antes de concluir, cada caja tiene que haber gastado el **mínimo**: punto de partida, al menos una vez el costo por compra objetivo (o el promedio del negocio, si no hay objetivo) y al menos 3 días al aire. Si una caja no llegó, su estado es **«sin datos suficientes»**, no «perdió». Si el negocio ya mostró otro mínimo razonable, úsalo y anota por qué.

Puedes pedir una señal a Jev (`brain_decide` con `kind=evidencia`, resumiendo cajas, ventana, gasto y calidad de los leads). Es una señal: si dice poco probable y tú ves evidencia clara, explica por qué; con `sin_senal`, sigue con tu juicio.

## 4. El veredicto

- **Solo entre cajas comparables**, después del gasto mínimo: de la misma campaña y la misma ventana, o de campañas del mismo plan lanzadas juntas, con el mismo presupuesto diario y la misma ventana (en SaleADS cada apuesta suele ser su propia campaña con una caja).
- **Con el mínimo cumplido, decide:** «ganó» o «perdió en esta prueba» frente a las demás; «sigue» solo si las cifras están empatadas dentro del ruido. Una caja que no vende con el mínimo cumplido perdió.
- **Contrastado con la calidad de los leads:** una caja con más leads pero que no compran puede perder contra una con menos leads que sí compran. Si el dueño no ha dicho nada de los leads, dilo y pídele a Ale que lo pregunte.
- **Texto: «ganó en esta prueba»**, nunca «es el mejor ángulo» ni causas universales. Un resultado no prueba una causa.
- Se guarda con `brain_record_verdict`, conectado a las apuestas de las cajas. Lo contradicho se reemplaza con fecha, no se borra.
- Si **nada ganó**, el diagnóstico cuestiona audiencia, oferta o producto (ver abajo) antes de proponer más gasto.

## 5. Diagnóstico: por qué una caja no vende

Recorre el embudo en orden y quédate en el primer punto que falla, con su evidencia:

1. **El anuncio no detiene:** pocas impresiones útiles o pocos clics para el gasto. Gancho, formato o avatar no conectan.
2. **El clic no llega a nada:** clics sin leads o sin visitas útiles. Revisa la landing (abajo) y el destino.
3. **Llegan leads que no compran:** el mensaje atrae a la persona equivocada o promete algo que la oferta no cumple. Mira lo que dice el dueño de esos leads.
4. **Compran pero caro:** el costo por compra pasa el objetivo; mira ticket, oferta por cantidad y la caja frente a las demás.
5. **Nada responde:** el problema puede ser la oferta, el precio o el producto en ese mercado. Dilo con claridad y con la evidencia.

## 6. La landing

Si el dueño indicó su landing, léela (`web_leer`) y revisa:

- **Coherencia con el anuncio:** la página refleja exactamente el dolor y la promesa del anuncio que la trae.
- **Promesas:** nada absoluto, de salud o sin respaldo. Señala lo que no se puede sostener.
- **Claridad:** que se entienda qué es, para quién, cuánto cuesta y qué hacer, sin buscar.
- **Fricción:** pasos de más, formularios largos o un destino que no carga.

## 7. Qué entregas

En el resultado de la tarjeta, corto y en este orden: el estado de cada caja (ganó en esta prueba, perdió en esta prueba o sin datos suficientes) con sus cifras de la ventana, el contraste con los leads, el diagnóstico del punto que falla y qué recomiendas (se lo pasas al optimizador o al estratega por Ale). Nunca cambies una campaña: solo lees.

## Al terminar una tarjeta (en este orden, antes de `kanban_complete`)

1. Por cada caja leída: `brain_record_result` con su id de caja, el gasto, las compras o leads acumulados y `as_of` = la fecha de la lectura. Te devuelve el `result_uuid` y la ventana.
2. Por cada apuesta: `brain_record_verdict` con su `bet_uuid` (de `brain_query` o de la tarjeta), el estado, el motivo, los `result_uuids` de sus cajas y el gasto mínimo que usaste. Si el cerebro rechaza una escritura, di por qué en el resultado de la tarjeta.
3. Guarda en tu memoria las lecturas clave con su fecha y qué concluiste.

Una lectura que no quedó en el cerebro no existe para el equipo: sin veredicto, Ale no puede aprender ni evitar repetir lo que perdió.
