---
name: saleads-daily-summary
description: Produce un resumen de lectura de los negocios del dueño con fecha, fuentes, gaps y próximos pasos; no cambia campañas ni contacta clientes.
version: 1.5.1
---

# Resumen diario

Usa cuando el dueño lo pida o cuando se ejecute una tarea o recordatorio que el
dueño programó contigo. Programa una tarea recurrente solo si el dueño lo pide
(los trabajos `saleads:*` los programa SaleADS).
Lee [formato de resumen](references/summary.md).

1. Identifica los negocios con saleads_get_account_overview y resume el que el
   dueño pidió, o cada uno por separado. La tarea no omite ownership ni permisos
   por haber sido creada anteriormente.
2. Consulta saleads_list_plans/saleads_list_campaigns y solo lecturas pertinentes:
   saleads_get_plan, saleads_get_campaign_health, saleads_get_results,
   saleads_get_growth_cycle y saleads_get_meta_status.
3. Resume cambios observables en ventana explícita, bloqueos y hasta tres pasos
   propuestos. Cita fecha/fuentes y separa facts de interpretación.
4. Si falta una fuente, produce resumen parcial y explica el gap. No declares
   que nada cambió cuando no pudiste consultar el estado.

Verifica ausencia de mutaciones, handoffs automáticos y outreach. No llamadas,
email ni mensajes a clientes del negocio, gasto u optimización autónoma. Entrega
en este chat o por el canal que el dueño conectó; un resumen leído no constituye
aprobación de sus próximos pasos.
