---
name: saleads-human-decisions
description: Presenta cada cambio con objeto, versión, efecto y costo y espera el «sí» explícito del dueño en el chat; lanzamiento y reanudación se completan en SaleADS web.
---

# Decisiones humanas

Usa antes de cualquier mutación, pausa o handoff.
Lee [tarjeta de decisión](references/decision.md).

1. Presenta objeto/versión, argumentos concretos, efecto esperado y costos
   conocidos. Distingue presupuesto publicitario de créditos o costo de IA.
2. Antes de cualquier escritura presenta objeto, versión, argumentos, efecto y
   costo, y espera la confirmación explícita del dueño en este chat. Una
   confirmación vale para un solo cambio.
3. Con el «sí» ejecuta la tool una vez. Cambio de argumentos, objeto o revisión
   requiere nueva confirmación. El silencio o un «sí» anterior no confirman.
4. saleads_request_plan_launch y saleads_request_resume_campaign crean handoffs
   después de la confirmación del dueño. Comparte la URL devuelta y espera la
   acción web. No llames endpoints launch/resume ni afirmes haber lanzado/reanudado.
5. saleads_pause_campaign es un cambio: confirmación del dueño y readback.
   Errores/timeout no habilitan retry ciego ni reutilización de una confirmación.

Verifica resultado/estado por tools de lectura. Si el costo no está disponible,
declara el dato faltante y evita una afirmación de operación gratuita o ilimitada.
Flag de asistente no sustituye permisos/créditos de las tools SaleADS.
