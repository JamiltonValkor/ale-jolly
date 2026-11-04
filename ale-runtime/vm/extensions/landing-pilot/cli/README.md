# Landing file adapter — experimental pilot

This adapter imports the existing installed `saleads.py` CLI. Authentication,
service-owned host, live discovery/schema, scope/ownership enforcement and HTTP
execution remain there and in Agent API. There are no URL/token command options,
no direct Landing-service calls and no automatic write retry. Historical bundles
are unchanged. It reads `HERMES_HOME/skills/saleads-cli/scripts/saleads.py` (root
home defaults `/opt/data`).

Before each command (including operation reads), the pilot wrapper checks the
existing private `expires_at` metadata. Access with more than 60 seconds left
does not invoke MCP. For expiring access it reuses the official Hermes MCP
probe with the existing OAuth configuration and refresh credential; interactive
authorization is suppressed. The configured client must match the already
stored client before the probe runs. Hermes owns refresh, concurrency control
and persistence; the wrapper reloads its existing credential afterward.

Missing metadata, a client mismatch, a rejected probe or still-expired access
returns `AUTH_REQUIRED` (exit5) before CLI discovery or execution. No token or
probe output is printed. This never registers another client, implements OAuth,
starts SSO, copies Root credentials to the designer, or retries a write after
an uncertain acknowledgement. Expired access can be renewed by the existing
authorization; a 401 alone does not prove the owner must log in again.

After a successful version admission, the commercial ACK is saved first. The
installed observer then verifies and checkpoints the actual admission in its
existing pending WAL, using hashes and a MAC from the existing collector token.
The adapter may read the landing and that exact admitted version, sharing a
15-second budget with checkpointing and observation. It passes frozen request
bytes and authenticated response data before extraction can change files.
The observer must find exactly one existing native designer
record matching the workspace and its verified hash chain, then verify its tenant,
task/run, session and terminal proof. No new metadata fields or CLI flags select
that authority, and no commercial credential reaches the designer.
The original native workspace is required; a copied directory does not establish
that identity even when its files have the same bytes. A current successful
`saleads_landing_validate` response is saved and offered to the managed observer
before extraction: the observer can MAC-seal native input hashes to actual
server-normalized output hashes in the same pending WAL. It performs no extra
commercial read or source registration. Later copying those finalized bytes
into that workspace is eligible only through this verified chain.

The optional private `_landing_memory_validation` status is `sealed` or
`unavailable`; a seal is neither a source ACK nor learning. The existing
`build_metadata.py` projection remains Root-generated metadata: its computed
review and reserved evidence fields are not identical native JSON or facts
measured on the advertising platform.

The private full response can include `_landing_memory_capture` with only
`recorded`, `pending` or `unavailable`. This reports source capture, never
curation or applied learning. Missing memory support, rejected proof, a lost
memory ACK or a failed corroborating read leaves the commercial admission
successful and does not repeat it. A verified checkpoint is marked internally;
failed reads still report capture as unavailable.

A later successful Root `saleads_landing_get_version` read can complete capture:
the adapter saves that current API response, reads the landing once, and asks the
same observer to match and verify the MAC-protected native checkpoint. It has
its own bounded 15-second read/observation budget and never replays submission.
No workspace flag is added to reads. Saved response/request JSON alone is never
proof; pending/failed writes and `saleads_get_operation` resumes do not manufacture
an admission receipt.

The model writes `index.html` and `styles.css`; the adapter packages UTF-8 bytes,
base64, byte lengths and SHA-256 without putting file contents in shell arguments.
It saves the exact `.request.json` before network I/O for uncertain ACK recovery.
Use a stable `client_request_id` for the same request; a revision needs a new ID.

Example root CLI operations, arguments already saved in private JSON files:

```sh
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_context --args context-args.json --output context.json
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_create --args create-args.json --output created.json
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_validate --args artifact-args.json --workspace page --output checked.json --extract checked-files
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_preview --args artifact-args.json --workspace page --output preview.json --extract preview-files
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_submit_version --args artifact-args.json --workspace page --output saved.json
python3 /opt/data/saleads/landing-pilot/cli/landing_cli.py saleads_landing_get_version --args version-args.json --output version.json --extract recovered-page
```

`artifact-args.json` contains `business_id`, `landing_id`, `client_request_id`,
`expected_latest_n` (0 before the first version), `locale` and optional metadata
(font IDs, skillVersion/task/run refs and artifacts/review). Read the live schema
for exact shapes; create context is the existing LandingContextV1. A helper
request is limited to 576KiB serialized, files300KiB each/400KiB total and
metadata32KiB. No truncation or CLI compaction is permitted.

The full response is private JSON (mode0600); stdout contains only status,
version/link and local artifact paths, sizes and hashes. `--extract` validates
base64/hash/length, writes complete HTML/CSS, and decodes preview/reference JPEGs.
Attach/read the actual JPEG files when requesting a visual review. Saving a JPEG
or getting a private URL is not evidence that Spark saw it.

A check can deterministically finalize photo markers and font blocks. Read its
finalized files/digest; preview and saved version must have the same final
artifact digest. Capture timeout is180s in the adapter,150s service-side; actual
Cloudflare/proxy timing is verified by the pilot, not assumed from this setting.

Commands do not publish/unpublish. The owner reviews and publishes an explicit
version through the existing SaleADS web panel in the second local view.

The same wrapper also admits exactly `saleads_agent_prepare_landing_destination`
and `saleads_agent_get_landing_destination` when the live API enables them. These
use the same native OAuth refresh and existing CLI executor, with no artifact
workspace or new credentials. Preparation requires its stable 8–128-character
request ID; the server resolves the URL, digest, owner and canonical intent.
Do not use an advertising publication command to imitate this operation. These
commands do not publish HTML, create Meta objects or authorize spend.

This combined source candidate preserves the existing experimental memory-admission
producer and native OAuth renewal while adding the two destination commands. It
is not an installation or a default bundle release. Coordinate a targeted
installation; never replace the shared memory runtime or copy an older
whole-service image for this patch.

## Tests

```sh
python3 -m unittest discover -s experiments/landing-specialist-pilot/cli -p 'test_*.py' -v
```
