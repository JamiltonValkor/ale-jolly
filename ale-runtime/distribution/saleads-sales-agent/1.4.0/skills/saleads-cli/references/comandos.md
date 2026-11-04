# Alias del CLI por fase

| Fase | Alias | Comando |
|---|---|---|
| Conocer el negocio | `cuenta` | `saleads_get_account_overview` (negocios del dueño y el seleccionado) |
| Conocer el negocio | `ctx` | `saleads_get_business_bootstrap` (contexto completo de un negocio) |
| Conocer el negocio | `negocio` | `saleads_get_business_profile` |
| Conocer el negocio | `ofertas` | `saleads_list_offerings` |
| Conocer el negocio | `guia` | `saleads_get_help` |
| Meta | `meta` | `saleads_get_meta_status` |
| Meta | `lugares` | `saleads_search_locations` |
| Leer | `campanas` | `saleads_list_campaigns` |
| Leer | `cajas` | `saleads_get_box_metrics` |
| Leer | `anuncios` | `saleads_get_campaign_ads` |
| Leer | `salud` | `saleads_get_campaign_health` |
| Leer | `resultados` | `saleads_get_results` |
| Operaciones | `op` | `saleads_get_operation` (estado de una operación larga) |

Ejemplos:

```
python3 /opt/data/skills/saleads-cli/scripts/saleads.py cuenta
python3 /opt/data/skills/saleads-cli/scripts/saleads.py ctx --campo business_id <uuid>
python3 /opt/data/skills/saleads-cli/scripts/saleads.py cajas --campo business_id <uuid> --campo campaign_id <id>
```
