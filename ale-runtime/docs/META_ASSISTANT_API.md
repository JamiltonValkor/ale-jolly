# Meta Assistant backend API

Meta Assistant uses the existing Hermes lifecycle and HTTP/SSE chat contracts. Managed inference fixes the provider to `meta-ai` and the model to `muse-spark-1.3-contributor`; the browser supplies neither a provider, a model, nor an inference key. Contributor was explicitly selected with possible training use acknowledged. Do not describe this mode as no-training or Zero Data Retention.

This document describes the integration branch's source contract. Deployment and a real Meta response have not yet been demonstrated for this change. The first delivery is a usable, authenticated backend; a new SaleADS view named **Meta Assistant**, reusing the existing assistant experience, comes afterward. `/dashboard/agent` belongs to a separate experience.

## Authentication and paths

Paths below are relative to the runtime service. An existing SaleADS web proxy may add its own prefix; this change defines no new browser route or proxy prefix.

Every assistant route requires `Authorization: Bearer <web-access-token>` and the assistant feature flag for that authenticated user. The service validates RS256, the configured issuer, required `exp`, `iat`, and `sub`, an allowed `azp`, and `typ: Bearer`; it also validates the audience when configured. The principal comes from the verified token, never from a body or query parameter. An assistant OAuth token is not a substitute for the web token. MCP access remains the assistant's separate OAuth credential.

JSON requests use `Content-Type: application/json`. Responses are not cacheable. Errors before a stream opens have the shape `{"code":"…","request_id":"…"}` and omit dependency messages and credentials.

| Method and path | Request | Success response |
|---|---|---|
| `GET /assistants/me` | No body | `AssistantStateV1` |
| `POST /assistants/me/activation` | `Idempotency-Key` header; optional `{"timezone":"UTC"}` | `200`: state or `{"authorize_url":"…"}` for the assistant's OAuth grant |
| `POST /assistants/oauth/callback` | `{"code":"…","state":"…"}` from the OAuth return, with the same user's web authentication | `200`: `{"ok":true}`; the versioned schema also admits `{"login_required":true}` |
| `PUT /assistants/me/timezone` | `{"timezone":"UTC"}` | `200`: state; accepts a valid IANA time zone |
| `POST /assistants/me/stop` | No body | `200`: state with `status: stopped` |
| `POST /assistants/me/start` | No body | `200`: state; poll `GET /assistants/me` for readiness |
| `DELETE /assistants/me` | No body | `200`: deleting state, then `none` when deletion completes; already absent returns `none` |
| `POST /assistants/me/sessions` | No body | `200`: `{"session_id":"…"}` for the user's existing or newly ensured conversation |
| `GET /assistants/me/sessions/:id/messages` | Use the session ID returned by the service | `200`: `{"messages":[{"id":"…","role":"user","text":"…","created_at":null}]}` |
| `POST /assistants/me/sessions/:id/stream` | `{"text":"…"}`; trimmed text length 1–8000 | `200`: `text/event-stream` after the turn opens |

Activation keys contain 8–128 letters, digits, underscores, or hyphens. Reuse the same key when retrying the same activation. The returned authorization URL uses PKCE S256 and silent SSO; the callback binds the flow and resulting assistant credential to the authenticated user. It does not connect the user to Meta or ask for a model key.

The session ID is scoped to the user's VM and checked against the stored session. Repeated session creation ensures that conversation rather than creating a second chat. History exposes visible user and assistant text only, with `created_at` as an ISO timestamp or null; tool messages and hidden compacted rows are filtered out. Stop/start preserve the conversation. Deletion uses the existing archival lifecycle and is not a troubleshooting step for inference configuration.

Common errors are `401 UNAUTHORIZED`, `403 ASSISTANT_NOT_ENABLED`, `503 FLAG_UNAVAILABLE`, `400 INVALID_REQUEST`, and `503 SERVICE_UNAVAILABLE`. Missing assistants or unavailable session IDs return `404 NOT_FOUND`; chat while unready returns `409 ASSISTANT_NOT_READY`. Session/turn opening can return `503 ASSISTANT_RESTARTING` when Hermes is unreachable while its VM is running. A missing assistant gives `404` for stop/start.

## Managed readiness

The state contract contains `status`, nullable `step`, `slow`, nullable `session_id`, `ai: {configured, provider, model}`, nullable `ready_since`, and nullable `timezone`. Existing status values remain `none`, `activating`, `ready`, `stopped`, `failed`, and `deleting`. Preparation steps remain `preparing_access`, `preparing_environment`, `installing_agent`, and `configure_ai`.

For the managed user, `configure_ai` means automatic server preparation. Display a preparing state and continue polling; do not render the legacy provider/key form. The service schedules setup in the background when state reads reach this step or encounter an existing ready assistant whose managed inference has not been verified. State reads do not wait for the inference probe. Chat also checks managed verification and requests preparation before returning `ASSISTANT_NOT_READY`.

Setup uses the existing per-user configuration lock, merges configuration into the existing VM metadata, waits for the watcher's applied-version acknowledgement and Hermes readiness, and runs a small inference probe through Hermes. It does not recreate the VM or start a second agent runtime. A successful result must match the exact Meta provider/model before the managed readiness gate opens.

Until then, `GET /assistants/me` reports `activating / configure_ai` with `ai.configured: false` and null provider/model, even if the database still contains a previously configured provider. A failed probe does not become success through polling: repeated setup requests are deduplicated and use a 60-second retry delay after completion. Verification is held in process memory, so a service restart requires another successful verification. Stopped assistants stay stopped until explicitly started.

`ready_since` is an existing lifecycle milestone, not a fresh Meta measurement or proof that a business tool just succeeded. `/healthz` checks the service process and `/readyz` checks PostgreSQL; neither proves Meta inference, MCP authorization, or a complete campaign flow. A real authenticated conversation, business read, history reload, and second turn remain required integration evidence.

## Streaming contract

Use a streaming POST client, such as `fetch` with an abort signal, rather than a GET-only `EventSource`. Preserve the stream through the web proxy without buffering. The service sends `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-store, no-transform`, and `X-Accel-Buffering: no`.

The event name is the contract's `type`; `data` contains the other fields as JSON. There is no duplicate `type` field in `data`:

```text
event: token
data: {"text":"Hello"}

event: message_end
data: {}

```

| Event | JSON data | Meaning |
|---|---|---|
| `token` | `{"text":"…"}` | Append assistant text |
| `tool_start` | `{"name":"…"}` | Tool activity began |
| `tool_end` | `{"name":"…","ok":true}` | Tool activity ended; `ok` may be false |
| `mcp_unavailable` | `{}` | A `mcp__saleads__*` tool failed; the turn can continue |
| `message_end` | `{}` | Turn completed successfully |
| `provider_error` | `{"reason":"auth"}` | Terminal inference failure; reason is `auth`, `quota`, or `rate_limit` |
| `error` | `{}` | Terminal failure without a safe provider classification |
| `assistant_restarting` | `{}` | Terminal interruption while the VM remains running |

Ignore SSE comments such as `: keepalive`; they contain no chat message. The default heartbeat is 15 seconds. A client disconnect aborts the upstream turn, and a second turn for the same user cancels the previous one. There are no event IDs or automatic replay guarantees. After an interrupted connection, reload history before offering a deliberate retry; do not blindly resend the prompt. A failed tool event alone does not end the turn or establish a completed business action.

Provider failures expose only their safe category, never a key or raw provider response. In managed mode, direct users to a service availability message rather than a key-entry screen.

## Operator configuration

Managed mode is opt-in. By default it is scoped to the assistant identified by `MANAGED_META_USER_ID`; other users retain their existing inference configuration and API behavior. An explicitly authorized managed deployment may set `MANAGED_META_ALL_USERS=true` to admit every authenticated web account allowed by the existing backend assistant feature flag. This setting never bypasses authentication, that flag, business ownership, or commercial approvals.

All-account mode requires the managed inference relay. The upstream Meta credential remains in the backend; each VM receives a separate inference-only bearer derived with a distinct HMAC namespace from that assistant's encrypted control secret. Changing or removing the assistant's secret revokes its relay credential. Assistant OAuth tokens, API server keys, encrypted state, native sessions, language preferences, job bindings and business memory remain bound to the authenticated account; no pilot identity or existing user's data is copied. Inference credentials are never returned to the browser or used as business/approval credentials. An isolated classic deployment keeps its own unchanged configuration and state.

| Variable | Configuration |
|---|---|
| `MANAGED_META_ENABLED` | Defaults to `false`; opt in to managed inference |
| `MANAGED_META_ALL_USERS` | Defaults to `false`; explicit all-account admission within this managed deployment, still subject to authentication and the backend feature flag |
| `MANAGED_META_USER_ID` | Required in enabled single-pilot mode; the assigned user's verified web subject. Not used for admission in all-account mode |
| `MANAGED_META_RELAY_BASE_URL` | Required for all-account mode; private operator-selected HTTPS base ending in `/v1`. The Meta plugin appends `/responses`. Setting it also migrates an admitted pilot to relay transport |
| `MANAGED_META_API_KEY` | Required when enabled; inject through private deployment secrets, never through browser input, Git, logs, or fixtures |
| `ASSISTANT_RUNTIME_NAMESPACE` | Empty by default, preserving existing Compute names and request IDs. Use a stable distinct value for an isolated deployment; this scopes infrastructure names, not the user's authenticated identity |

The fixed constants are `meta-ai`, `muse-spark-1.3-contributor`, and `https://api.meta.ai/v1`. Hermes receives its credential through `MODEL_API_KEY` and a bounded API timeout. The generated configuration pins the root model, delegated workers, and all 19 built-in auxiliary tasks listed in `META_AUXILIARY_TASKS`. Provider/model fallback chains are empty. Metadata-absent custom/plugin tasks remain owner-managed. Applying these routes requires watcher protocol 6; an older watcher is rejected before metadata delivery. These emitted settings and their application to disk must be validated together; a matching configuration string alone is not a successful inference call. The business brain continues without its own model.

For the managed user, `GET /assistants/me/providers` returns only `[{"id":"meta-ai","label":"Meta Model API","needs_key":false}]`. `PUT /assistants/me/ai` returns `400 INVALID_REQUEST`; the future view should not call it. Existing unmanaged users keep their provider catalogue and configuration path.

The relay exposes only `POST /meta-inference/v1/responses`, authenticated by the assistant's own inference bearer rather than a browser or business OAuth token. Every request rechecks the managed scope, current assistant row and backend feature flag. It forwards only the fixed Spark model to Meta's fixed Responses URL, with function tools and hosted `web_search`, no redirects or relay retries, a 300-second deadline, disconnect cancellation and stream backpressure. Provider HTTP error bodies and headers are never relayed or logged. Only this route admits up to 8 MiB of native context; other HTTP routes retain their 128 KiB bound.

Hermes retains its own complete local history. The relay sets `store:false` and rejects provider-side conversation, previous-response and stored item/file references; one account cannot use the shared upstream credential to refer to another account's stored provider state. `META_BASE_URL`, root model, auxiliary models and delegation all select the relay base. The upstream key never reaches new account VMs. The public gateway must route the configured public `/responses` URL to this backend path; source tests alone do not prove that deployment route or live inference.

Use the existing private build, manifests, secret injection, and infrastructure. Choose the deployment target and state ownership before changing a running assistant; do not start two controllers against the same VM. Rolling back the image alone does not necessarily restore prior VM configuration or credentials. Preserve sessions, memory, channels, jobs, and owner customizations when preparing either migration or reversal.

An isolated Meta deployment also needs an independent database and runtime role, encryption key, VM/disks, memory bucket, OAuth client/grant and callback routing, Kubernetes selectors/service and delivery application. A Compute namespace alone does not isolate mutable state. Start with empty state rather than copying another assistant's tokens, session, configuration or archives. The future Meta view must target this distinct backend; it must not label an unmanaged legacy assistant as Meta.

## Frontend handoff and remaining integration

After backend deployment and real proof, reuse the existing activation, OAuth callback, status polling, lifecycle, session/history, and SSE components in the new **Meta Assistant** view. Handle `configure_ai` as automatic preparation, retain safe error handling, and show a chat composer only when state is ready. No provider selector, model picker, key field, or separate inference-connect step is part of that view. The existing generative UI and `/dashboard/agent` are outside this delivery.

The 14 direct commercial callbacks have not been migrated by this managed-inference change. Later work moves the relevant reads and knowledge synchronization to Agent API, and approval execution/settlement to a backend-only identity using the persisted approval. Those future execute/settle commands must never be given to Hermes or treated as ordinary MCP tools. No new routes for them are asserted here; existing business authorization and owner approval requirements continue to apply.

The canonical source contracts are [v1 schemas](../src/contracts/v1.ts) and their [generated fixtures](../contracts/one-click/v1/). Managed setup lives in [managed-meta.ts](../src/ai/managed-meta.ts); fixed inference settings live in [meta-model.ts](../src/ai/meta-model.ts). See the [chat controller](../src/http/chat.controller.ts) and [SSE normalizer](../src/chat/chat-events.ts) for streaming behavior.
