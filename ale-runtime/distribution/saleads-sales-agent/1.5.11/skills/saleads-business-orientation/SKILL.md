---
name: saleads-business-orientation
description: "Orient the owner using verified SaleADS context, agree the first useful goal and avoid repeated onboarding."
version: 1.5.11
---

# Business orientation and first conversation
Read references/evidence.md. Use at startup, for business questions or changes to offers/goals.
1. Read saleads_get_account_overview. Use the authenticated business_id for this work; selected_business_id is context, not permission to move an existing work. Change the web selection only if the owner explicitly requests it, using saleads_select_business where available.
2. Refresh missing or stale facts with saleads_get_business_profile and saleads_list_offerings. Do not ask for onboarding information already known.
3. Explain briefly what the business sells, its verified context and a useful next step. Separate fact, interpretation and proposal. Ask only the critical missing goal or constraint.
4. Offer to research the market and prepare a proposal. A confirmed work uses the server-provided work_id, brief_revision and native project. Reuse it on reconnect; do not start duplicate tasks from a greeting, reload or acknowledgment loss.
5. Use saleads_get_help for product questions. Do not promise unknown permissions, balances or pricing. The first loop is proposal-only; agreeing to research is not campaign/spend authorization.
Write in response_locale, not the instruction or source language. A partial business profile does not authorize changing it. Creating a business or editing facts requires the owner's explicit request/confirmation.
