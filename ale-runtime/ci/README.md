# Source validation

The public source is validated on remote CPU runners. Neither workflow deploys,
pushes an image, calls a live SaleADS service, provisions infrastructure, or needs
application credentials. Docker and the Node/Python dependency stacks run on the
remote runner, not on the maintainer's Mac.

`../.github/workflows/validate.yml` runs on pushes, pull requests and manual
dispatches. Its GitHub token has `contents: read`; checkout does not persist
credentials. It has no cloud authentication or secrets configuration.

`public-validation.yaml` runs the same quality commands in Google Cloud Build
against an uploaded source archive. Its first step rejects `.git`, actual `.env`
files, dependency/build directories, and symlinks that escape the source root.
It also compiles every Python source file without importing it. The archive is
the entire input: no parent workspace or sibling repository is required.

## Gates

| Component | Commands |
| --- | --- |
| Service | `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, `npm run build` |
| CLI | `python -I -m unittest discover -s test/cli -p 'test_*.py'` (all test classes, including those following the script's `unittest.main` block) |
| Brain | `python -m pip install './brain[dev,runtime]'`, `python -m pip check`, then `python -m pytest -q`, `python -m ruff check .`, `python -m mypy` from `brain/` |
| VM watcher | `bash vm/test/watcher-test.sh`, using a fake local metadata server and fake Docker adapter; `curl` and declared PyYAML are test prerequisites |
| Packaging | Build the root and `brain/` Dockerfiles without publishing their images. The Brain Dockerfile also checks the runtime imports. |

All Jest suites remain enabled. Their PGlite databases run inside the remote
Node process; tests apply the supplied SQL migrations to disposable databases.
The Node runner also installs Python 3: a Jest bundle contract test invokes the
standard-library CLI directly, independently of the full Python test job.
Brain tests use their supplied in-memory/fake adapters. Installing the full
`dev,runtime` profiles is necessary because the complete suite imports MCP,
Graphiti and FalkorDB adapters. No test is replaced with an import stub or
excluded to avoid those dependencies. The dependency declarations and application
Dockerfiles remain the source of truth.

These gates establish source, unit/integration-test and image-build validity.
They do not establish a live end-to-end flow, a real PostgreSQL/Flyway migration,
VM capacity, provider connectivity, or campaign behavior. A change to SQL needs
the real disposable PostgreSQL/Flyway validation in addition to these gates;
this publication does not change SQL.

## Cloud Build from a source archive

Use a tar.gz with this repository's files at its root. Include all of
`distribution/`, tests, contracts, migrations, Dockerfiles and example
configuration. Exclude `.git/`, `.env` and actual `.env.*` files (keep
`.env.example`), `node_modules/`, `.venv/`, `dist/`, `coverage/`, Python caches and
local editor state. The source guard rejects an archive containing the main
excluded paths. Upload only this prepared repository, never its parent workspace.

From the extracted archive root, submit to a project you are authorized to use:

```bash
gcloud builds submit . \
  --project YOUR_VALIDATION_PROJECT \
  --config ci/public-validation.yaml
```

The project needs an existing Cloud Build setup and an identity permitted to
submit builds and write build logs/source staging. The recipe creates no IAM,
secret, database, registry, VM or Kubernetes resources. It retains temporary
images only within the build worker and does not declare an `images` output.

Node 22, Python 3.12 and the Cloud Build Docker builder are pinned by immutable
registry digest in the recipe. GitHub checkout is pinned by commit. Update these
pins deliberately after verifying the replacement against its official registry.
The Dockerfiles use their existing dependency profiles and base-image policies.
