# First loop v1 (additive Meta-only contract)

Base: `/assistants/me/businesses/:businessId/first-loop`.
BFF: `/api/meta-assistant/businesses/:businessId/first-loop`.
All routes require verified web session, existing assistant flag, per-request business ownership, managed Meta pilot and normal same-origin mutation checks. Never accept owner/VM/token in the browser body.

| Method/path | Request | Response |
| --- | --- | --- |
| GET base?response_locale=es\|en | Effective SaleADS locale | 200 FirstLoopStateV1; initializes/reuses this business flow, retains existing classic saleads-main |
| POST base/messages | FirstLoopMessageRequestV1 | 202 FirstLoopAcceptedV1; native async run accepted; poll GET base for history/turn/work |
| POST base/kickoff | FirstLoopKickoffRequestV1 + Idempotency-Key (8–128 URL-safe chars) | 202 FirstLoopAcceptedV1; replay returns same work/run; stale brief409 |
| GET base/works/:workId | Optional cursor opaque string; full latest state remains authoritative | 200 FirstLoopWorkV1; snapshot absent is missing, never completed/empty |
| POST base/works/:workId/feedback | FirstLoopFeedbackRequestV1 + Idempotency-Key | 202 FirstLoopAcceptedV1; binds actual owner text and artifact_revision, advances one work revision |

JSON responses are direct schema objects (no data wrapper). Error envelope remains existing `{code,request_id}`:401/403/404 ownership;409 INVALID_REQUEST for stale/conflicting revision/key/body;503 SERVICE_UNAVAILABLE or ASSISTANT_NOT_READY409. No fallback to classic runtime. locale is required on message/feedback, supported es/en. Changing locale never changes existing evidence text/citations. Disconnecting polling does not cancel native workers. Duplicate client_message_id or Idempotency-Key with different request digest returns409, same digest reuses accepted receipt. No automatic message resend after uncertain acknowledgment.

## Native artifacts and projection

Ale intake writes `/opt/data/saleads/first-loop/flows/<flow_id>/brief.json` containing `{flow_id,business_id,brief_revision,brief,missing_fields}` matching FirstLoopProjectionV1.briefs[]. Owner IDs/quotes must refer to actual received client_message_ids; backend checks exact quotes against encrypted accepted owner text before persisting a proposed revision. An agent's statement never counts as owner confirmation.

Confirmed work uses native Kanban `tenant=business_id` (no synthetic Git project). Every native task body starts/contains a line `SALEADS_FIRST_LOOP_TASK_V1 {"stage":"research","revision":1,"response_locale":"es"}` (stage from FirstLoopStageV1; profile determined from native assignee). The marker business must equal native tenant, and the backend verifies work_id against its owner/business registration. Use native idempotency_key scoped to work/stage/revision. Native `task_runs` are required to verify execution; empty results do not complete stages. Specialist results use native result/attachments, never backend-written task states. Stages research→strategy→structure precede owner feedback, then analysis→optimization. Feedback does not represent campaign-performance metrics. Root Ale synthesizes actual results.

Projection object `first-loop-uploads/<owner>/snapshot.json.gz` is private, read-only SQLite export and contains FirstLoopProjectionV1. Backend projects only registered owner/business/work IDs. Missing, invalid, stale or unavailable snapshots preserve last known data and observed_at. Artifacts are inline bounded text/JSON with SHA256, byte count and safe citations; no raw host paths/secrets/credentials.
