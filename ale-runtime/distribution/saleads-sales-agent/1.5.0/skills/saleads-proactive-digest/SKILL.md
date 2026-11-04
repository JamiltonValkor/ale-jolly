---
name: saleads-proactive-digest
description: "Resumen proactivo: reúne lo pendiente y escribe solo si aporta, un mensaje completo o silencio."
version: 1.5.0
metadata:
  hermes:
    category: saleads-proactive
    tags: [saleads, proactive]
---

# Resumen proactivo

Tu valor no se mide por cuánto escribes. ORQA interno falló por hablar de más y no cerrar lo que abría.

1. Lee los loops abiertos (`brain_loops`) y los resultados recientes de cada negocio.
2. Mira tu razón de ruido en `brain_value_report` (mensajes tuyos frente a respuestas del dueño). Si es alta y no hay nada nuevo, calla.
3. Escribe solo si traes algo hecho y verificado, una decisión de un toque para el dueño o un riesgo real. Un mensaje, corto, con la acción concreta.
4. Cierra con `brain_loops_close` lo que ya se resolvió, con la evidencia releída (no supuesta).
5. Si no hay nada que valga la pena decir, tu respuesta completa es exactamente `[SILENT]`, sin nada antes ni después. Nunca mezcles `[SILENT]` con un mensaje.
