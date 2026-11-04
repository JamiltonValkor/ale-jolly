---
name: saleads-landing-pilot
description: Orchestrate the managed landing coding specialist when a SaleADS growth bet needs a landing, using the existing SaleADS CLI and owner web publication.
---

# Managed landings — native growth-loop integration

This managed capability is available to each authenticated assistant only within its live CLI discovery/scopes, trusted owner/business context and current owner mandate.
It adds the native profile disenador_landings to the existing specialist team. Do not rewrite managed skills.
Keep muse-spark-1.3-contributor. The owner sees normal locale-correct chat and a real SaleADS review link.

## Required dispatch for creation AND feedback

This division also applies to an existing draft and to small HTML/CSS changes. Ale does not author the
page. Before any creative file change, use the live native kanban_create tool with assignee
disenador_landings, verified tenant and a stable idempotency key for this landing/revision/phase. Read the
actual tool schema; record its task_id and subscription receipt. If that tool is unavailable, inspect the
official /opt/hermes/.venv/bin/hermes kanban --help and use its documented CLI, then verify the native
subscription. Never invent a command or task ID. A generic delegate or Ale writing code does not satisfy this delegated workflow.

Pass the existing page/design files and the owner's exact feedback for a revision; the specialist preserves
what was not requested. Ale may write request/metadata JSON, package or copy actual specialist output,
and adopt the service's deterministic finalized files. Ale must not create or edit creative HTML/CSS itself.
If dispatch fails, report the actual error and preserve the pending work instead of bypassing the role.
For screenshots, use a follow-up review assignment if needed; Root obtains actual captures through CLI,
and the specialist inspects them with its same-Spark vision tool. Do not claim vision from saved files alone.

## Decide from strategy, then delegate

A landing is a dependency of a communication bet/campaign whose chosen destination needs one.
The owner does not have to ask for a landing. Recover the current business/goal/bet and permitted sources,
compare a direct destination/reuse with a new page, and use the page only when the strategy justifies it.
Keep canonical Strategy bet/hypothesis/version references; never invent IDs or replace strategy_id semantics.
When an existing bet is available, reuse its actual references. If a new bet must be recorded, do so only
through the discovered authorized strategy command with a real saleads:strategy grant and the current mandate.
A read-only grant does not authorize creating a bet or persisting Landing: report the exact scope blocker.
Do not bypass API policy, use a web bearer as the assistant, or grant yourself permissions.

## CLI and files

Root helper: python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py <live command>
--args <private-json> [--workspace <artifact-directory>] --output <private-json> [--extract <directory>].
It reuses the installed SaleADS CLI's token/host/executor. Read its local README and live schemas for shapes.
Never call /api/landing or internal services from Hermes; never send gateway/Cloudflare/Browserless credentials.

Read saleads_landing_context with business_id and the canonical bet_id first (not landing_id together).
It returns the current schema/defaults, canonical_lineage, business, offering, strategy_sources and
source_refs. Use those guarded BI references, not pictures copied from research or guessed URLs.
Use context/bootstrap/offers and the bet read commands to build the existing LandingContextV1:
negocio/oferta/businessType/apuesta/promesa/avatar/dolores/deseos/objeciones/cta and allowed facts/photos.
Use country/currency/locale from trusted context. No testimonials unless the facade can resolve actual owner
approval; the pilot currently accepts none. Missing information stays missing, not invented interview answers.
Copy the canonical business/offer names and strategy_sources.promise.claim literally. A hypothesis remains
a hypothesis; do not convert its claim_status into verified proof. Preserve the registered price/currency
when present. Build the final create JSON by deterministically merging the saved canonical response's
photo_urls and logo_url into the authored context; do not have a model retype long signed URLs. Their
signatures may rotate, but the server verifies the same authorized storage object, not arbitrary sources.

Search existing pages with saleads_landing_list/get before create. Create via saleads_landing_create with
stable client_request_id and canonical lineage. Save the returned landing_id/lineage and actual review path.
Immediately call saleads_landing_prepare_assets for that landing before delegating design. This warms
the existing persistent cache while the source signatures are fresh. Pass the resulting owned HTTPS asset
URLs and their mapping to the designer. A failed photo preparation is a concrete blocker, never permission
to fetch arbitrary URLs or silently omit a required product photo. Reads/checks can be resumed; do not
repeat a write after uncertain acknowledgement. The helper follows existing asynchronous create receipts
by saleads_get_operation; if still pending, resume that read using the saved operation_id.
Create a native Kanban task assigned to disenador_landings with tenant=current business, a stable idempotency
key and the full brief/context bindings. Use the documented live native tool schema/CLI; do not invent APIs.
Provide task workspace, landing_id, expected_latest_n, locale and actual photo/catalog references.
Native Kanban controls concurrency. Resume the same assignment/revision rather than spawning duplicate pages.

The specialist writes page.json, design.json, index.html, styles.css, review.json and review-evidence.json
inside its task workspace. Collect its actual output through Kanban. Read errors/limitations instead of
claiming completed work from the task status. Allow code quality corrections before asking the owner to review.

## Catalog, validation, actual vision and admission

Use saleads_landing_design_catalog and prepare_assets to retrieve real fonts/icons/photos/references.
The specialist must be given those real files/results; a filename/hash alone does not load a reference.
Build metadata using /opt/data/saleads/landing-pilot/build_metadata.py and the canonical Landing response.
That adapter maps fonts and the closed review schema; do not send review-evidence keys as metadata.review.
Use saleads_landing_validate --workspace ... --extract ... . Copy/use the finalized files and matching digest.
Use saleads_landing_preview on the same finalized artifact. Extract actual JPEGs, let the specialist inspect
with its same-Spark vision_analyze tool, collect review and apply targeted corrections. Image availability
alone is not proof the model saw it. If visual review failed, declare visualSkipped; do not fabricate a pass.
Use the same finalized files/metadata in saleads_landing_submit_version with expected_latest_n and a stable
request ID. Lost ACK: recover the same receipt/request before any retry. Version conflict: reread/reconcile.

Only after readback confirms the saved n and files, send a short owner-language message with the actual
/{locale}/dashboard/agent-landings/{landing_id} review link. No internal JSON, profiles, scores or Kanban cards.
Saving a page is permitted only by the live strategy scope; it is not permission to publish or spend.

## Feedback and continuation

Owner changes come through normal chat/home with a page/version reference. Verify business ownership
and current version through CLI, then assign a focused revision on the same landing. Preserve good content,
original data-edit IDs and public version. New revision gets a new request ID and requires owner web review.
The owner reviews/publishes a specific n using SaleADS's existing panel. Do not publish via CLI/terminal/API.
Read actual publishedN/URL through saleads_landing_get. Only then resume the linked campaign destination/work
with the actual URL under existing commercial permissions; no automatic launch/spend from page publication.
A pending page blocks only its dependent action; the business goal persists after the proposal is prepared.

For that continuation, discover `saleads_agent_prepare_landing_destination` and
`saleads_agent_get_landing_destination`. Use them through the same Root helper,
not an internal endpoint or `saleads_agent_publish_campaign`. Supply the bound
business_id, canonical bet_id, landing_id, exact published_n, expected_revision
and a stable client_request_id tied to this work/publication phase. The server
resolves the URL, digest and intent; never send a self-authored approval or URL.
For a first binding expected_revision is0; for an intentional change read the
stored revision first. Do not derive a revision from a generic error. A known
LANDING_DESTINATION_NOT_FOUND is distinct from an unavailable or unauthorized
command. A CAS conflict requires readback and reconciliation, never a blind
increment or a different request key for the same uncertain action.

After preparation, read the destination and verify binding IDs, published_n,
digest and URL against the original publication. Inspect current_publication
separately: a stored binding does not prove the page remains published. Consume
the wait only when its state is published and matches_binding is true. On a lost
ACK preserve the original input and key; recover that same receipt. Only this
readback can consume the destination wait. Missing commands/scopes or a failed
read keep the dependent work waiting while other permitted work continues.
Notify the owner in their SaleADS locale using business language; do not expose
these commands, schemas, scopes, specialists or technical state controls.

## Keep the publication dependency durable

After saving the reviewable version, append a kanban_comment to the actual designer task. Record
tenant, business_id, work_id, creator_session_id, landing_id, expected_n, bet_id, the actual destination
reference, response_locale and state=pending_publication. Use verified existing values, never invented
IDs. Preserve the designer's completion and artifacts. This is internal workflow state, not an owner
statement, business fact or approval. kanban_update is not a registered tool in this runtime.

On every existing saleads:loop-tick, load this skill. Read this tenant's native tasks including done,
then kanban_show the actual task and its latest publication-wait comment. Do not infer absence from a
truncated list. Reconcile each wait without a verified destination-binding receipt, including older
notes marked consumed only because publication or its notice was observed. Do not rewrite those
historical notes or resend an already delivered publication notice. Read saleads_landing_get with the bound business and landing.
Only a real URL with publishedN == expected_n satisfies the external dependency. Resume the existing
linked destination work under current scopes, verify its persisted effect, then append a consumed/readback
comment. Otherwise preserve the wait and continue independent permitted work. Never republish, duplicate
tasks/versions, launch, spend or treat a wake/timer as owner approval. A missing destination command,
object or scope is a precise continuation blocker; it does not delay delivery of the first preview.

The current native loop tick runs every three hours. Landing publication does not itself send a Hermes
wake. Do not promise immediate publication detection. kanban_schedule only parks work; it is not a timer.
For coder completion, verify that kanban_create returned subscribed=true for Ale's actual session, so the
native notifier can wake that session. Do not replace the native notifier with fabricated owner messages.

Record useful source/task/version/feedback references through existing per-business memory/curator APIs
when available. Keep individual design experience separate from business facts, and apply relevant prior
corrections on the next assignment. Do not invent causal conversion lessons from clicks or rewrite skills.
