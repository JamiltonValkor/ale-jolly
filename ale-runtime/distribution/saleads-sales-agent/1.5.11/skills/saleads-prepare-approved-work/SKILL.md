---
name: saleads-prepare-approved-work
description: "Work on the classic SaleADS web plan only when explicitly requested; preserve its existing confirmations and lineage."
version: 1.5.11
---

# Prepare approved classic web work
Use only when the owner explicitly asks to prepare/correct the classic web plan. Agent-authored bets use saleads-loop-orchestration and the CLI instead. Read references/preparation.md and saleads-human-decisions.
1. Read saleads_list_offerings, saleads_get_plan and saleads_get_strategy; verify every resource belongs to this business.
2. Present confirmed offer, destination, language, total monthly media budget and currency before saleads_start_strategy. saleads_regenerate_strategy creates a version and needs confirmation too. Strategy owns the decision.
3. Use saleads_approve_strategy only after confirmation of that exact version. Re-read the plan and preserve campaign count/allocation.
4. saleads_update_plan, saleads_prepare_campaign, saleads_update_campaign_copies and saleads_approve_campaign require current object/argument confirmation.
5. Follow saleads_get_operation and verify saleads_get_plan. Approval/preparation is not publication.
Respect unavailable tools/read-only scopes. Use the existing web image/file step; do not replace it with terminal uploads or alternate image generators. Do not create/switch business unasked. Preserve hypothesis, variables and evidence.
