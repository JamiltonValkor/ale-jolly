---
name: saleads-reading-diagnosis
description: "Review actual comparable campaign results and real owner feedback; distinguish a proposal audit from performance evidence."
version: 1.5.11
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
Review the research, strategy, structure and real owner feedback provided in this work. Classify supported claims, missing proof, contradictions and requested changes. If no campaigns have delivered, state insufficient performance evidence; do not invent results, verdicts or result UUIDs. Do not call brain_record_result/brain_record_verdict to manufacture a review. Return a proposal audit for the optimizer with actual sources and the owner's original feedback.

## Data and windows for later running campaigns
- Business data comes only from relevant SaleADS MCP reads: saleads_list_campaigns, saleads_get_box_metrics, saleads_get_campaign_ads and saleads_get_cycle_sales where exposed. No platform access means unknown, not zero.
- Use actual owner lead feedback (who asks/buys, questions and objections), available source files, brain_query bets and earlier readings.
- Platform metrics are cumulative. A reading window is the difference between two dated readings. Store actual brain_record_result with as_of and compare the previous snapshot; never compare one cumulative total to another box's window.
- Before a verdict, each box needs at least one target cost per purchase (or evidenced business average) of spend and at least 3 days active. An evidenced business-specific minimum may replace this with explanation. Below the minimum means insufficient data, not lost.
- brain_decide kind=evidencia is advisory; sin_senal does not replace judgment or evidence.

## Verdict
Compare only boxes in the same campaign/window, or campaigns of the same plan launched together with equal daily budget and window. After the minimum, state won in this test or lost in this test; continue only for a tie within noise. A box with no sales after the minimum lost this test. Contrast lead volume with genuine lead quality; ask Ale to request missing feedback once. Never infer universal causes. Store actual brain_record_verdict linked to returned bet_uuid/result_uuids; replace contradicted conclusions with dates, do not erase history.

## Funnel diagnosis
Find the first evidenced failure: ad fails to stop relevant attention → click reaches no useful destination → leads do not buy → purchases cost too much → offer/price/product itself does not respond. Consider ticket, quantity offer and comparable boxes. If nothing won after the minimum, question audience, offer or product before recommending more spend.
For an owner-supplied landing, request the investigator to research it with saleads_web_search; do not use another web reader. Check ad/landing pain and promise consistency, supported claims, clarity and friction. Do not claim a page loaded if search did not verify it.

## Actual result handoff
Return box state, window metrics, lead-quality comparison, first failing point and recommendation to Ale. No campaign mutations.
For actual readings only: brain_record_result per box with actual accumulated spend/purchases/leads and as_of; then brain_record_verdict per actual bet with result_uuids and minimum used. If rejected, report the reason. Preserve dated evidence in memory before kanban_complete. A proposal audit is not an advertising verdict.
