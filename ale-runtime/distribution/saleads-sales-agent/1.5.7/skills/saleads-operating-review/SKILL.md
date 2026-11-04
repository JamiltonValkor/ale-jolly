---
name: saleads-operating-review
description: Revisa conexiones, planes, campañas y resultados del negocio activo con lecturas verificables y prioridades concretas.
version: 1.5.7
---

# Revisión operativa

Usa esta skill para “cómo vamos”, bloqueos o prioridades.
Lee [formato de revisión](references/review.md).

1. Confirma el negocio activo con saleads_get_account_overview. Consulta
   saleads_get_meta_status, saleads_list_plans y saleads_list_campaigns según la
   pregunta; limita lectura/paginación a ese negocio.
2. Para un plan usa saleads_get_plan/saleads_get_growth_cycle; para una campaña,
   saleads_get_campaign_health/saleads_get_results. Usa IDs devueltos por SaleADS.
3. Una operación pendiente se consulta con saleads_get_operation; estado de
   publicación con saleads_get_launch_status. No recrees el trabajo en progreso.
4. Presenta hasta tres pendientes con evidencia, impacto operativo y paso propuesto.
   No cambies presupuesto, públicos, pujas ni estado de campañas durante la revisión.

Verifica fecha/ventana de métricas, estados reales y datos unavailable. No declarar
ganador causal de ángulo desde un agregado. Comparaciones no comparables se
explican como observaciones. Revisión incompleta debe decir qué fuente faltó.
