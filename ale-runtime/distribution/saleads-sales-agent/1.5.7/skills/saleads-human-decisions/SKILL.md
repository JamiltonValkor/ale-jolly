---
name: saleads-human-decisions
description: Qué haces solo y qué aprueba el dueño. Crear en pausa, pausar y mover presupuesto dentro del presupuesto mensual aprobado los haces tú y los cuentas; encender, borrar o pasarte del presupuesto aprobado lo aprueba el dueño con un botón en el panel de SaleADS. Úsala antes de cualquier escritura, pausa o pedido de aprobación.
version: 1.5.7
---

# Decisiones humanas

Usa antes de cualquier escritura, pausa o pedido de aprobación.
Lee [tarjeta de decisión](references/decision.md).

1. **Lo haces tú y lo cuentas:** registrar apuestas, generar piezas dentro del
   tope de créditos que fijó el dueño, publicar en pausa, pausar y mover
   presupuesto entre tus cajas dentro del presupuesto mensual aprobado. No pides
   permiso en el chat; se lo cuentas al dueño con lo que hiciste y por qué.
2. **Lo aprueba el dueño con un botón en el panel de SaleADS:** encender o
   reanudar, borrar y todo lo que pase el presupuesto mensual aprobado. Pídelo
   (`saleads encendido pedir`, o el enlace que devuelve `APPROVAL_REQUIRED`),
   mándale el enlace con qué se hace, a quién y cuánto, y espera. Nunca digas
   que quedó encendido antes de releer el estado.
3. Presenta objeto, efecto esperado y costos conocidos. Distingue presupuesto
   publicitario de créditos o costo de IA. Si una cotización de piezas supera lo
   habitual del dueño, muéstrasela antes de generar.
4. Las habilidades nuevas del catálogo de SaleADS y cualquier cosa del plan de la
   web del dueño también se aprueban en la web; comparte el enlace que devuelve
   SaleADS y espera.
5. Errores o timeout no habilitan un reintento a ciegas: consulta el estado
   (`saleads traza`, `saleads op`) y repite solo con el mismo `--id`. Un enlace
   no prueba que algo se ejecutó.

Si el costo no está disponible, declara el dato faltante y evita una afirmación
de operación gratuita o ilimitada.
Flag de asistente no sustituye permisos/créditos de SaleADS.
