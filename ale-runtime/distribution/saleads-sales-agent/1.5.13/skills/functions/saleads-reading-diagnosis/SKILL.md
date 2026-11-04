---
name: saleads-reading-diagnosis
description: "Review actual comparable campaign results and real owner feedback; distinguish a proposal audit from performance evidence."
version: 1.5.12
metadata:
  hermes:
    category: saleads-analysis
    tags: [saleads, analysis, verdict, leads]
  saleads:
    origin: saleads
    confidence: medium
---

# Reading and diagnosis
Judge purchases, cost per purchase and lead quality, not vanity metrics alone.

## Proposal-only first work
Review the research, strategy, structure and real owner feedback provided in this work. Classify supported claims, missing proof, contradictions and requested changes. If no campaigns have delivered, state insufficient performance evidence; do not invent results, verdicts or result UUIDs. Do not manufacture a stored measurement or verdict from a proposal review. Return a proposal audit for the optimizer with actual sources and the owner's original feedback.

## Data and windows for later running campaigns
- Business data comes only from relevant SaleADS MCP reads: saleads_list_campaigns, saleads_get_box_metrics, saleads_get_campaign_ads and saleads_get_cycle_sales where exposed. No platform access means unknown, not zero.
- Use actual owner lead feedback (who asks/buys, questions and objections), available source evidence, the automatic business/role ContextPack and saleads_memory_recall for actual bets, earlier readings and applicable experience.
- Platform metrics are cumulative. A reading window is the difference between two dated readings. Preserve actual source-linked readings with as_of in the native handoff for automatic curation and compare the previous snapshot; never compare one cumulative total to another box's window.
- Before a verdict, each box needs at least one target cost per purchase (or evidenced business average) of spend and at least 3 days active. An evidenced business-specific minimum may replace this with explanation. Below the minimum means insufficient data, not lost.
- A stored recommendation or insufficient signal does not replace judgment and source evidence. Legacy brain_decide/local-memory routes are unavailable in this managed path; do not retry unknown tools.

## Verdict
Compare only boxes in the same campaign/window, or campaigns of the same plan launched together with equal daily budget and window. After the minimum, state won in this test or lost in this test; continue only for a tie within noise. A box with no sales after the minimum lost this test. Contrast lead volume with genuine lead quality; ask Ale to request missing feedback once. Never infer universal causes. Return an evidence-backed assessment linked to actual bet/result identities and source dates for the automatic curator; replace contradicted conclusions through sourced history rather than erasing it.

## Funnel diagnosis
Find the first evidenced failure: ad fails to stop relevant attention → click reaches no useful destination → leads do not buy → purchases cost too much → offer/price/product itself does not respond. Consider ticket, quantity offer and comparable boxes. If nothing won after the minimum, question audience, offer or product before recommending more spend.
For an owner-supplied landing, request the investigator to research it with saleads_web_search; do not use another web reader. Check ad/landing pain and promise consistency, supported claims, clarity and friction. Do not claim a page loaded if search did not verify it.

## Actual result handoff
Return box state, window metrics, lead-quality comparison, first failing point and recommendation to Ale. No campaign mutations.
For actual readings only, include each box's genuine accumulated spend/purchases/leads, as_of, comparable prior snapshot, actual bet/result identities and minimum used in the native handoff. The automatic curator validates provenance and consolidates appropriate observations/experience; do not call unavailable direct Brain writers. If a separately authorized SaleADS commercial ledger command is announced, follow its real schema and returned identities rather than inventing an endpoint. Report missing capability precisely and preserve dated evidence before kanban_complete. A proposal audit is not an advertising verdict.
