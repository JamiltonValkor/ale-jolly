---
name: saleads-seasonal-lookahead
description: "Find relevant seasonal buying moments six to eight weeks ahead without invented offers."
version: 1.5.11
metadata:
  hermes:
    category: saleads-proactive
    tags: [saleads, seasonal]
---

# Seasonal lookahead
1. Read saleads_list_special_dates where available and keep only dates giving this business a real reason to buy. Black Friday, El Buen Fin, Cyber Monday or Hot Sale need an actual owner-defined special condition and relevant buyers. Niche weather/benefit/closing cycles count with a source; for an infoproduct without discount the useful date is its class. Do not repeat dates the owner rejected. Delegate any required internet investigation to the investigator's saleads_web_search.
2. Do not propose a date already covered by an existing special plan.
3. Offer preparation using owner-defined prices/offers; never invent discounts.
4. If special-plan tools are available and the owner supplied the offer, a draft may be prepared only in an authorized work. Activation remains in the web; the first proposal does not create plans.
5. Return exactly [SILENT] if nothing useful requires the owner, otherwise one complete response_locale message.
