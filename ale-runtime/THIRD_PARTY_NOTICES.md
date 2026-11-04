# Third party notices

The repository's [LICENSE](LICENSE) reserves rights only in original project material owned by JamiltonValkor. It does not claim authorship of, transfer ownership of, or grant additional rights in the components and attributed material below. Public inclusion does not imply endorsement by their authors.

## Hermes Agent

The agent runtime is the official [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent). `vm/startup-script.sh` references its container image by digest; Hermes source is not presented as original SaleADS code. Upstream copyrights, license notices, dependency terms, and container image terms continue to apply. Consult the upstream repository and the exact image used by your deployment.

## Juan Diego Libreros

The `saleads-estructura-optimizacion-juan` skill and its references expressly attribute their campaign structuring, optimization, and scaling criteria to **Juan Diego Libreros**. They are included across the versioned bundles in `distribution/saleads-sales-agent/`, including `1.5.10`.

## Software dependencies

| Component | Where it is used or declared |
|---|---|
| NestJS, TypeScript, Node.js ecosystem packages | `package.json`, `package-lock.json`, and the service Dockerfile |
| Pydantic, PyYAML, defusedxml, and Python development tools | `brain/pyproject.toml` |
| Graphiti, MCP Python SDK, OpenAI Python SDK, HTTP client, and FalkorDB client | Optional runtime dependencies in `brain/pyproject.toml` |
| FalkorDB | Brain graph database container referenced by `vm/startup-script.sh` |
| Flyway and PostgreSQL | Database migrations and their validation configuration |
| Node.js and Python base images | Service and brain Dockerfiles |

These dependencies and images retain their own licenses and notices. Version declarations and lockfile license fields are dependency metadata, not a replacement for the license texts shipped by each supplier. A built image or redistributed dependency bundle must preserve the notices required by its actual contents; this index is not a complete image license inventory.

Names of connected providers and platforms identify integrations. Their APIs, accounts, content, and trademarks remain subject to their own terms. No platform credentials, customer content, or access to the deployed SaleADS infrastructure are granted by publication of this repository.
