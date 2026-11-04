# Managed memory contracts and ontology

The common ontology is `saleads-brain-ontology/2`. Its loader accepts `/1`, and
all 37 previous types remain readable. `SpecialistExperience` is the only new
type. It is typed-only: free extraction cannot create professional experience.
It has no spend, purchase or causal-winner fields. Business identity and role
partition instances; each specialist does not acquire an incompatible vocabulary.

The JSON schemas under `saleads_brain/contracts/mcl/` are exact distribution
copies of the runtime's `contracts/continuous-loop/v1/` schemas. A parity test
detects drift. Cross-field admission, evidence precedence and trusted bindings
are checked separately; schema validity does not establish the truth of a claim.

## Competency questions and routes

| Question | Representation | Entry | Read |
| --- | --- | --- | --- |
| What has actually been observed about the market? | Research / Competitor / Reference + Evidence | `MemoryWriter.candidate` using registered sources | `current`, `get`, source refs |
| Which owner declaration supports a business constraint? | Decision / OwnerNote and literal source | `candidate`, declared epistemic status | `current`, `get`, `source` |
| Is a conclusion an inference or a confirmed fact? | Candidate epistemic/validation state, independently derived provenance | admission policy | payload + verification |
| Which price is current, and what was replaced? | Offer + subject/field, versioned candidate, supersession | candidate with `attributes.subject_ref`, `field`, `value` | effective record + prior alias |
| Did a repeated transcript really add evidence? | Registered episode identity, independent of extractor | collector `register_source` + candidate replay | evidence count / source registry |
| What did this specialist try and learn? | SpecialistExperience with task, run, method, result, correction, applicability | `experience` with matching native source | role-scoped `current` / `get` |
| What can Ale or another role use from that experience? | Separately admitted business Research/Learning summary and refs | curator promotion as candidate | business/team records; no private transcript |
| What goal is the team pursuing or awaiting? | Optional GoalState, explicit proposed/confirmed origin, actual sources, native task refs, next condition | `put_goal` with revision check | `goal` returns null before a proposal is stored |
| Did a failed graph write lose the learning? | SQLite commit and pending projection receipt | `candidate` / `experience`, then `reconcile` | persisted payload and projection status |

`ABOUT` and `DERIVED_FROM` in the common vocabulary represent experience to
business/research/decision and a promoted Research/Learning to its experience.
`EVIDENCED_BY` represents the admitted source. The source registry is the source
of provenance; an edge or a token alone cannot establish owner authorship.

## Boundaries and admission

`MemoryContext` is created by the server/collector from an authorized binding;
it is not a model argument. Only the trusted collector registers SourceEvents.
Candidate tools receive source IDs and cannot manufacture their author, business
or original purpose. Aliases bind a legacy/new receipt to one source identity.
Technical canary, server instructions and generic owner preferences cannot become
business facts or transferable business learning through this writer.

Scalar candidates identify a `subject_ref` and an ontology `field`; these are
required together. A subject is an offer, campaign or another existing object,
not a campaign count or a free-form marketing statement. Equal values merge
source references; a changed value enters precedence/conflict handling even if
the curator omitted `supersedes_id`. Exact quoted owner corrections may replace
declared data. Ambiguous conflicts retain the last confirmed value. Inferences
do not replace confirmed facts. Owner recollections do not replace measured
platform values. Unsupported proof stays proposed.

An experience must reference a genuine specialist result with matching task,
run and role. The role can retrieve its own experience in a later session;
other roles and Ale only receive a separately curated summary. Private
experience nodes are omitted from the existing public business snapshot.

## Writer compatibility matrix

The libraries in this change are additive. Managed rollout must explicitly
wire the following policy before enabling its collector. The classic assistant
keeps its existing routes; no broad deployment flag is activated by this file.

| Existing writer | Existing behavior | Managed-policy integration requirement |
| --- | --- | --- |
| `brain_ingest` | Token caller asserts owner text; legacy OwnerNote | Remove unscoped entry from managed model tools; collector source ID + candidate path replaces it. Do not infer authorship from token. |
| `record_learning` | Verdict or Decision anchor | Retained; Decision-derived lesson is inferred, platform provenance only for Verdict. Replay merges evidence without incrementing counts. Managed source-backed path is preferred. |
| `record_fact` | Closed business-intelligence vocabulary | Keep its ownership/BI authority. It does not become a generic graph writer. |
| `ingest-day` | Routes by mention, then first business | Retire that routing for managed mode; consume explicit authenticated source bindings. No fallback to the first business. |
| `backfill-owner-notes` | Converts old asserted owner notes | Disable managed promotion. Preserve old events and node IDs; do not invent missing quotes or provenance. |
| `extract-lessons` | Optional collective abstraction | Remains off with Brain inference disabled. This wave creates no cross-business learning. |
| New curator commits | Validates registered SourceEvents and typed proposals | Enable only after hidden profile/collector integration and source adapters are verified. |

Source aliases must be registered by the collector for old/new references to the
same native episode. A repeated extraction or retry cannot increase independent
evidence. Rollback must stop new dispatches without deleting source/commit/goal
history; it must not re-enable unscoped managed writers alongside the collector.

SQLite migration v4 adds tables and preserves historical rows. Ledger-to-graph
projection is recoverable and idempotent, not a distributed transaction. No
model, embedding, scheduler, SaleADS commercial mutation or shared-network
change is introduced by this module.

## Private collector and bound wrapper API

Enable only in managed Meta mode with `BRAIN_MANAGED_CURATION=true` and
`BRAIN_OWNER_ID` fixed by the control registry. Existing `BRAIN_ALE_TOKEN` remains
private. Derive collector token with HMAC-SHA256(root token, `mcl-collector`), and
role token with HMAC-SHA256(root token, `mcl-profile:<role>`), both hex strings.
The canonical header is `x-saleads-memory-token`; `x-saleads-brain-token` remains
a collector-compatible transport alias. Never include either token in tool text,
model prompts, browser responses, logs or receipts.

Role calls additionally include `x-saleads-memory-context`, a base64url encoding
without padding of compact JSON (`sort_keys=true`, `ensure_ascii=false`) matching
TrustedContextV1. `x-saleads-memory-proof` is hex HMAC-SHA256 with the role token
ASCII string as key and the encoded context header as message. The native plugin
builds this envelope from actual session/tenant/task/run bindings. Models cannot
choose these fields in tool arguments; static credentials alone are rejected.

| Method/path | Caller | Body | Result |
| --- | --- | --- | --- |
| POST `/continuous/sources` | Collector | SourceEventV1 | `{accepted:true,event_id}` |
| POST `/continuous/ready` | Collector | No business or identity arguments | `{ready:true}` only with managed owner/secret, current ledger and available graph connection; no writes or inference |
| POST `/continuous/batches/pending` | Collector | `{business_id}` | `{batches:[CurationBatchV1]}`; eligible sources are coalesced first |
| POST `/continuous/batches/<id>/native` | Collector | `{business_id,task_id,run_id}` or `{business_id,error_code}` | `{batch}`; persisted task/run reused on replay |
| POST `/continuous/context` | Collector or signed role | `{business_id,actor_role,query,goal_id?,max_chars?}` | ContextPackV1; role body must match signed actual binding |
| POST `/continuous/curation/batch` | Signed curator | `{}` | `{batch,sources}` for its actual native run |
| POST `/continuous/curation/commit` | Signed curator | `{candidates,experiences,discarded_reason?}` | `{accepted:true,batch}`; no business/batch selector |
| POST `/continuous/goals` | Signed Ale | `{operation:"get"}` or bound upsert fields below | `{goal}` or `{accepted:true,goal}` |

Curator wrapper schemas omit owner/business/extractor identity. The wrapper
injects authenticated values before transmitting canonical candidate/experience
records. Candidates can refer only to original sources in their assigned batch.
For experience, the observed specialist role/task/run must match a registered
specialist result; curator execution identity cannot become the source author.

If the worker starts before its dispatcher's run observation, Brain checks its
actual running task/profile/tenant in the mounted read-only Hermes `kanban.db`
before first binding the run. It never writes native tables. SQLite v5 stores
batches/source disposition/cursors. Pending, dispatched, running and failed
batches survive restart; committed and discarded batches retain their receipt.
Native dispatch/inference remain Hermes responsibilities.

Context `max_chars` bounds the entire injected JSON text (128–6000 characters),
not only the sum of memory records. Whole entries are pruned; an oversized goal
is explicitly omitted and marked truncated. Returned arrays match `text`
exactly, with versions/refs only for delivered entries. No invalid JSON slicing
or spill file is used. This private API does not add another user-facing view.

Goal upserts use `operation:"upsert"` plus optional `mandate`, `origin`, `state`, `blockers`,
`next_condition`, `next_review_at`, `result_summary`, `native_task_ids`, current
`goal_id`, and `expected_revision`. Source IDs are injected by the native wrapper,
never chosen as model arguments. Guided onboarding begins with
`origin:"assistant_proposed"`, using the actual structured bootstrap/API context;
an owner command is not required. The owner can refine or confirm the proposal
through normal answers, without copying a goal description. An authenticated
current-session answer backs `origin:"owner_confirmed"`; its actual words stay
in their SourceEvent. Operator/server text is never relabeled as an owner answer.
Neither origin grants commercial permissions or counts as approval for spend.
Existing-goal advancement retains its original sources; cron cannot invent
another owner command. Task IDs are verified against the
read-only native board and business tenant. Identical upsert replay returns the
existing revision; changed updates preserve revision history.

## Verified bootstrap baseline

`BootstrapMemory` additionally recovers useful fields from the authenticated,
structured `saleads-seed/1` file, limited to the selected business and accepted
bootstrap schemas. Business identity is available even when query wording does
not share keywords; relevant catalog, audience and offer fields use deterministic
retrieval. Actual snapshot SHA and API-reported origin remain explicit. The
bridge registers a versioned API observation and returns read-only candidate
views; it does not rewrite graph facts or manufacture owner quotes.

Historical OwnerNote/model-written graph entries are never promoted through
this bridge. No proof, causal verdict or spending authority is inferred from an
API read. A confirmed typed scalar shadows the matching older snapshot slot.
An updated snapshot yields new source refs while previous versions remain
recoverable. Reading a snapshot again does not manufacture a later source date.
The `/2` projection accepts API product IDs (`product_id` or legacy `id`),
voice tags, value proposition and existing marketing objectives. Its complete
catalog is partitioned into deterministic bounded SourceEvents: one underlying
bootstrap episode/evidence key, several chunk versions. A late catalog item
remains retrievable without sending the entire catalog to every model call.
Chunk count/index and raw snapshot SHA stay explicit; replay does not add
independent corroboration. Query-relevant catalog fields take precedence over
unrelated baseline details while standing confirmed constraints remain first.

Confirmed, current `Decision` and `OperationalConstraint` records are recovered
independently of query language. Relevant experiences of the authenticated role
come next, followed by ordinary knowledge and the bootstrap baseline. The
ontology field kind `declared` identifies the owner's authority over a fact; it
does not make every price, voice note or positioning fact a standing constraint.
Those facts retain their validation, provenance and authority, and use task
relevance for context selection. Existing ordinary text is not silently migrated
into a constraint. All layers retain scope, validity and the same context budget.
Until automatic curation completes, authentic
unprocessed owner statements are included with bounded source IDs/timestamps in
the explicit pending/unvalidated section; they do not become confirmed facts.
Operator and server material never enters that section. This prevents the next
task from silently missing a fresh correction while preserving epistemic state.
