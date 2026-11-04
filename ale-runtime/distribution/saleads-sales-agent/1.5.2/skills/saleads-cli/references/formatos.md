# Formatos del canal del agente

Ejemplos exactos que SaleADS acepta: la forma, no las ideas. Las apuestas, los briefs y la estructura los decides tú
(con tu equipo y tus skills); aquí solo está cómo se escriben para que el comando los acepte. Escribe cada uno en un
JSON con `write_file` y pásalo con `--archivo`. Si la respuesta trae `MCP-E-INVALID-INPUT`, corrige exactamente los
campos de `details.fields` y vuelve a llamar.

## 1. Apuestas — `saleads apuestas registrar --archivo apuestas.json`

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
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.2"}
  }]
}
```

- `awareness_stage`: `unaware`, `problem_aware`, `solution_aware`, `product_aware` o `most_aware`.
- `claim_status`: `supported` (con evidencia aprobada), `restricted` o `untested`. Nunca inventes prueba (invariante 8).
- `attribution_unit`: `ad_set` si cada caja prueba una apuesta; `campaign` si la campaña entera es una apuesta.
- `bet_key` en minúsculas, sin espacios, único en la vuelta. La respuesta devuelve `bet_id` por `bet_key`: guárdalos.
- En una vuelta nueva agrega `"source_version_id": "<communication_strategy_version_id de la vuelta anterior>"`.

## 2. Pieza maestra — `saleads piezas cotizar` y luego `saleads piezas generar`

```json
{
  "business_id": "<uuid>",
  "piece": {
    "offering": {"item_id": "<uuid de la oferta>", "item_kind": "product"},
    "brief": {"scene": "Tocador de baño con luz de mañana y plantas", "subject_action": "Manos aplicando el producto en el cabello húmedo",
              "composition": "Producto en primer plano a la izquierda", "camera": "50mm", "lighting": "Luz natural lateral suave",
              "visual_style": "Editorial limpio y cálido", "color_treatment": "Verdes y crema", "mood": "Calma",
              "on_image_text": {"headline": "Tu ritual de cada mañana", "cta": "Conócelo"},
              "negative_constraints": ["sin reseñas ni estrellas", "sin afirmaciones médicas"]},
    "bet_context": {"avatar": "Mujer de 30 a 45", "pain": "Cabello opaco", "angle": "Ritual de autocuidado", "promise": "Cabello suave"},
    "aspect_ratio": "4:5",
    "bet_id": "<bet_id>",
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.2"},
    "agent_run_id": "<id de esta vuelta>"
  }
}
```

- Cotizar devuelve `quote_token` y `credits`. Para generar, el mismo archivo más `"quote_token": "…"` y
  `"accepted_credits": <credits>` **fuera** de `piece`. Nunca pongas dentro de `piece` `business_id`,
  `client_request_id`, `quote_token`, `accepted_credits` ni `agent_action_id`: los pone SaleADS.
- Los 8 campos de `brief` son obligatorios. `on_image_text` es literal: lo que escribas es lo único que sale escrito.
- `aspect_ratio`: `4:5` (feed), `1:1` o `9:16`. Las fotos reales del producto y la marca las pone SaleADS.
- `generar` devuelve `jobId`. Con `saleads piezas ver --campo job_id <jobId>` (el CLI agrega el negocio) esperas `job.status = completed` y tomas
  `images[0].id` y `images[0].gcsPath`. `judge` trae avisos (fidelidad y rúbrica): los lees y decides.

## 3. Variación — sobre una maestra terminada

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
    "skill_ref": {"skill_id": "saleads-type-physical-product", "skill_version": "saleads-sales-agent@1.5.2"},
    "agent_run_id": "<id de esta vuelta>"
  }
}
```

- Cada variación cambia algo a propósito (`changes` no vacío). `dimension`: `angle`, `scene`, `subject_action`,
  `composition`, `camera`, `lighting`, `mood`, `on_image_text`, `aspect_ratio` o `avatar_casting`.
- La respuesta trae `variations[].job_id`: cada una se lee igual que la maestra.

## 4. Subir una pieza a la cuenta de Meta — `saleads medios subir --archivo medio.json`

```json
{"business_id": "<uuid>", "action": "image", "source": {"kind": "gen_image", "jobId": "<jobId>", "variationId": "<images[0].id>"}}
```

Devuelve `image_hash`: es lo que va en el anuncio. Para una imagen del dueño: `"source": {"kind": "gcs_upload", …}`
después de `action: signed_url`.

## 5. Árbol de campaña — `saleads campana publicar --archivo arbol.json --esperar 180`

Objetos de Graph de Meta, tal como los crea Meta. SaleADS fuerza la pausa y pone la página, Instagram y el píxel del
dueño: no los escribas.

```json
{
  "business_id": "<uuid>",
  "bet_id": "<bet_id>",
  "skill_ref": {"skill_id": "saleads-estructura-optimizacion-juan", "skill_version": "saleads-sales-agent@1.5.2"},
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
  "media_refs": {"anuncio-1": {"gcs_path": "<images[0].gcsPath>"}}
}
```

- **Presupuesto en la unidad menor de la moneda de la cuenta, como Meta:** en COP es el valor en pesos
  (`20000` = $20.000 diarios); en USD son centavos (`2000` = US$20). En la caja (ABO) o en la campaña (CBO), no en las
  dos.
- `objective`: `OUTCOME_TRAFFIC`, `OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_ENGAGEMENT` o `OUTCOME_AWARENESS`.
- Cada `id` (campaña, caja y anuncio) es temporal y único dentro del árbol; la respuesta te da los ids de Meta.
- Cada anuncio necesita su `media_refs` (la miniatura en SaleADS).
- Si Meta rechaza algo, el error viene completo en `details.meta_error` (`error_user_msg` dice qué cambiar): corrige y
  publica de nuevo con otro `--id`.
- La respuesta (o `op`) trae `publication_id`, `campaign_id`, `meta_campaign_id`, los ids de cajas y anuncios: con
  `publication_id` pides el encendido (`saleads encendido pedir --campo publication_id <id>`).
