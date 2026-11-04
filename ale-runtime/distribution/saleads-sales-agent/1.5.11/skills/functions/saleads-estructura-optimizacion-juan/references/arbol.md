# Campaign tree reference
Use the same shape as saleads-cli/references/formatos.md section5. The structurer supplies proposed numeric amounts; Ale fills actual image_hash/media_refs only during separately authorized commercial work. A proposal artifact is not publication. Server forcesPAUSED, supplies page/Instagram, and preserves actual skill lineage. Use the verified account currency/minor-unit rules; budget on campaignCBO or adsetABO, never both. Every temporary tree ID is unique. Never invent media paths or proof. Activation uses returned publication_id and checks budget_check against approved remaining monthly total.

```json
{
  "business_id": "<uuid>",
  "bet_id": "<bet_id>",
  "skill_ref": {"skill_id": "saleads-estructura-optimizacion-juan", "skill_version": "saleads-sales-agent@1.5.11"},
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
Objectives, destination/resources and error corrections follow the actual server schema. Current reference OUTCOME_TRAFFIC does not imply website OUTCOME_SALES support. Each ad needs actual media_ref; Meta-returned imageURLs expire in4–5days. Inspect details.meta_error/error_user_msg and operation state before corrected requests or retries. Explicit refusal to publish overrides paused-publication instructions.
