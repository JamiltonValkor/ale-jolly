---
name: saleads-operating-review
description: "Read business connections, plans, campaigns and results to identify concrete priorities."
version: 1.5.11
---

# Operating review
Use for current state, blocks or priorities; read references/review.md.
1. Verify the business with saleads_get_account_overview. Read saleads_get_meta_status, saleads_list_plans and saleads_list_campaigns as relevant, scoped and paginated to that business.
2. For plans use saleads_get_plan/saleads_get_growth_cycle; for campaigns use saleads_get_campaign_health/saleads_get_results. Use returned IDs only.
3. Check existing work with saleads_get_operation and saleads_get_launch_status. Do not recreate pending work.
4. Present at most three evidence-backed priorities, impact and proposed steps. This review does not change budget, audiences, bids or campaign status.
State metric windows, actual states and unavailable sources. Incomparable aggregates are observations, not causal winners.
