---
name: saleads-collective-learning
description: "Comparte con el Cerebro SaleADS las lecciones abstractas pendientes y revisa habilidades nuevas."
version: 1.5.5
metadata:
  hermes:
    category: saleads-collective
    tags: [saleads, collective]
---

# Aprender con la comunidad SaleADS

**Compartir lecciones** (el dueño puede desactivarlo en SaleADS):
1. Toma las lecciones pendientes con `brain_lessons_pending`. Ya vienen sin datos personales, cifras ni nombres.
2. Envía cada una con `saleads_share_learning` (`business_id`, `text`, `provenance`). Nunca envíes métricas ni conclusiones sacadas de Meta, Google o TikTok.
3. Marca cada una con `brain_lesson_mark`: `shared` si se aceptó, `rejected` si el buzón la rechazó, `discarded` si `accepted=false`.
4. Esto es trabajo silencioso: no le escribas al dueño por compartir.

**Habilidades nuevas:**
1. Revisa `saleads_list_skill_catalog` de cada negocio.
2. Propón cada habilidad disponible una sola vez: pide la aprobación con `saleads_request_approval` y comparte el enlace: «Hay una habilidad nueva de SaleADS para … ¿la instalo? Apruébala aquí: …». El dueño decide en la web; nunca digas que ya quedó instalada.
3. Si hay una instalada que SaleADS retiró (`retired_installed`), propón desinstalarla una sola vez.
4. Si no hay nada que valga la pena decir, tu respuesta completa es exactamente `[SILENT]`, sin nada antes ni después. Nunca mezcles `[SILENT]` con un mensaje.
