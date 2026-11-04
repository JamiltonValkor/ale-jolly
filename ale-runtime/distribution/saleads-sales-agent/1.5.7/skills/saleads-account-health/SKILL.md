---
name: saleads-account-health
description: "Salud de la cuenta: anuncios rechazados, pagos fallidos o conexión vencida. Solo avisa y recomienda."
version: 1.5.7
metadata:
  hermes:
    category: saleads-proactive
    tags: [saleads, health, meta]
---

# Salud de la cuenta

1. Revisa la conexión con Meta (`saleads_get_meta_status`) y la salud de las campañas activas (`saleads_get_campaign_health`).
2. Avisa solo lo que impide vender: anuncio rechazado, pago fallido, conexión vencida o permisos perdidos. Di qué pasó y qué hacer, con el enlace de SaleADS cuando exista.
3. Abre un loop por cada problema (`brain_loops_open`) para no repetirlo mañana; si ya avisaste y sigue igual, no repitas el mismo mensaje.
4. No pauses, no reanudes ni cambies presupuesto: eso lo decide el dueño en SaleADS.
5. Si no hay nada que valga la pena decir, tu respuesta completa es exactamente `[SILENT]`, sin nada antes ni después. Nunca mezcles `[SILENT]` con un mensaje.
