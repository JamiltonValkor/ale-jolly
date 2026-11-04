# front: Meta Assistant en modo local (P3)

La pantalla **Meta Assistant** de SaleADS, sin login, en `http://localhost:3000`. Es un overlay (D0): el código de la sección se copia tal cual desde `sa-domain-client` y lo externo se reemplaza por stubs en el mismo path de import. No hay cambios de lógica salvo el **cambio 2** del plan (§4).

- Origen: `sa-domain-client`, rama `develop`, commit `fc5d2108d`.
- Stack: Next.js 16.4.1, React 19.2.4, next-intl 4.8 y Tailwind 4 (las mismas versiones que SaleADS).
- Qué archivo es del hackathon y cuál de la base previa, con fechas: [`BASE-DEPENDENCIES.md`](BASE-DEPENDENCIES.md).

## Cómo correrlo

Con el resto del compose (ver `local/`):

```bash
docker compose -f local/docker-compose.yml -f local/compose.front.yml up front
```

Solo el front, en desarrollo:

```bash
pnpm --dir front install && pnpm --dir front dev
```

Sin backend, la página real muestra «Esperando la sesión demo». Para revisar las pantallas sin backend están los dev labs (solo en `next dev`):

| Lab | Qué muestra |
|---|---|
| `/es/dev/meta-assistant-lab?screen=today` | Hoy (también `chat`, `limits-set`, `activity`, `start`, `preparing`…) y la oficina |
| `/es/dev/meta-brain-lab` | Cerebro |
| `/es/dev/companion-pairing-lab` | Cara, pantalla del robot y vinculación con código |
| `/es/dev/companion-3d-lab` | Compañero 3D |

## Variables

| Variable | Valor local | Para qué |
|---|---|---|
| `META_ASSISTANT_SERVICE_URL` | `http://ale-runtime:8060` | Backend real (BFF `/api/meta-assistant/*`) |
| `META_ASSISTANT_ALL_USERS` | `true` | Admite al usuario demo (ADR0031) |
| `GATEWAY_URL` | `https://saleads.local` | Gateway clásico simulado por `saleads-sim` (también en el build: rewrite `/__gw`) |
| `KEYCLOAK_TOKEN_URL` | `https://saleads.local/realms/sale-ads/protocol/openid-connect/token` | Token web del usuario demo (D7) |
| `KEYCLOAK_ISSUER` | `https://saleads.local/realms/sale-ads` | Relanzar el OAuth de Meta |
| `ASSISTANT_BFF_PUBLIC_ORIGIN` | `http://localhost:3000` | Origen que el BFF exige al navegador |
| `NODE_EXTRA_CA_CERTS` | `/certs/ca.crt` | CA local de Caddy (D1) |
| `NEXT_PUBLIC_GATEWAY_URL` | `/__gw` (build) | El navegador llega al gateway por el rewrite |

Opcionales: `LOCAL_SESSION_CLIENT_ID` (`front`), `LOCAL_SESSION_USERNAME` (`demo-owner`), `LOCAL_SESSION_PASSWORD` (`demo`), `LOCAL_SESSION_ACCESS_TOKEN` (token fijo, solo depuración) y `NEXT_PUBLIC_DEMO_*` (usuario y negocio demo).

Lo que el front pide a `saleads-sim` (token y gateway) está detallado en la nota compartida `front-gateway.md` de las sesiones.

## Qué se copió

Literal desde SaleADS (sin tests):

- La ruta `src/app/[locale]/(protected)/dashboard/(with-sidebar)/meta-assistant/**`, con aprobaciones.
- El BFF `src/app/api/meta-assistant/**` (41 rutas) y `src/app/api/autonomous-team/**` (4 rutas que usan Actividad y Límites).
- `src/features/sales-assistant/**`, `src/features/companion/**` y lo que la página usa de `src/features/autonomous-team/**` (componentes, hooks, sdk, tipos y su `server/`).
- `src/shared/meta-ui/`, `src/shared/shells/meta-*`.
- El compositor del chat: `src/features/agent-chat/components/shell/embedded-composer-v2.tsx` con sus dependencias (15 archivos más 2 fuentes).
- Los dev labs `src/app/[locale]/dev/{meta-assistant-lab,meta-brain-lab,companion-3d-lab,companion-pairing-lab}`.
- Traducciones (`es` y `en`): `meta-experience`, `sales-assistant`, `meta-brain`, `autonomous-team`, `companion`, `meta-assistant` y `common`.
- Dependencias de la base: `shared/components/sa-*`, `components/ui/*` (shadcn), `lib/utils`, `lib/fetch/{api-client,gateway-client,server-gateway}`, `shared/lib/bff/*`, `shared/observability/trace-context`, `shared/landing-feedback/*`, `shared/contracts/agent-budget`, `shared/lib/authorship`, `lib/auth/session-{health,events}`, `store/use-breadcrumb-store`, `types/*`, las fuentes y el CSS (`globals.css`, `sa-primitives.css`, `sa-tokens.css`, `meta-ui.css`, `google-fonts.css` y los CSS modules). Los assets de `public/` que esos archivos referencian.

Fuera de alcance: `agent-landings` y `promise-landing` (la landing se ve en `saleads-sim`), y la pantalla `/companion` del robot (Jolly corre en `jolly-sim`).

## Qué se reemplazó

Stubs en el mismo path de import:

| Import | Reemplazo |
|---|---|
| `next-auth/react` | `src/lib/auth/local/next-auth-react.tsx` (alias en `tsconfig` y `turbopack.resolveAlias`): `useSession`, `getSession` y `SessionProvider` con la sesión de `/api/auth/session` |
| `@/lib/auth/auth`, `@/auth` | Sesión demo `{user:{id,name}, accessToken}` con el token que emite `saleads-sim` (`src/lib/local/demo-session.ts`) |
| `@/store/use-business-store` | Store zustand con el negocio demo fijo (`business_id`, `business_name`, `offering_type`); también deja `localStorage['business-store']` para el `X-Business-Id` del cliente de gateway |
| `@/hooks/mutations/use-business-mutations` | `useSelectBusiness` sin efecto (hay un solo negocio) |
| `@/lib/api/business.api` | `listBusinesses` con el negocio demo |
| `@/hooks/queries`, `@/hooks/queries/keys` | `useReconciledBusinessId` y las claves de negocios |
| `@/hooks/use-feature-flag` | Siempre verdadero (sin PostHog) |
| `@/features/ale` | `useAleOrbHidden` sin efecto (no hay orbe global) |
| `@/features/agent-chat` | Barrel reducido: solo `EmbeddedComposerV2` (el real arrastra unos 1.650 archivos) y `AgentModeSidebarCard` vacía para el lab |
| `@/lib/providers` | React Query, sesión demo y toasts, sin Auth.js, PostHog ni trazas |

Reescritos mínimos (mismos exports): `src/app/layout.tsx`, `src/app/[locale]/layout.tsx`, `src/app/[locale]/(protected)/layout.tsx` (sesión demo en vez de login), `src/proxy.ts` (solo next-intl; `/` lleva a Meta Assistant), `src/i18n/messages.ts` (solo los namespaces de la sección) y `agent-chat.json` (solo `composer` y `real`).

Nuevo del modo local: `src/lib/local/*` y `src/app/api/auth/session/route.ts` (equivalente a la ruta de Auth.js).

**Cambio 2 (§4):** `src/features/sales-assistant/server/meta-assistant-service.ts` acepta `http://ale-runtime` como origen interno del servicio.

## Docker

`Dockerfile` hace el build de producción (`next build`, salida standalone) y arranca con `node server.js` en el puerto 3000. El servicio está en `local/compose.front.yml`.
