BUSINESS = "00000000-0000-4000-8000-000000000002"

SEED = {
    "schema": "saleads-seed/1",
    "generated_at": "2026-11-02T10:04:14+00:00",
    "businesses": [
        {
            "schema_version": "saleads-business-bootstrap/1",
            "business_id": BUSINESS,
            "generated_at": "2026-10-28T20:39:06.000Z",
            "context": {
                "facts": {
                    "business": {
                        "name": "Example Beauty",
                        "industry": "beauty",
                        "website": "https://Example Beauty.example",
                    },
                    "brand": {"tone": "cercano"},
                    "audience": {"description": "Mujeres 25-45 que cuidan su piel"},
                    "marketing": {},
                    "products": [{"id": "p1", "name": "Sérum facial", "price": 89000, "currency": "COP"}],
                    "services": [],
                },
                "buyer_fit": {"pain_points": {"value": ["piel seca"]}},
                "evidence": [],
                "unknowns": [],
            },
            "plan": {
                "plan_id": "pl1",
                "status": "active",
                "campaigns": [
                    {
                        "item_id": "i1",
                        "name": "Novias",
                        "status": "launched",
                        "hypothesis_id": None,
                        "communication_summary": {
                            "tension": "No hay tiempo",
                            "promise": "Maquillaje que dura",
                            "audience": "Novias",
                            "cta": "Escríbenos",
                        },
                    }
                ],
            },
            "campaigns": [
                {
                    "campaign_id": "c1",
                    "name": "Novias Meta",
                    "status": "active",
                    "platform": "meta",
                    "metrics": {"metrics": {"spend": 120.5, "conversions": 7}},
                }
            ],
            "business_metrics": None,
            "seasonal": [],
            "warnings": [],
        }
    ],
}
