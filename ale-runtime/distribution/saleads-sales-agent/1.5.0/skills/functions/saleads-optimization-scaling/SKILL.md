---
name: saleads-optimization-scaling
description: "Optimización y escalado del optimizador: qué hacer con una campaña que ya corre según el veredicto del analista. Escala la caja que ganó, agrega anuncios cuando caen los resultados en vez de subir presupuesto, mueve ganadores a límite de costo y, si nada gana, revisa oferta o producto. Dentro del presupuesto mensual aprobado Ale ejecuta lo que propones (pausar, mover entre cajas); encender, borrar o pasarse del presupuesto aprobado lo aprueba el dueño en el panel de SaleADS. Criterios de fondo: saleads-estructura-optimizacion-juan."
version: 1.5.0
metadata:
  hermes:
    category: saleads-strategy
    tags: [saleads, optimization, scaling, budget]
  saleads:
    origin: juan
    confidence: medium
---

# Optimización y escalado

Trabajas sobre campañas que ya corren y sobre veredictos que ya dejó el analista. No inventas veredictos: si no hay uno con el gasto mínimo, la recomendación es esperar o agregar anuncios, no mover plata.

## 1. Antes de proponer

- Lee en el cerebro el último veredicto de la campaña, las apuestas de cada caja y qué se propuso antes (`brain_query`). No propongas otra vez algo que el dueño rechazó, salvo que haya evidencia nueva y lo digas.
- Mira `saleads-estructura-optimizacion-juan` (criterios de Juan con su porqué) y la skill del tipo de negocio: sus cifras son ejemplos y punto de partida. La evidencia del negocio manda sobre ellas.

## 2. Qué propones según la situación

| Situación | Propuesta |
|---|---|
| Una caja ganó en esta prueba y su costo por compra está claramente bajo el objetivo (Juan: menos del 70 %) | Subir su presupuesto entre 50 % y 100 %, y volver a leer en unos 3 días |
| Los resultados vienen cayendo | **Más anuncios, no más presupuesto:** anuncios nuevos y distintos para la caja (pídeselos al estratega por Ale) |
| Los anuncios nuevos tampoco funcionan | Bajar el presupuesto mientras se aprende |
| Ganadores estables (más gasto y mejor costo por compra) | Moverlos a una campaña con **límite de costo**: puja cerca de 20 % sobre el costo logrado y presupuesto alto, porque Meta solo gasta si encuentra ventas a ese costo |
| Una caja perdió en esta prueba | Apagarla o reemplazarla por una apuesta nueva; lo que perdió no se repite |
| Nada ganó después del gasto mínimo | No pidas más plata: revisa audiencia, oferta o producto con el estratega y el analista |
| Anuncios validados (buen CTR) y quieres abrir audiencias | ABO: conjuntos nuevos cada 2 o 3 días |

## 3. Cómo se propone

- Cada cambio es una **propuesta** en tu tarjeta con: qué cambia, en qué campaña o caja, cuánto, por qué (con el veredicto y las cifras de la ventana) y cuándo se vuelve a leer. Tú no tienes terminal: Ale la ejecuta con el CLI.
- Di si cabe en el presupuesto mensual aprobado. Pausar y mover presupuesto entre cajas dentro de lo aprobado lo hace Ale y lo cuenta. Encender, borrar o pasarse del presupuesto aprobado lo aprueba el dueño con un botón en el panel de SaleADS; márcalo así en la propuesta.
- Una propuesta a la vez por campaña, salvo que dependan entre sí. Mejor una buena propuesta que cinco pequeñas.

## 4. Qué entregas

En el resultado de la tarjeta: la situación en una línea, la propuesta (o «esperar» con la razón), el riesgo y la fecha de la próxima lectura. Deja la propuesta en el cerebro conectada al veredicto que la justifica.

## Al terminar una tarjeta

Guarda en tu memoria qué propusiste, con qué evidencia y qué decidió el dueño, para no repetir propuestas rechazadas.
