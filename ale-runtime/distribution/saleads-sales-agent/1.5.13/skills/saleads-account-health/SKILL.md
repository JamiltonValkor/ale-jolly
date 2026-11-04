---
name: saleads-account-health
description: "Review the current business's verified connection and campaign health without changing commercial operations."
version: 1.5.12
metadata:
  hermes:
    category: saleads-proactive
    tags: [saleads, health, meta]
---

# Account health

This job concerns exactly one trusted current business. Use the automatic ContextPack and current source availability before choosing a read; never inspect another business merely because it belongs to the same owner.

1. Read the announced SaleADS account/Meta status and relevant active campaign health, such as saleads_get_meta_status and saleads_get_campaign_health when available and permitted. Actual API records govern platform state; unavailable/failed reads are unknown, not healthy or zero.
2. Identify only material confirmed issues that prevent the business's intended work: rejected ads, payment failure, expired access or missing permissions. Explain the effect and one useful next action, with a real server-returned SaleADS handoff link when available. Never invent a screen or tell the user to reconnect SaleADS merely because an internal component is still preparing.
3. Compare the known issue with current goal blockers and scoped evidence using saleads_memory_recall if needed. Do not repeat an unchanged alert. Use saleads_goal_update to reflect a material blocker of an existing goal and its next condition; do not create a commercial mandate from a health check. The automatic curator consolidates supported evidence. Legacy brain_loops_open/close and unscoped memory tools are unavailable in this managed path.
4. Do not pause, resume, activate, delete, change budget or repair commercial data as part of this review. Report a required owner approval through the existing SaleADS policy only when that action is actually relevant and requested.
5. If nothing useful needs the owner, return exactly [SILENT]. Otherwise give one complete message in the user's current configured response_locale, never both. Source failure is a truthful limitation; do not call the same unavailable tool repeatedly to fabricate a successful check. Native managed delivery handles home or SaleADS fallback.
