# Managed native memory plugin

This extension uses official Hermes hooks and tool registration. It does not run a model, switch providers, expose a browser endpoint, override a built-in tool, or infer identity from a prompt.

The fixed companion resolver is `/opt/data/plugins/saleads-continuity/context.py`. It binds the actual API session, registered cron execution, or native worker environment to the server-published owner/business context. Missing bindings stay unavailable.

Each managed profile has its own `plugin-data/saleads-memory/auth-token`, a private regular file containing its derived role token. Managed native source producers receive a separate private `collector-token`; it is never a tool argument or browser credential. Curator outputs are excluded from source capture. The root Brain secret is not a tool argument or plugin setting. Transport uses the fixed internal Brain origin, refuses redirects/proxies, signs canonical context, and returns only enumerated error codes.

`pre_llm_call` registers an authenticated outer SaleADS owner envelope before recall, then retrieves a scoped context pack automatically. The JSON owner envelope preserves literal markers and newlines; the legacy envelope remains readable. Server instructions, cron and worker text are never promoted to owner declarations. A fixed server-published operator-canary policy marks technical test messages, which cannot create owner goals or business facts.

The memory injection reserves at most 5998 characters alongside the continuity plugin's 2000-character context and Hermes' separator. It rejects cut or mismatched JSON. Private receipts retain pack/text/query hashes, references and versions; they do not log chat text or memory contents. A successful injection is not proof that a model used its contents.

Tools:

- `saleads_memory_recall(query)` retrieves only the current bound business/profile.
- `saleads_curation_batch()` derives the assigned batch from the native curator task/run.
- `saleads_commit_candidates(...)` injects identity bindings and preserves typed source references. The Brain validates source, scope, ontology, native result and replay semantics.
- `saleads_goal_update(...)` loads the current goal/revision and supplies the actual registered owner source. Opening the assistant can create an `assistant_proposed` read-only objective grounded by the server in actual bootstrap/API data, without a manual owner command. A genuine normal answer can refine or confirm it as `owner_confirmed`; that origin does not grant commercial permissions. Cron may update an existing goal without claiming its prompt as an owner request.

Specialist output is staged privately after the model turn and registered only after read-only proof of the exact native task/run terminal state. The official completed/blocked hooks and independent reconciliation cover both ordering races. Chunk versions from the same run share one evidence episode. Only hosted-search receipts bound to the exact business/task/run/session are attached as method evidence; generated claims are never treated as measured platform metrics.

After a completed owner interaction or eligible specialist result, a fixed process requests the native curation dispatcher. Owner input is not dispatched before the model response. Internal curation is bookkeeping, not business progress, and never forces commercial workers for a greeting. The independent no-agent recovery also reconciles staged terminal sources. Empty work performs no inference.

The main agent decides the next authorized native work. These adapters do not schedule marketing, select budgets, launch campaigns, or grant commercial permissions. The actual deployment must install the canonical generated contract assets and private token files; merely importing this plugin does not prove a live loop.

Run synthetic stdlib checks without Docker, cloud credentials or model calls:

```bash
python3 -m unittest discover -s vm/extensions/saleads-memory -p 'test_*.py'
```
