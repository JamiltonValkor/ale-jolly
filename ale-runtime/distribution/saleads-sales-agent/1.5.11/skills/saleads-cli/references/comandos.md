# Stable CLI aliases and server commands

Stable Spanish aliases/options remain unchanged. Use saleads esquema <alias> or <alias> --help for live schemas. First proposal-only work uses available reads, not remote writes. All repeated writes retain --id.

| Alias | Server command | Purpose |
|---|---|---|
| `cuenta` | `saleads_get_account_overview` | Owned businesses |
| `ctx` | `saleads_get_business_bootstrap` | Verified business bootstrap |
| `negocio` | `saleads_get_business_profile` | Business profile |
| `ofertas` | `saleads_list_offerings` | Offers and actual prices |
| `guia` | `saleads_get_help` | SaleADS help |
| `meta` | `saleads_get_meta_status` | Meta connection/account |
| `lugares` | `saleads_search_locations` | Targeting location IDs |
| `limites` | `saleads_agent_limits` | Monthly approved/spent/committed/remaining budget and credit cap |
| `apuestas registrar` ✎ | `saleads_agent_register_bets` | Register actual authored bets in authorized commercial work |
| `apuestas estado` ✎ | `saleads_agent_bet_state` | Set bet state with reason |
| `piezas cotizar` ✎ | `saleads_agent_quote_pieces` | Quote master/variations without generation |
| `piezas generar` ✎ | `saleads_agent_generate_pieces` | Generate accepted quote within cap |
| `piezas ver` | `saleads_agent_pieces` | Read creative state/lineage |
| `medios subir` ✎ | `saleads_agent_upload_media` | Upload actual media; image_hash/media_ref |
| `piezas preparar` ✎ | (compuesto) | Composite quote/generate/wait/upload |
| `campana publicar` ✎ | `saleads_agent_publish_campaign` | Publish actual tree PAUSED in authorized scope |
| `encendido pedir` ✎ | `saleads_agent_request_activation` | Request owner activation approval |
| `cajas leer` | `saleads_agent_read_boxes` | Daily box/ad results with explicit window up to90days |
| `campanas` | `saleads_list_campaigns` | Business campaigns |
| `cajas` | `saleads_get_box_metrics` | Classic box metrics |
| `anuncios` | `saleads_get_campaign_ads` | Campaign ads |
| `salud` | `saleads_get_campaign_health` | Campaign health |
| `resultados` | `saleads_get_results` | Business results |
| `leads calidad` ✎ | `saleads_agent_report_lead_quality` | Record actual owner lead feedback |
| `ventas registrar` ✎ | `saleads_agent_report_box_sales` | Record an actual owner-attributed sale |
| `espejo` ✎ | `saleads_agent_mirror` | Read or mutate own permitted Graph objects; currency minor units apply |
| `traza` | `saleads_agent_trace` | Attributed action/approval trace |
| `op` | `saleads_get_operation` | Long-running operation state |

Use explicit business_id for this work. The CLI supplies schema-required client_request_id; a loose positional value fills the only missing required field. CLI-USAGE reports unknown/missing/invalid fields before HTTP; correct them rather than inventing params.
State values remain active/paused/retired. Help topics remain que-es-saleads,flujo,planes-y-cupos,creditos,meta-requisitos,lanzamiento-y-gasto,resultados,faq. Trace filters action_id/object_type/object_id/kind/since/until/limit; no detail/result filter. Campaign filters status/period.
Use response_locale with saleads web --idioma es|en; operation_id for op, publication_id for activation. piezas preparar uses --esperar240 and terminal timeout300. Use returned schema values unchanged.
