# Contrato del modo local (lo comparten todas las piezas)

Regla de oro: **no se cambia la lógica del producto**. El modo local reemplaza servicios externos con imitadores que hablan el mismo protocolo, y el código existente solo se configura con variables de entorno.

## Red y servicios (`local/docker-compose.yml`)

Red Docker: `ale`. El evaluador solo abre `http://localhost:3000`.

| Servicio | Puerto interno | Expuesto al host | Dueño | Qué es |
|---|---|---|---|---|
| `postgres` | 5432 | no | F0 | Postgres 16, base `ale`, usuario `ale` |
| `ale-runtime` | 8060 | 8060 | Sesión A | Imagen de `ale-runtime` develop (+ ajuste http local) |
| `brain` | según imagen | no | Sesión A | Servicio de memoria de `ale-runtime` |
| `cloud-sim` | 8070 | no | Sesión A | Imita la API de Compute de GCP y el token de metadata; crea un contenedor de Hermes por asistente en la red `ale` |
| `saleads-sim` | 8090 | no | Sesión C | Imita SaleADS: endpoints de Keycloak (JWKS, token, authorize, revoke), el MCP (`/mcp`) con las mismas herramientas y esquemas, y la API de negocio que use el front |
| `front` | 3000 | 3000 | Sesión B | App Next.js de Meta Assistant sin login de SaleADS |
| `jolly-sim` | — | — | Sesión D | Jolly en el computador del evaluador (navegador o proceso en el host) |

## Variables para `ale-runtime` en local

| Variable | Valor local |
|---|---|
| `DATABASE_URL` | `postgres://ale:ale@postgres:5432/ale` |
| `COMPUTE_API_BASE` | `http://cloud-sim:8070/compute/v1` |
| `GCP_METADATA_TOKEN_URL` | `http://cloud-sim:8070/token` |
| `GCP_PROJECT` / `GCP_ZONE` | `ale-local` / `local-sim1-a` (cumplen las regex de `src/config.ts`) |
| `KEYCLOAK_JWKS_URL`, `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_REVOKE_URL`, `KEYCLOAK_AUTHORIZE_URL` | `http://saleads-sim:8090/realms/sale-ads/protocol/openid-connect/...` |
| `MCP_URL` | `http://saleads-sim:8090/mcp` (hoy exige https: la sesión A lo permite solo con `LOCAL_MODE=true`) |
| `MANAGED_META_API_KEY` | `${META_API_KEY}` del evaluador |
| `LOCAL_MODE` | `true` (nueva; solo habilita lo mínimo para correr en local, como http) |

La lista completa la cierra la sesión A en `local/.env.example`.

## Una sola llave del evaluador

`META_API_KEY`: modelos de Meta (Muse Spark, Muse Voice Transcribe y SAM). Opcionales: `CARTESIA_API_KEY` (voz; sin ella, voz del navegador) y `REPLAY=true` (sin llave: respuestas grabadas, marcadas).

## Negocio y usuario de demo

- Usuario: `demo-owner`, sub fijo `00000000-0000-4000-a000-000000000001`, sin contraseña. `saleads-sim` emite su token firmado y su JWKS.
- Negocio: «Masquebella (demo)», id `a6b8e93d-386f-4141-96ff-4b49e137728a` (el mismo de las corridas reales, para reusar trazas), con sus ofertas y catálogo.

## Etiquetas

Todo lo simulado se ve marcado en pantalla y en el README como «simulado» o «grabado del robot real». Ninguna llave ni credencial vive en el repo.

## Ramas y carpetas

Cada sesión trabaja solo en su carpeta de este repo (`cloud-sim/`, `saleads-sim/`, `front/`, `jolly-sim/`). Abre una rama propia y un PR a `main`. Los cambios a `ale-runtime` van en su propio repo, en una rama desde `develop` (solo la sesión A).
