# Managed landing distribution 1.5.13

This release packages the validated manual landing specialist for managed Meta.
It preserves the current MCL learning, all-account inference relay and first-use
barrier. It does not establish that the pending autonomous creation, GoalState
continuation or applied designer learning acceptance cases passed.

## Source and packaging

- Base: `c190eb2c9b510739b6042f4bbd9a4c3d914c0b76`.
- Learning adapter: reviewed `9868738` delta, integrated without replacing
  newer primary MCL files. No PostgreSQL or SQLite migration is added.
- Designer/references: `cff678e`, preserving craft and licences. The source
  manifest records original and installed hashes for the few generalized files.
- Ale's skill: C10 `c3015b8`, also in combined `817e51e`; helper/mapper
  come from that combined source. Its memory capture still needs live acceptance.
- `distribution/saleads-sales-agent/1.5.13/landing-distribution.json` records
  source commits, paths, SHA256 values and necessary adaptations.

The new bundle removes historical pilot-grant assumptions, an operator waiver
and a statement that version 6 was already published. Each assistant instead
uses its actual authenticated grants, trusted owner/business/locale, current
mandate and live publication readback. Stable pilot-named paths and skill IDs are
compatibility identifiers, not a restriction to a pilot owner. No customer
record, photo, private URL or VM file was imported into this package.

Designer references are profile-local and compressed in `hermes-profiles`.
The new bundle selects the existing base64 tar.gz `hermes-skills` format.
Internal skills stay JSON; older bundles still emit JSON. Both formats use
the existing watcher installer and path checks; no new transport is introduced.

The aggregate gate includes the real startup script, every Hermes key, all
three business types, synthetic credential/context allowances and six 2 KiB
signed URL allowances. It checks 128-byte keys, 256 KiB values and the 512 KiB
aggregate, reserving at least 16 KiB for other deployment metadata. Recompute
using actual existing instance/template metadata before promotion: larger
owner metadata is not covered by the synthetic allowance. See
[Compute metadata limits](https://docs.cloud.google.com/compute/docs/metadata/setting-custom-metadata#limitations).

## Existing installer and promotion order

The watcher does not replace itself when `startup-script` metadata changes.
Its existing `startup` entry point copies the validated script to its managed
binary path, writes the same systemd unit and restarts that watcher service.
Do not add an administration endpoint, credential or installation protocol.

1. Inventory each existing assistant independently, capture metadata and
   managed-file hashes privately, and drain native runs. Preserve its disk,
   identity, OAuth credential, conversations and artifacts. Do not delete or
   recreate either existing assistant to install this release.
2. Upgrade through the existing privileged startup path. If only standard
   Compute controls are available, merge the validated version 11 startup
   script into existing metadata and use the existing drained stop/start path.
   A metadata edit alone does not execute that new script.
3. Verify watcher 11 accepts the old 27-file archive before switching service.
   It also accepts the intermediate 28/29-file catalogs and complete 32-file
   archive. Preserve the old source/template/digests for rollback.
4. Create the immutable **Meta** template with the same version 11 startup
   script; verify its bytes before selecting its pointer. Classic is unchanged.
5. Promote images built from this integrated source and select only in Meta:
   `ASSISTANT_BUNDLE_DIR=distribution/saleads-sales-agent/1.5.13` and
   `ASSISTANT_BUNDLE_VERSION=saleads-sales-agent@1.5.13`. Select the matching
   model-free Brain image with the designer role schemas. This source requires
   `MIN_META_WATCHER_VERSION=11`; source, minimum, template and existing
   watchers must remain coherent.
6. Observe ORQA reconciliation, exact full metadata ACK and runtime health.
   Check a clean installation and existing manual profile without losing work.
   Run separately authorized functional acceptance through normal SaleADS flows.

These instructions are not evidence that an upgrade happened.

## Exact reconciliation for existing ready assistants

`ReadinessStateReader` invokes `OrqaSync.onReady` for each ready user. Its cache
key includes bundle version, instance name and `ready_since`; selecting 1.5.13
invalidates the old bundle key without creating a VM or replacing identity.
Managed inference must be verified before this synchronization is admitted.

ORQA merges only desired values that differ:

- `hermes-bundle-version`: `saleads-sales-agent@1.5.13`.
- `hermes-soul`: current MCL SOUL plus the approved landing addendum.
- `hermes-skills`: compressed root map, owned business types and installed
  catalog files, including the unchanged C10 orchestration skill.
- `hermes-profiles`: existing specialists/curator plus `disenador_landings`,
  approved SOUL/references and a file/vision/scoped-memory layer.
- `hermes-extensions`: 32 fixed assets, including role catalog, experience
  adapter and the three Root helper files.
- `hermes-brain-image`: selected compatible model-free Brain digest.
- `hermes-config`: rebuilt from that user's current provider/model/relay and
  timezone; written only when its desired bytes differ.

This works for an older CTO row and a newly activated account. ORQA does not
rewrite historical `assistants.bundle_version`; use actual metadata, ACK and
installed hashes as proof. Do not force that column or status to claim readiness.

Helpers retain `/opt/data/saleads/landing-pilot/`: only `cli/landing_cli.py`,
`cli/README.md` and `build_metadata.py` are managed there. Workspaces/receipts
are not removed. Profile identity, state databases, memories, sessions, task
artifacts and unrelated skills are preserved. Manual source-map/notice files
remain; unchanged additional copies live under landing-coder to fit the existing
profile archive allowlist.

Scoped MCL wrappers deliberately replace native global memory/session search.
File tools and same-Spark vision remain. The designer has no commercial MCP
tools; Ale uses its existing CLI/OAuth for permitted drafts/destination binding.
Publication stays in owner web review and does not grant activation or spend.

API keys, relay credentials, MCP tokens, channels, context/job registries and
upload URLs are not invented or copied between assistants. Their existing
owners retain synchronization/renewal. Reconcile any additional owner edits
found in the private pre-upgrade snapshot instead of assuming they match the
approved immutable files.

## Gates and rollback

Directed distribution/profile/skills/contracts/CLI tests precede remote full
Node/Brain gates and watcher simulation. Watcher tests cover old/intermediate
archives, fresh/manual designers, repeated installation, lossless compressed
root skills, helper hashes and preserved owner work. Image smoke checks use
the new 32-file inventory.

For rollback retain watcher 11 (it accepts old archives), restore compatible
previous Meta service/Brain digests and bundle configuration, and preserve VMs,
disks and native data. An old bundle does not automatically delete a designer.
Do not deploy an old whole-service image from a landing experiment branch over
newer MCL/all-account work.
