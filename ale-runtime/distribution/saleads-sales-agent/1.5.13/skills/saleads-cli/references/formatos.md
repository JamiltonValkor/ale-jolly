# Agent-channel formats
Exact schema examples retained from1.5.10. Spanish IDs, example copy and enum values are literal synthetic data, not instructions or actual owner facts; do not translate contract identifiers. Use actual business/work context and response_locale for new content. Proposal-only work may prepare artifacts but does not invoke the remote write commands below. For separately authorized commercial work, write JSON under /opt/data/trabajo/ or the trusted workspace_path and pass --archivo. Correct exactly details.fields for MCP-E-INVALID-INPUT.

##1. Bets — saleads apuestas registrar

```json
{
  "business_id": "<uuid del negocio>",
  "offering_scope": {"type": "product", "ids": ["<uuid de la oferta>"]},
  "locale": "es-CO",
  "bets": [{
    "bet_key": "ritual",
    "offering_id": "<uuid de la oferta>",
    "avatar": {"text": "Mujer de 30 a 45 que quiere cuidar su cabello con ingredientes naturales", "awareness_stage": "problem_aware"},
    "angle": {"name": "Ritual de autocuidado", "rationale": "Lo que el dueño dijo que más preguntan sus clientas", "emotional_driver": "Sentirse cuidada"},
    "promise": {"claim": "Un ritual corto que deja el cabello suave", "evidence_refs": [], "claim_status": "untested"},
    "test": {"primary_variable": "ángulo", "held_constant": ["oferta", "formato"],
             "falsifiable_assumption": "Este ángulo consigue más compras que el otro con el mismo gasto",
             "success_signal": "Costo por compra menor que la otra caja tras el gasto mínimo", "primary_metric": "costo por compra"},
    "format": "imagen estática",
    "attribution_unit": "ad_set",
    "copies": [{"body": "¿Tu cabello pide una pausa? El Kit Ritual Botánico convierte tu lavado en un momento para ti.",
                "headline": "Kit Ritual Botánico", "cta": "Comprar", "hook_type": "pregunta", "tone": "cercano"}],
    "confidence": 0.5,
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.11"}
  }]
}
```

awareness_stage: unaware/problem_aware/solution_aware/product_aware/most_aware. claim_status supported requires actual owner-provided/confirmed proof and reference; restricted/untested are distinct. attribution_unit ad_set or campaign follows the declared test. bet_key is lowercase/no spaces and unique per round; preserve returned bet_id. A successor uses actual source_version_id from the preceding communication-strategy version.

##2. Master creative — piezas preparar
Normally one authorized command quotes, generates within cap, waits and uploads: --esperar240 with terminal timeout300. Ale chooses the brief/master/variation, not the composite command. lista returns job_id/variation_id/image_hash/media_ref; generando resumes same--id; sin_tope/tope_corto/supera_maximo spend nothing and expose cotizacion/credits/cap_status/limits_url; fallida needs judge/avisos and a corrected new request. --max-creditos bounds the accepted quote. Separate steps cotizar→generar→ver→medios subir remain available.

```json
{
  "business_id": "<uuid>",
  "piece": {
    "offering": {"item_id": "<uuid de la oferta>", "item_kind": "product"},
    "brief": {"scene": "Tocador de baño con luz de mañana y plantas", "subject_action": "Manos aplicando el producto en el cabello húmedo",
              "composition": "Producto en primer plano a la izquierda", "camera": "50mm", "lighting": "Luz natural lateral suave",
              "visual_style": "Editorial limpio y cálido", "color_treatment": "Verdes y crema", "mood": "Calma",
              "on_image_text": {"headline": "Tu ritual de cada mañana", "cta": "Conócelo"},
              "negative_constraints": ["sin afirmaciones médicas"]},
    "bet_context": {"avatar": "Mujer de 30 a 45", "pain": "Cabello opaco", "angle": "Ritual de autocuidado", "promise": "Cabello suave"},
    "aspect_ratio": "4:5",
    "bet_id": "<bet_id>",
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.11"},
    "agent_run_id": "<id de esta vuelta>"
  }
}
```

A quote returns quote_token/credits bound to its client_request_id; generating reuses that exact ID. quote_token and accepted_credits live outside piece; business_id/client_request_id/agent_action_id are not piece fields. All8brief fields are required. on_image_text is literal displayed text. aspect_ratio4:5/1:1/9:16; real product photos/brand are server-supplied. Read job.status=completed, images[0].id and actual judge warnings. Raw gcsPath is not the ad thumbnail; upload returns media_ref.

##3. Intentional variation of completed master

```json
{
  "business_id": "<uuid>",
  "piece": {
    "role": "variation",
    "master_ref": {"job_id": "<jobId de la maestra>", "image_index": 0},
    "variations": [{"changes": [{"dimension": "scene", "to": "La misma persona en la ducha con vapor suave"},
                                {"dimension": "on_image_text", "to": {"headline": "Cinco minutos solo para ti", "cta": "Conócelo"}}],
                    "keeps": ["visual_style", "color_treatment", "product", "brand"]}],
    "bet_id": "<bet_id>",
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.11"},
    "agent_run_id": "<id de esta vuelta>"
  }
}
```

changes must be nonempty. Valid dimensions: angle,scene,subject_action,composition,camera,lighting,mood,on_image_text,aspect_ratio,avatar_casting. Read variations[].job_id like the master; preserve keeps and lineage.

##4. Upload generated/owner media — medios subir

```json
{"business_id": "<uuid>", "action": "image", "source": {"kind": "gen_image", "jobId": "<jobId>", "variationId": "<images[0].id>"}}
```

Returns image_hash plus media_ref; same--id returns same result. Preserve media_ref.gcs_path, not Meta's expiring4–5day URL. Existing owner upload uses source.kind=gcs_upload,gcsPath,fileName from the trusted photo marker; never invent a path or use another business's file. Request real files through the current channel where supported; without attachments continue with an authorized generated piece and identify later replacement. No invented shared folders/media panels or technical upload instructions.

##5. Campaign tree — campana publicar
Server forcesPAUSED and supplies the owner's page/Instagram; do not hardcode them. Pixel is not auto-supplied; the current reference uses OUTCOME_TRAFFIC and no website OUTCOME_SALES. Respect actual server schemas and resources.

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

Budgets use account minor currency units: COP,CLP,JPY,PYG,CRC,KRW,VND,HUF,ISK,TWD,IDR use the currency itself (45000=45,000COP); MXN,USD,EUR and other fractional currencies use×100 (4500=45MXN/USD). Verify account currency with meta/ctx. Budget goes on adset(ABO) or campaign(CBO), not both. Valid objectives OUTCOME_TRAFFIC/OUTCOME_SALES/OUTCOME_LEADS/OUTCOME_ENGAGEMENT/OUTCOME_AWARENESS. Tree IDs are unique temporary IDs; returned IDs are canonical. Each ad has actual media_refs from upload. image_hash is normal; supported picture URLs are copied byMeta, but never rely on expiring returnedMeta URLs. Read full details.meta_error/error_user_msg; distinguish rejected corrected requests from uncertain duplicate effects. Read publication_id/campaign_id/meta_campaign_id and actual child IDs. budget_check predicts fit in remaining monthly total before activation request; never exceed approved spend without owner approval.

##6. Activation request — encendido pedir

```json
{"business_id": "<uuid>", "publication_id": "<publication_id que devolvió campana publicar>"}
```

Use returned publication_id, not SaleADS/Meta campaign_id. Share returned action_url with object/audience/amount and wait; do not repeat a pending request blindly. Read traza and actual state. This manual never grants activation or proposal-only publication.
