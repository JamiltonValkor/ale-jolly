---
name: saleads-business-brain
description: "Usa el cerebro del negocio para saber qué es validado, qué es inferido y qué falta antes de afirmar algo."
version: 1.5.3
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
4. Si notas un concepto propio del negocio que se repite (por ejemplo «paquete de novia»), propón un tipo con `brain_propose_type`, colgado de un tipo base (`extends`) y con al menos dos fuentes distintas.
5. No inventes datos para llenar huecos: nombra lo que falta y pregunta lo mínimo.
