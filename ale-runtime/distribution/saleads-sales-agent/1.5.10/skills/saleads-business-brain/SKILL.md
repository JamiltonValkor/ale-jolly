---
name: saleads-business-brain
description: "Usa el cerebro del negocio para saber qué es validado, qué es inferido y qué falta antes de afirmar algo."
version: 1.5.10
metadata:
  hermes:
    category: saleads-brain
    tags: [saleads, brain]
---

# Cerebro del negocio

El cerebro guarda lo que SaleADS sabe del negocio (semilla) y lo que aprendes en las conversaciones.

1. Antes de afirmar un hecho del negocio, consulta `brain_query`. Distingue lo **validado** de lo **propuesto** y de lo que **falta**.
2. Quién manda: en precios, ofertas y datos declarados manda lo que dice el dueño; en gasto, conversiones y métricas manda la plataforma. Lo inferido nunca reemplaza lo validado.
3. Cuando el dueño diga o decida algo del negocio, regístralo con `brain_ingest` (`owner_said` u `owner_decided`). Una corrección o preferencia suya va con `brain_record_feedback` y su alcance explícito (`scope`, por ejemplo `["avatar:mamas"]` o `["negocio"]`).
4. **Aprender del dueño desde el primer día.** Solo es decisión del dueño lo que él dijo: guárdala con su frase tal cual (`brain_record_feedback` con su alcance, o `brain_ingest owner_decided`). Nunca guardes como suya una frase tuya que él repitió, ni tu inferencia. «Todavía no» se guarda como «no encender sin su revisión», nunca como «no publicar». Cuando una decisión suya cambia cómo se apuesta (su margen, el cliente que sí compra, lo que no quiere que se diga, una preferencia estable), escribe también el aprendizaje sin esperar un veredicto: `brain_record_learning` con `anchor_uuid` = su `decision_uuid` y confianza baja o media.
5. **Margen.** Si no sabe su margen, ayúdale a calcularlo (precio menos costo por unidad) y guárdalo con sus palabras (`brain_record_feedback`, alcance `oferta:<id>`). Sin margen no hablas de ganancia.
6. Si notas un concepto propio del negocio que se repite (por ejemplo «paquete de novia»), propón un tipo con `brain_propose_type`, colgado de un tipo base (`extends`) y con al menos dos fuentes distintas.
7. No inventes datos para llenar huecos: nombra lo que falta y pregunta lo mínimo.
