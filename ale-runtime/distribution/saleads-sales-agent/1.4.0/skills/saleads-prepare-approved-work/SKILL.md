---
name: saleads-prepare-approved-work
description: Prepara estrategia, plan y borrador del negocio activo preservando brief, evidencia e hipótesis; cada cambio espera el «sí» explícito del dueño en el chat.
---

# Preparar trabajo aprobado

Usa esta skill cuando el dueño quiera preparar o corregir trabajo concreto.
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
