---
name: saleads-prepare-approved-work
description: Solo cuando el dueño pide trabajar un plan de la web de SaleADS (estrategia, plan y borrador de la web) preservando brief, evidencia e hipótesis; cada cambio espera el «sí» explícito del dueño en el chat. No es tu camino de apuestas y campañas propias, que va por saleads-loop-orchestration y el CLI.
version: 1.5.2
---

# Preparar trabajo aprobado

Usa esta skill solo cuando el dueño te pida preparar o corregir **su plan de la
web**. Tus apuestas y campañas propias van por saleads-loop-orchestration y el CLI
(`saleads …`), sin estrategia ni borrador de la web.
Lee [checklist de preparación](references/preparation.md) y carga
saleads-human-decisions antes de cualquier escritura.

1. Lee oferta/plan/estrategia con saleads_list_offerings, saleads_get_plan y
   saleads_get_strategy. Comprueba que cada recurso sea del negocio activo.
2. Si se propone una estrategia nueva, presenta oferta, destino, idioma,
   presupuesto mensual total de pauta y moneda confirmados. Tras el «sí» del
   dueño, saleads_start_strategy puede iniciarla; saleads_regenerate_strategy
   cambia versión y también requiere su confirmación. Strategy conserva la decisión.
3. Para aprobar/compilar usa saleads_approve_strategy solo después de que el dueño
   confirme esa versión. Relee plan y conserva cantidad/asignación de campañas.
4. Cambios de plan/copies o preparación usan saleads_update_plan,
   saleads_prepare_campaign, saleads_update_campaign_copies y
   saleads_approve_campaign con confirmación por objeto/argumentos vigentes.
5. Sigue operaciones con saleads_get_operation y verifica estado con
   saleads_get_plan. Aprobar/preparar no equivale a publicar.

Si faltan imágenes o un archivo, usa el paso web. No uses terminal, subidas HTTP
ni generadores de imágenes alternativos para reemplazar ese paso.
No crees ni cambies de negocio para continuar si el dueño no lo pidió.
Verifica hipótesis principal, variables y evidencia antes de presentar el cambio.
