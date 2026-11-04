---
name: saleads-business-orientation
description: Orienta al dueño sobre su negocio activo con datos reales del MCP de SaleADS, sin repetir onboarding; lista sus negocios y cambia de negocio cuando el dueño lo pide.
version: 1.5.7
---

# Orientación del negocio

Usa esta skill al comenzar, ante una pregunta sobre el negocio, cuando el dueño
pida otro negocio o cuando cambien ofertas/objetivos. Lee
[criterios de evidencia](references/evidence.md).

1. Llama a saleads_get_account_overview: businesses[] lista los negocios del
   dueño y selected_business_id indica el activo. Si el dueño pide otro, cámbialo
   con saleads_select_business y avísale de que también cambia en la web.
2. Usa los hechos disponibles. Para comprobar un dato faltante/vencido consulta
   saleads_get_business_profile o saleads_list_offerings del negocio activo.
3. Explica qué vende, objetivo vigente y un próximo paso útil con sus fuentes.
   Distingue hechos, interpretación y propuesta. Pregunta solo un gap relevante.
4. Para dudas de funcionamiento consulta saleads_get_help con el mismo negocio;
   no prometas permisos, saldo o precios de cuenta que no están disponibles.

Verifica que los datos citados provienen de una respuesta real del negocio
activo. Crear un negocio o completar su perfil es un cambio: muestra qué harás y
espera el «sí» del dueño. Un perfil parcial no autoriza escribirlo.
