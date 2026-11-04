# Alias del CLI por fase

`saleads <alias>` = `python3 /opt/data/skills/saleads-cli/scripts/saleads.py <alias>`. Los campos exactos de cada uno:
`saleads esquema <alias>`. Las escrituras (✎) llevan `--id` al repetirse.

| Fase | Alias | Comando | Para qué |
|---|---|---|---|
| Conocer | `cuenta` | `saleads_get_account_overview` | Negocios del dueño |
| Conocer | `ctx` | `saleads_get_business_bootstrap` | Contexto completo de un negocio |
| Conocer | `negocio` | `saleads_get_business_profile` | Perfil del negocio |
| Conocer | `ofertas` | `saleads_list_offerings` | Productos y servicios con su precio |
| Conocer | `guia` | `saleads_get_help` | Ayuda de SaleADS |
| Meta | `meta` | `saleads_get_meta_status` | Conexión y cuenta publicitaria |
| Meta | `lugares` | `saleads_search_locations` | Ids de ubicaciones para segmentar |
| Apostar | `apuestas registrar` ✎ | `saleads_agent_register_bets` | Guarda la vuelta de apuestas tal cual (devuelve `bet_id` por apuesta y advertencias) |
| Apostar | `apuestas estado` ✎ | `saleads_agent_bet_state` | Activa, pausa o retira una apuesta con tu razón |
| Piezas | `piezas cotizar` ✎ | `saleads_agent_quote_pieces` | Cuánto cuesta la maestra o sus variaciones en créditos (no gasta) |
| Piezas | `piezas generar` ✎ | `saleads_agent_generate_pieces` | Genera lo cotizado con `quote_token` y `accepted_credits` |
| Piezas | `piezas ver` | `saleads_agent_pieces` | Estado de una pieza (`job_id`) o linaje de una maestra |
| Piezas | `medios subir` ✎ | `saleads_agent_upload_media` | Sube una imagen o video (propio o de una pieza) a la cuenta del dueño |
| Publicar | `campana publicar` ✎ | `saleads_agent_publish_campaign` | Publica el árbol en Meta **en pausa** (asíncrono) |
| Publicar | `encendido pedir` ✎ | `saleads_agent_request_activation` | Pide al dueño encender una campaña: devuelve el enlace del panel |
| Leer | `cajas leer` | `saleads_agent_read_boxes` | Gasto, resultados, leads y costo por caja o anuncio, día por día (`since`, `until`, ≤ 90 días) |
| Leer | `campanas` | `saleads_list_campaigns` | Campañas del negocio |
| Leer | `cajas` | `saleads_get_box_metrics` | Métricas por caja (lectura clásica) |
| Leer | `anuncios` | `saleads_get_campaign_ads` | Anuncios de una campaña |
| Leer | `salud` | `saleads_get_campaign_health` | Salud de una campaña |
| Leer | `resultados` | `saleads_get_results` | Resultados del negocio |
| Leer | `leads calidad` ✎ | `saleads_agent_report_lead_quality` | Guarda lo que el dueño dijo de sus leads (bueno, regular, malo) |
| Leer | `ventas registrar` ✎ | `saleads_agent_report_box_sales` | Guarda una venta que el dueño atribuye a una caja |
| Optimizar | `espejo` ✎ | `saleads_agent_mirror` | Graph sobre tus objetos (`path` = `/<id de Meta>`): pausar (`status: PAUSED`), mover presupuesto dentro de lo aprobado (`daily_budget` en la unidad menor de la moneda de la cuenta, como pide Meta: COP, CLP y JPY van tal cual; MXN, USD, EUR y las demás ×100 — tabla en `formatos.md` §5), leer (`GET`) |
| Contar | `traza` | `saleads_agent_trace` | Qué hiciste, con qué apuesta y skill, qué gastó y qué aprobó el dueño |
| Operaciones | `op` | `saleads_get_operation` | Estado de una operación larga |

Ejemplos:

```
saleads cuenta
saleads ctx --campo business_id <uuid>
saleads apuestas registrar --archivo /opt/data/trabajo/apuestas.json
saleads campana publicar --archivo /opt/data/trabajo/arbol.json --esperar 120
saleads encendido pedir --campo business_id <uuid> --campo publication_id <id>
saleads cajas leer --campo business_id <uuid> --campo campaign_id <uuid_de_la_campana_en_saleads> --campo level adset --campo since 2026-10-27 --campo until 2026-11-02
saleads espejo --campo business_id <uuid> --campo method POST --campo path /<id_de_caja_en_meta> --campo params '{"status":"PAUSED"}'
saleads traza --campo business_id <uuid> --campo since 2026-10-27
saleads op <operation_id>
saleads piezas ver --campo job_id <jobId>
saleads apuestas estado --campo bet_id <bet_id> --campo state paused
saleads guia --campo topic creditos
```

- El CLI pone `business_id` (el negocio en el que trabajas) y `client_request_id` cuando el comando los pide. Un valor
  suelto (`saleads op <id>`) llena el único campo obligatorio que falte.
- Si un campo no existe, falta uno obligatorio o un valor no está en la lista, el CLI responde `CLI-USAGE` **antes**
  de llamar, con los campos o valores válidos: corrige eso y vuelve a llamar. `saleads esquema <comando>` muestra
  todos los campos.
- Valores fijos más usados: `apuestas estado` → `state`: `active`, `paused` o `retired`. `guia` → `topic`:
  `que-es-saleads`, `flujo`, `planes-y-cupos`, `creditos`, `meta-requisitos`, `lanzamiento-y-gasto`, `resultados` o
  `faq` (o `question` con tu pregunta). `traza` filtra con `action_id`, `object_type` (`campaign`, `ad_set`, `ad`),
  `object_id`, `kind`, `since`, `until` y `limit`: no tiene `detail` ni `result`. `campanas` filtra con `status` y
  `period`.
