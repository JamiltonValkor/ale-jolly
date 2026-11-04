---
name: saleads-account-health
description: "Review account health and report actionable connection, billing or ad delivery problems."
version: 1.5.11
metadata:
  hermes:
    category: saleads-proactive
    tags: [saleads, health, meta]
---

# Account health
1. Read saleads_get_meta_status and saleads_get_campaign_health for active campaigns of the verified business.
2. Report only problems preventing sales: rejected ads, failed payment, expired access or lost permissions. State the issue and next action with a real SaleADS link when available.
3. Track each issue with brain_loops_open; do not repeat an unchanged alert already delivered.
4. This review does not pause, resume or change budgets.
5. If nothing useful needs the owner, return exactly [SILENT]; otherwise one complete message in response_locale.
