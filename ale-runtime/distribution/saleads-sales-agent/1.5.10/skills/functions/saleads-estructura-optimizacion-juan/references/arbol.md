# La referencia del árbol

Es la forma exacta en que Ale publica la campaña (la misma de su CLI). El estructurador y el optimizador entregan el
árbol así, con las cifras puestas: Ale solo completa `image_hash` y `media_refs` con las piezas subidas.

## Árbol de campaña — `saleads campana publicar --archivo arbol.json --esperar 180`

Objetos de Graph de Meta, tal como los crea Meta. SaleADS fuerza la pausa y pone la página y el Instagram del dueño en
el creativo: no los escribas. El píxel no lo pone SaleADS: con `OUTCOME_TRAFFIC` no hace falta; no uses
`OUTCOME_SALES` a la web.

```json
{
  "business_id": "<uuid>",
  "bet_id": "<bet_id>",
  "skill_ref": {"skill_id": "saleads-estructura-optimizacion-juan", "skill_version": "saleads-sales-agent@1.5.10"},
  "tree": {
    "campaign": {"id": "camp", "name": "[Ale] Ritual de autocuidado", "objective": "OUTCOME_TRAFFIC",
                 "special_ad_categories": [], "is_adset_budget_sharing_enabled": false},
    "adsets": [{
      "id": "caja-1", "name": "[Ale] Mujeres 30-45 rutina natural", "daily_budget": 20000,
      "billing_event": "IMPRESSIONS", "optimization_goal": "LINK_CLICKS", "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
      "destination_type": "WEBSITE",
      "targeting": {"geo_locations": {"countries": ["CO"]}, "age_min": 30, "age_max": 45, "genders": [2],
                    "targeting_automation": {"advantage_audience": 0}},
      "ads": [{"id": "anuncio-1", "name": "[Ale] Ritual maestra",
               "creative": {"name": "Ritual maestra", "object_story_spec": {"link_data": {
                 "link": "https://<sitio del dueño>/", "message": "<copy de la apuesta>", "name": "Kit Ritual Botánico",
                 "image_hash": "<image_hash>", "call_to_action": {"type": "SHOP_NOW"}}}}}]
    }]
  },
  "media_refs": {"anuncio-1": {"gcs_path": "<media_ref.gcs_path de piezas preparar o medios subir>"}}
}
```

- **Presupuesto en la unidad menor de la moneda de la cuenta, como Meta** (mira la moneda en `saleads meta` o `saleads ctx`):
  
  | Moneda | Unidad que va en `daily_budget` | Ejemplo: 45 al día |
  |---|---|---|
  | COP, CLP, JPY, PYG, CRC, KRW, VND, HUF, ISK, TWD, IDR | la moneda misma | `45000` = 45.000 COP |
  | MXN, USD, EUR y las demás | centavos (×100) | `4500` = 45 MXN · `4500` = US$45 |
  
  Si Meta rechaza un presupuesto por estar bajo el mínimo, casi siempre olvidaste multiplicar por 100.
  El presupuesto va en la caja (ABO) o en la campaña (CBO), no en las dos.
- `objective`: `OUTCOME_TRAFFIC`, `OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_ENGAGEMENT` o `OUTCOME_AWARENESS`.
- Cada `id` (campaña, caja y anuncio) es temporal y único dentro del árbol; la respuesta te da los ids de Meta.
- Cada anuncio necesita su `media_refs` (la miniatura en SaleADS): el `media_ref` que devolvieron `piezas preparar` o
  `medios subir`, tal cual.
- Alternativa: Meta también acepta `link_data.picture` con una URL pública o la URL firmada de la pieza en vez de
  `image_hash` (Meta copia la imagen). El camino normal es `image_hash`: nunca uses la `url` de la imagen que devuelve
  Meta, que vence en 4 o 5 días.
- Si Meta rechaza algo, el error viene completo en `details.meta_error` (`error_user_msg` dice qué cambiar): corrige y
  publica de nuevo con otro `--id`.
- La respuesta (o `op`) trae `publication_id`, `campaign_id`, `meta_campaign_id`, los ids de cajas y anuncios: con
  `publication_id` pides el encendido (`saleads encendido pedir --campo publication_id <id>`).
- La respuesta trae también `budget_check`: lee si al encender te pasarías de lo que queda del mensual antes de pedir
  el encendido. No frena la publicación en pausa; si se pasa, ajusta el presupuesto o díselo al dueño con la cifra.
