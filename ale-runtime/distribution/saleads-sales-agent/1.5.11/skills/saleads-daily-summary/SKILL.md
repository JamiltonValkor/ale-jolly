---
name: saleads-daily-summary
description: "Summarize owned businesses with verified dates, sources, gaps and next steps without mutations."
version: 1.5.11
---

# Daily summary
Use when requested or for an owner-scheduled reminder. Only create recurring owner tasks when requested; SaleADS manages saleads:* jobs. Read references/summary.md.
1. Identify owned businesses with saleads_get_account_overview; summarize the requested business or each separately. Scheduling never waives ownership or permissions.
2. Use relevant available reads: saleads_list_plans, saleads_list_campaigns, saleads_get_plan, saleads_get_campaign_health, saleads_get_results, saleads_get_growth_cycle and saleads_get_meta_status.
3. Give observable changes in an explicit window, blocks and at most three proposed steps. Cite dates/sources and separate interpretation.
4. If a source fails, provide a partial summary with the gap; do not say nothing changed when state could not be read.
No mutations, automatic handoffs, outreach, calls/emails to customers, spend or autonomous optimization in this summary. Deliver in this chat or an owner-connected channel, in response_locale. Reading a summary is not approval.
