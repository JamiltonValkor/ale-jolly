# Ale Runtime

Ale is the SaleADS sales and marketing assistant. This repository contains the service that provisions and manages an assistant for each user, the business memory service beside it, and the versioned instructions that guide its work.

The assistant runs the official [Hermes Agent](https://github.com/NousResearch/hermes-agent), pinned by container digest. Ale supplies the SaleADS integration, skills, specialist profiles, scheduled work, and business memory. Existing deployments retain their model configuration; an opt-in managed Meta mode prepares the assigned assistant automatically without a browser provider, model, or key form. The business memory service has no model of its own.

The [Meta Assistant backend contract](docs/META_ASSISTANT_API.md) describes authentication, lifecycle, sessions, history, streaming, managed inference, and the later frontend handoff. Managed mode fixes `meta-ai` with `muse-spark-1.3-contributor`, deliberately selected with possible training use acknowledged. The development integration has demonstrated managed Meta inference, configured response language, native delivery and retrieval of source-backed specialist experience. Complete localhost acceptance and application of an experience in a later work session remain pending.

## What it does

- Provisions one dedicated Compute Engine VM per user, obtains a separate assistant OAuth credential with PKCE, and writes the Hermes configuration and instruction bundle.
- Proxies sessions, history, and streaming chat through the Hermes API; manages readiness, credential renewal, time zones, stopping, restarting, and deletion with memory archival.
- Gives Ale access to SaleADS through MCP and a Python CLI over the REST Agent API. The CLI discovers the commands and schemas exposed by the server rather than embedding a second business API.
- Keeps a business graph, provenance, feedback, snapshots, and a SQLite ledger through `saleads-brain`. The brain stores and retrieves knowledge; Ale performs the reasoning.
- Separates Ale's orchestration from five specialist profiles: researcher, strategist, campaign structurer, analyst, and optimizer.
- Guides initial discovery without requiring an owner kickoff, uses the owner's configured SaleADS response locale, and retains ongoing work in native Hermes tasks and scheduled jobs. A hidden curator separates business knowledge from each specialist's private experience; see [managed memory](brain/docs/managed-memory.md).
- Publishes campaign objects in **PAUSED** state. Activation, deletion, and increases beyond the owner's approved monthly budget require approval in SaleADS. Agent actions remain attributable to their business, communication bet, and skill version.

The latest included instruction bundle is `saleads-sales-agent@1.5.13`. The managed landing distribution requires watcher 11 and the matching Meta template; see [installation and rollout](docs/MANAGED_LANDINGS_DISTRIBUTION.md). It includes the CLI aliases for 14 core `saleads_agent_*` commands, covering bets, creative production, media upload, paused publication, activation requests, results, owner feedback, the Meta mirror, traces, and limits. Read and operation commands, local help, and the composite `piezas preparar` command are also available when supported by the connected API. See the [CLI instructions](distribution/saleads-sales-agent/1.5.13/skills/saleads-cli/SKILL.md) and [command reference](distribution/saleads-sales-agent/1.5.13/skills/saleads-cli/references/comandos.md).

## Repository layout

| Path | Responsibility |
|---|---|
| `src/` | NestJS service, authenticated HTTP routes, provisioning, chat, approvals, memory coordination, and persistence |
| `brain/` | Python business memory service, ontology, governance, ledger, graph adapter, MCP server, and tests |
| `vm/` | VM startup script and metadata watcher for the official Hermes runtime and its sidecars |
| `distribution/` | Versioned SOUL, skills, specialist profiles, business type instructions, kits, and scheduled jobs |
| `migrations/` | Versioned Flyway SQL migrations for the assistant database |
| `contracts/` | Generated and versioned contract fixtures |
| `test/` | Service tests and contract validation |

All included skill versions are retained, including the instructions attributed to **Juan Diego Libreros**. Their attribution is preserved; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Build and verify locally

The service requires Node.js 22 or newer and npm. The Jest suite also needs `python3` for a CLI contract test. These commands build and test the service without provisioning a VM:

```bash
npm ci --ignore-scripts
npm test -- --runInBand
npm run typecheck
npm run lint
npm run build
```

The brain requires Python 3.12 or newer. From the repository root:

```bash
python3.12 -m venv brain/.venv
brain/.venv/bin/python -m pip install -e 'brain[dev]'
cd brain
.venv/bin/pytest -q
.venv/bin/ruff check .
.venv/bin/mypy
```

Its runtime extras (`brain[runtime]`) and FalkorDB are needed to run the graph and MCP service, but are separate from the unit test dependencies. The VM watcher can be tested with simulated metadata and a fake container executable:

```bash
bash vm/test/watcher-test.sh
```

That watcher test requires Bash, curl, Python 3, and tar. It does not need a local Docker daemon. Unit tests, a successful build, and `/healthz` do not establish a working cross-service assistant or a successful Meta campaign flow.

## Configure and run the service

Copy [.env.example](.env.example) to `.env` and replace its placeholders with your own deployment configuration. The service reads process environment variables; Node can load the file directly after building:

```bash
cp .env.example .env
# Configure .env and apply the database migrations before starting.
npm run build
node --env-file=.env dist/src/main.js
```

Generate a field encryption key locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` and store it in your secret manager. Use separate high entropy values for the two internal tokens. Never commit them, owner model keys, chat content, OAuth credentials, or business data.

Run the SQL migrations with Flyway against a PostgreSQL test database before starting the service. Configure your own `FLYWAY_URL` (JDBC PostgreSQL URL), `FLYWAY_USER`, and `FLYWAY_PASSWORD`, then run:

```bash
flyway \
  -locations=filesystem:migrations \
  -schemas=assistant \
  -defaultSchema=assistant \
  -table=flyway_schema_history \
  -cleanDisabled=true \
  -validateMigrationNaming=true \
  migrate
```

`DATABASE_URL` is the service's PostgreSQL connection URL, independent of Flyway's JDBC configuration. The application never applies schema migrations at startup. `/healthz` checks process liveness; `/readyz` checks the database connection.

Choose an explicit matching `ASSISTANT_BUNDLE_DIR` and `ASSISTANT_BUNDLE_VERSION`; the example uses `1.5.10`. Including a newer bundle does not turn its optional feature flags on. `BRAIN_IMAGE` must be a compatible image pinned by digest; leaving it empty disables the brain integration.

## Deployment requirements

The current implementation is designed for GCP Compute Engine, PostgreSQL, an OIDC provider, PostHog feature flags, object storage, and the SaleADS backend services. You must supply the VM template, cloud identity, networking, API endpoints, storage, and secrets for your environment. The VM uses the official Hermes image and its persistent data volume; the service must be able to reach the private Hermes API.

Deployment-specific overlays, ExternalSecret bindings, cloud identifiers, and access credentials are operated separately from this public source. This publication does not change the running infrastructure or provide access to it. The `.env.example` values are configuration placeholders, not a standalone demo environment.

An existing SaleADS deployment can build this source and keep its current private manifests, registry, database, OAuth clients, VM template, secrets, and data. The boundary is: **public source → private image build/publication → private GitOps manifests → existing cluster**. Select the validated image in those private manifests; do not point Argo at this repository's example overlay or apply it over a working environment. A source publication alone does not switch that pipeline.

MCP and the REST Agent API are the assistant's business interfaces. The control service also currently calls internal SaleADS services for approval execution and knowledge synchronization. Those callbacks remain deployment dependencies; this baseline does not claim a completed conversion to an MCP-only control service. Optional activation, native research, trace, and synchronization flags require their corresponding deployed services and validation before use.

## Rights and provenance

Original project material is published with **all rights reserved**, under [LICENSE](LICENSE). Public visibility is not an open-source license. Third-party dependencies, upstream components, and attributed material retain their own rights and terms; the project license does not relicense them.

