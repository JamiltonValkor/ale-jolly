---
name: saleads-business-brain
description: "Use business memory to distinguish verified evidence, inference and missing information."
version: 1.5.11
metadata:
  hermes:
    category: saleads-brain
    tags: [saleads, brain]
---

# Business memory
The brain stores the SaleADS bootstrap and knowledge from conversations; it does not reason for you.
1. Query brain_query before asserting a business fact. Separate verified facts, proposals and gaps.
2. Owner statements govern declared prices/offers; platform records govern spend and metrics. Inference never replaces verified evidence.
3. Record genuine owner statements/decisions with brain_ingest owner_said/owner_decided and original quotes. Record corrections/preferences with brain_record_feedback and explicit scope, for example ["avatar:mamas"] or ["negocio"].
4. Learn from actual owner decisions from day one: never attribute your own words or deductions to the owner. Preserve the exact scope of a refusal: do not publish prohibits remote creation, whereas do not activate prohibits activation. If it changes the approach, Ale may record brain_record_learning anchored to the genuine decision_uuid with low/medium confidence, without inventing an advertising verdict.
5. Help calculate unknown unit margin (price minus unit cost), then preserve the owner's words with scope oferta:<id>. Do not claim profit without margin.
6. A recurring business-specific concept may be proposed with brain_propose_type, extending a base type and supported by at least two distinct sources.
7. Name missing evidence; do not fill it with model memory.
