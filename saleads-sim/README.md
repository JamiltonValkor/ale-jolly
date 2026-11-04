# saleads-sim (simulado)

Imitador local de SaleADS para que el jurado use Meta Assistant sin cuenta de SaleADS. Pieza **P2** de
[`docs/PLAN-IMPLEMENTACION.md`](../docs/PLAN-IMPLEMENTACION.md); contrato en [`docs/CONTRATO-LOCAL.md`](../docs/CONTRATO-LOCAL.md).

Regla: **no cambia la lógica del producto**. ale-runtime, Hermes (dentro de cada «VM»), el CLI del asistente y el front
hablan con este servicio con el mismo protocolo, los mismos clientes OAuth y los mismos esquemas que con SaleADS dev.
Todo lo que responde lleva la marca «simulado».

Puerto `8090`. Caddy lo publica como `https://saleads.local` y `https://posthog.local` (TLS local, D1).

## Qué imita

| Superficie | Rutas | Imita a |
|---|---|---|
| Keycloak, realm `sale-ads` | `/realms/sale-ads/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server/realms/sale-ads`, `…/protocol/openid-connect/{certs,auth,token,revoke,userinfo}` | Keycloak dev |
| Recurso protegido (RFC 9728) | `/.well-known/oauth-protected-resource[/mcp]` | sa-mcp-server |
| MCP Streamable HTTP | `/mcp` | sa-mcp-server (`feat/inventario-vivo`) |
| Agent API del CLI | `/agent/v1/commands[/:name]` | sa-mcp-server `agent-api.ts` |
| Landings | `/l/{id}/v/{n}/`, `/l/{id}/`, `/{es,en}/dashboard/agent-landings/{id}`, `POST /sim/landings/{id}/{publish,unpublish,feedback}` | sa-landing-service, publicador y vista web de revisión |
| Gateway clásico mínimo | `/api/subscription/language[/supported]`, `/api/subscription/credits/agent-cap`, `/api/campaigns/agentic/v1/*`, `/api/integration/meta/configuration` | Envoy + subscription, campaign e integration |
| PostHog | `/flags`, `/decide` (banderas en verdadero) y `/capture`, `/batch`, `/e`, `/i/v0/e`… (descarta) | PostHog |
| Sesión demo (D7) | `GET /sim/session` | Login web de Keycloak |

Diagnóstico: `/healthz`, `/sim` (resumen), `/sim/landings` y `/sim/calls` (últimas llamadas a herramientas; marca
`ok_generic` las respondidas con datos de demo y `unknown_command` los comandos que no existen).

### OIDC

- `authorize` exige PKCE S256 y acepta `prompt=none`. La sesión SSO es siempre la del usuario demo
  (`00000000-0000-4000-a000-000000000001`); no hay pantalla de login.
- `token`: `authorization_code`, `refresh_token` y `password` (solo cliente `front` y usuario `demo-owner`, contraseña sin validar: la usa el front, D7). Responde `access_token`, `refresh_token`, `token_type=bearer`,
  `expires_in`, `scope` (más `id_token`, `refresh_expires_in` y `session_state`, como Keycloak).
- Token del asistente: `iss`, `aud = MCP_URL`, `azp = mcp-saleads-assistant-dev`, `typ = Bearer`, `sub`, `scope`.
  Dura 5 min (`SIM_ACCESS_TOKEN_TTL_S`), así Hermes renueva de verdad.
- Token web: `azp = front`, `typ = Bearer`, sin negocios. Lo emite `/sim/session` para el front.
- `revoke` siempre responde 200; revocar un refresh cierra su sesión offline entera.
- La llave RS256 y el estado se guardan en `SIM_DATA_DIR` (`/data` en el contenedor): reiniciar no invalida los tokens.

### MCP y Agent API

- Mismo SDK y opciones que el real (`@modelcontextprotocol/server` 2.2.0, `createMcpHandler` con
  `legacy: 'stateless'` y respuestas SSE): versiones 2026-07-28 y 2025-11-25, sin sesión, `tools/call` sin `initialize`,
  GET y DELETE con 405, Bearer obligatorio (401 con `resource_metadata`) y 403 `insufficient_scope` por herramienta.
- Resultados con `structuredContent` y el mismo JSON en `content[0].text`; errores de negocio con `isError` y
  `structuredContent.error.code` `MCP-E-*`.
- Esquemas: `contracts/schemas/*.json`, copiados de sa-mcp-server (commit en `contracts/SOURCE`). El SDK valida
  entradas y salidas contra ellos.
- Dominios como en el real: `agent` (landings y `saleads_agent_*`) solo por `/agent/v1`; las 15 `saleads_stock_*` solo
  para `SIM_STOCK_USER_IDS`. La Agent API sirve las lecturas de `SIM_AGENT_API_COMMANDS` (las de develop) y todo el
  dominio `agent`, solo para el cliente del asistente.

### Núcleo con estado

| Área | Herramientas |
|---|---|
| Cuenta y negocios | `get_account_overview` (`businesses[]`, `selected_business_id`), `select_business`, `create_business` |
| Negocio | `get_business_profile` (`offering_type`), `get_business_bootstrap`, `list_offerings` (paginado), `create_offering`, `get_meta_status` |
| Estrategia y plan | `start_strategy`, `get_strategy`, `regenerate_strategy`, `approve_strategy`, `get_plan`, `list_plans`, `update_plan` |
| Operaciones | toda tool async y las escrituras con `client_request_id`, deduplicadas por `(usuario, tool, client_request_id)`; `get_operation` |
| Apuestas | `agent_register_bets`, `agent_bet_state` (linaje canónico `bet_id = hypothesis_id` y `strategy_version_id`) |
| Landings | `landing_*` y `agent_prepare/get_landing_destination` |
| Stock | reenvío puro a ale-runtime `/internal/stock/businesses/:id/*` con `x-internal-api-token`, `x-user-id` y `x-business-id` |

El resto de herramientas responde datos de demo mínimos generados desde su `outputSchema` (válidos contra él), siempre
verificando que el negocio sea del usuario.

Negocio de demo: **Masquebella (demo)** (`a6b8e93d-386f-4141-96ff-4b49e137728a`), tienda capilar en COP. Su catálogo
casa con las semillas de Stock de ale-runtime (Bio Mascarilla, Tónico «La Receta CBD», Ampolleta, Kit Emergencia,
Shampoo y Aceite).

### Landings

1. El agente registra su apuesta y crea la landing (`saleads_landing_create`, exige el `bet_id` canónico).
2. `validate`, `preview` y `submit_version` reciben `files` (base64 con `sha256` y `byteLength`); se verifican y se
   guardan por versión. `preview` devuelve un JPEG fijo «Vista previa simulada» en `data.shots[]`.
3. La versión se ve en `/l/{id}/v/{n}/`. La vista de revisión del dueño (`review_url`) tiene el botón **Publicar**, que
   simula al dueño: `status=published`, `publishedN` y `url = {SIM_LANDING_PUBLIC_BASE_URL}/l/{id}/`.
4. Con la versión publicada, `saleads_agent_prepare_landing_destination` ata la landing a la apuesta.

`url` debe ser https (lo exige el contrato del destino): deja `SIM_LANDING_PUBLIC_BASE_URL` en https.

## Uso

```bash
cd saleads-sim && npm install && npm test
```

```bash
docker compose -f local/docker-compose.yml -f local/compose.saleads.yml up saleads-sim
```

### Variables

| Variable | Por defecto | Qué es |
|---|---|---|
| `SIM_PUBLIC_BASE_URL` | `https://saleads.local` | Origen público: `iss = {base}/realms/sale-ads` y `MCP_URL = {base}/mcp` |
| `SIM_REDIRECT_PREFIXES` | `http://localhost:3000/`, … | `redirect_uri` aceptados (prefijos) |
| `SIM_META_ASSISTANT_URL` | `http://ale-runtime:8060` | ale-runtime para Stock |
| `SIM_META_ASSISTANT_INTERNAL_TOKEN` | vacío | `INTERNAL_API_TOKEN` de ale-runtime (sin él, Stock responde `MCP-E-UPSTREAM-UNAVAILABLE`) |
| `SIM_STOCK_USER_IDS` | usuario demo | Quién ve las tools de Stock |
| `SIM_LANDING_REVIEW_BASE_URL`, `SIM_LANDING_PUBLIC_BASE_URL` | `SIM_PUBLIC_BASE_URL` | Enlaces que abre el navegador |
| `SIM_ACCESS_TOKEN_TTL_S` / `SIM_WEB_TOKEN_TTL_S` | 300 / 28800 | Vida del token del asistente y del web |
| `SIM_ASYNC_DELAY_MS` / `SIM_SYNC_WAIT_MS` | 3000 / 25000 | Duración simulada de las operaciones y espera síncrona |
| `SIM_POSTHOG_FLAGS` | `sales-assistant-enabled,meta-assistant-enabled` | Banderas siempre activas |
| `SIM_CORS_ORIGINS` | `*` | Orígenes del navegador para `/api/*` |

Variables de ale-runtime que apuntan aquí: `KEYCLOAK_ISSUER=https://saleads.local/realms/sale-ads`,
`KEYCLOAK_JWKS_URL`, `KEYCLOAK_TOKEN_URL` y `KEYCLOAK_REVOKE_URL` en `http://saleads-sim:8090/realms/sale-ads/protocol/openid-connect/{certs,token,revoke}`,
`KEYCLOAK_AUTHORIZE_URL=https://saleads.local/realms/sale-ads/protocol/openid-connect/auth`,
`MCP_URL=https://saleads.local/mcp`, `AGENT_API_URL=https://saleads.local`, `POSTHOG_HOST=https://posthog.local`
y `ASSISTANT_OAUTH_REDIRECT_URI` con un prefijo de `SIM_REDIRECT_PREFIXES`.

## Apuntar al SaleADS real

saleads-sim no tiene nada propio: cambiar a SaleADS es solo configuración de ale-runtime y del front.

1. Quita `saleads-sim` del compose.
2. En ale-runtime: `KEYCLOAK_ISSUER=https://keycloak-dev.saleads.ai/realms/sale-ads`, `KEYCLOAK_JWKS_URL`,
   `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_REVOKE_URL` y `KEYCLOAK_AUTHORIZE_URL` del Keycloak real, `MCP_URL=https://dev.saleads.ai/mcp`,
   `AGENT_API_URL` vacío (cae al origen del MCP), `POSTHOG_HOST` y `POSTHOG_API_KEY` reales, e `INTERNAL_API_TOKEN` el
   que use sa-mcp-server (`MCP_META_ASSISTANT_INTERNAL_TOKEN`) para llamar a Stock.
3. Registra el `redirect_uri` en el cliente `mcp-saleads-assistant-dev` de Keycloak y quita la sesión demo del front
   (vuelve el login real de `front`).
4. El usuario necesita cuenta de SaleADS con plan de pago y su negocio; Stock solo para los usuarios de
   `MCP_STOCK_TOOL_USER_IDS`.

## Pruebas

- `test/oidc.test.ts`: discovery, JWKS, PKCE con `prompt=none`, refresh, revocación y la sesión demo, verificando los
  tokens con las reglas exactas de ale-runtime `src/security/identity.ts`.
- `test/tools.test.ts`: una prueba por cada herramienta del contrato (97): entrada válida contra su `inputSchema` y
  respuesta válida contra su `outputSchema` o error `MCP-E-*`. También `tools/list` en las dos eras y el 405.
- `test/flows.test.ts`: estrategia → plan, operaciones deduplicadas y pendientes, apuestas → landing → navegador →
  publicar → destino, reenvío de Stock, Agent API, gateway y PostHog.

Verificado además contra código real, fuera de CI:

- clientes de ale-runtime (`IdentityVerifier`, `KeycloakTokenClient`, `KeycloakRevocationClient`, `HttpMcpToolClient`);
- el OAuth de Hermes (`tools/mcp_oauth_manager.py`, `mcp==2.0.0`): con el access vencido, renueva solo y sigue
  llamando al MCP;
- el CLI del bundle (`saleads-cli/scripts/saleads.py` 1.5.13).
