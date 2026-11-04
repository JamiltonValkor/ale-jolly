# Plan de implementación: experiencia local para el jurado (v1, 4-nov-2026)

Base: las cuatro revisiones de código del 4-nov (nube, SaleADS, front y Jolly). Ninguna línea se escribe antes del OK del owner a este plan.

## 0. Objetivo y reglas

- **Objetivo:** el evaluador clona `ale-jolly`, pone su `META_API_KEY`, corre `./demo.sh` y en 15 minutos o menos usa el producto completo en `http://localhost:3000`: activación con un clic, Ale con Muse Spark, Cerebro, Stock y Jolly en su portátil.
- **Regla 1, sin cambios de lógica:** el producto se configura; lo externo se imita con el mismo protocolo (Compute de GCP, Storage, Keycloak, MCP de SaleADS, PostHog). Los únicos cambios de código permitidos son adaptadores mínimos detrás de una variable `LOCAL_MODE`, cada uno listado en este plan.
- **Regla 2, reglas del hackathon:** repo nuevo solo con trabajo posterior al kickoff. Lo previo se declara como dependencia. Toda llamada a modelos en ejecución es de Meta, excepto el TTS.
- **Regla 3, honestidad:** todo lo simulado se ve marcado («simulado» o «grabado del robot real»).

## 1. Decisiones previas (necesitan OK del owner)

| # | Decisión | Recomendación | Por qué |
|---|---|---|---|
| D0 | Cómo separar lo previo al kickoff | **Overlay.** `ale-jolly` guarda solo archivos posteriores al kickoff. La base previa (`ale-runtime` en el snapshot `926a073` y los módulos previos del front) se publica como dependencia declarada, fijada por commit. El build arma la imagen con base más overlay. Los 67 archivos mixtos entran completos y se listan en `HACKATHON.md`. **Confirmarlo con los organizadores en Discord** antes de F4 | Cumple «solo trabajo posterior» sin reescribir la base |
| D1 | El producto exige HTTPS (emisor de Keycloak, `MCP_URL`, PostHog, relay de Meta) | **TLS local con Caddy y CA interna** generada en `demo.sh`. `NODE_EXTRA_CA_CERTS` en ale-runtime y front; la CA montada en cada «VM». Cero cambios de código | Hermes, dentro de la VM, también valida el MCP y el OAuth; relajar http solo en ale-runtime no alcanza |
| D2 | Storage con host fijo `storage.googleapis.com` | El nombre resuelve a `cloud-sim` dentro de la red y de cada «VM» (`extra_hosts`), con certificado de la misma CA. `cloud-sim` implementa GCS (JSON API y URLs firmadas V4, sin validar firma) | Archivo, restauración, semilla, snapshots y fotos de Jolly funcionan sin tocar código |
| D3 | Cerebro (FalkorDB + `saleads-brain`) | **Fase 1 apagado** (`BRAIN_IMAGE=''`). Fase 2 opcional: registro local con el nombre esperado vía la misma CA | La imagen exige Artifact Registry; no bloquea la demo |
| D4 | Modelo de Ale siempre de Meta | `MANAGED_META_ENABLED=true` y `MANAGED_META_ALL_USERS=true`, con relay `api.meta.ai` y la llave del evaluador; `STOCK_EXTRACT_MODEL` fijado a un modelo Meta. Si el catálogo sigue ofreciendo otros proveedores en pantalla: adaptador `LOCAL_MODE` que los oculta (cambio 1) | Regla «solo Meta en ejecución» |
| D5 | PostHog obligatorio | `saleads-sim` imita `/decide` y `/capture`: banderas en verdadero, eventos descartados | Sin cuenta de PostHog |
| D6 | Varias «VMs» | Una «VM» es un contenedor `docker:dind` con su IPv4 en la red `ale`, el watcher (`vm/startup-script.sh watch`) tal cual y `HERMES_MD_URL` apuntando a `cloud-sim` | Fiel: el watcher usa nombres fijos (`hermes`, `hermes-net`) |
| D7 | Sesión del front | Reusar el precedente `local-review-session` y `E2E_AUTH_BYPASS`, con un token emitido por `saleads-sim` (JWT RS256 que ale-runtime acepta) | Ya existe en el front |
| D8 | Evidencias | Se excluyen `credencial-cto.env` y los `*.tgz` de respaldo. Se redactan correos, IPs, ids de Telegram, habla real de la sala y rutas `/home/pi`. **Rotar las llaves** de Meta, Cartesia y del dispositivo | Dos archivos traen credenciales reales |

## 2. Arquitectura del compose (red `ale`)

| Servicio | Imagen | Rol |
|---|---|---|
| `caddy` | oficial | TLS interno: `saleads.local`, `storage.googleapis.com`, `posthog.local`, `relay.local` → servicios |
| `postgres` | `postgres:16` | Base de ale-runtime |
| `ale-runtime` | base más overlay (D0) | Backend real; solo configuración |
| `cloud-sim` | nueva | Imita Compute, metadata, IAM signBlob y GCS; crea las «VMs» dind |
| `vm-<id>` | `docker:dind` más el watcher | Una por asistente; adentro Hermes oficial (imagen fijada por digest) |
| `saleads-sim` | nueva | Imita Keycloak (OIDC, JWKS, PKCE, refresh, revoke), el MCP y `/agent/v1`, las APIs internas que use ale-runtime, PostHog y las landings |
| `front` | overlay del front | Meta Assistant sin login |
| (host) `jolly-sim` | proceso local | Jolly en el portátil |

## 3. Piezas, tareas y criterios de terminado

### P1 `cloud-sim` (sesión A)

1. **Compute v1** (`COMPUTE_API_BASE`), según la revisión de la nube:
   - `GET` de la plantilla, con `startup-script` incluido;
   - `insert` con `requestId` y 409 si ya existe;
   - operaciones con `DONE` y errores `RESOURCE_ALREADY_EXISTS` y `CONDITION_NOT_MET`;
   - `GET` de la instancia: `id` numérico estable, `status`, IPv4 y `metadata.fingerprint`;
   - `setMetadata` con fingerprint y 412 si está viejo;
   - `stop`, `start` y `delete`;
   - `getGuestAttributes` en sus dos formas.
2. **Token de metadata** en `/token` (http), **IAM** `signBlob` y **GCS** (exists, upload, download, list), más el host de las URLs firmadas por Caddy.
3. **«VM» dind:** monta `vm/startup-script.sh`, corre `watch` y usa `HERMES_DOCKER_CRED=true`. La metadata la sirve `cloud-sim` (reusar `vm/test/fake_metadata.py`: long poll con ETag y guest attributes).
4. **Hecho cuando:** activar → `ready` → `orqa synced` → un turno de chat responde con Muse Spark. Desactivar, reactivar y borrar funcionan, con archivo y restauración. Hay pruebas automáticas del contrato Compute.

### P2 `saleads-sim` (sesión C)

1. **OIDC completo:** discovery, JWKS RS256, `authorize` con PKCE y `prompt=none`, `token` (code y refresh), `revoke`, y los `/.well-known/oauth-protected-resource` del MCP. Claims: `iss`, `aud`, `azp` (`front` para la web; `mcp-saleads-assistant-dev` para el asistente), `typ=Bearer` y `sub` del contrato.
2. **MCP** Streamable HTTP sin sesión (versiones 2026-07-28 y 2025-11-25), con `structuredContent`, más `/agent/v1/commands`. **Núcleo con estado:** cuenta y negocios, perfil, bootstrap, ofertas, estrategia, versión y plan, apuestas, operaciones, landings con versiones y destino. **Stock:** reenvío a `ale-runtime /internal/stock/...` como el real. **El resto:** respuestas de demo coherentes y válidas contra su esquema (`contracts/schemas`).
3. **Landings servibles:** guarda `files` por versión, sirve `/l/{id}/v/{n}/`, tiene un «publicar» que simula al dueño y genera `preview` con un JPEG fijo o Playwright.
4. **Gateway clásico mínimo** que usa el front: `/api/subscription/language`, `/api/campaigns/agentic/v1`, `/api/subscription/credits/agent-cap` y `/api/integration/meta/configuration`. También PostHog.
5. **Hecho cuando:** pruebas por herramienta contra su esquema, ale-runtime acepta el token web, Hermes renueva su token solo, y una landing creada por el agente se ve en el navegador.

### P3 `front` (sesión B)

1. Overlay del front: copiar la sección (445 archivos), `features/autonomous-team` (lo importa la página) y `embedded-composer-v2` importado directo, no por el barrel.
2. **Stubs** en el mismo path de import:
   - `next-auth` y `getSession`: sesión demo D7;
   - `use-business-store`: `{business_id, business_name, offering_type}` fijo;
   - `use-select-business` y `business.api`;
   - `use-feature-flag`, `use-breadcrumb-store` y `useAleOrbHidden`: sin efecto.
3. **Se trae de la base como dependencia:** el design system (`sa-*`, `components/ui/*`, `cn`), `lib/fetch/api-client` y `server-gateway`, `shared/lib/bff`, `trace-context`, `landing-feedback` y las fuentes. CSS de Tailwind 4 (`globals.css`, `sa-*.css`, `meta-ui.css`) y el middleware solo con next-intl.
4. **Variables:** `META_ASSISTANT_SERVICE_URL=http://ale-runtime:8060` (el front ya acepta http en hosts internos; agregar `ale-runtime` es el cambio 2), `META_ASSISTANT_ALL_USERS=true` y `GATEWAY_URL` hacia `saleads-sim`.
5. **Hecho cuando:** `next build` pasa, las 7 pestañas y la vinculación cargan sin errores contra el backend local, y la pantalla de vinculación reclama el código de Jolly.

### P4 `jolly-sim` y evidencias (sesión D)

1. **Empaquetar `robot/`** con `start.sh` para macOS y Linux:
   - Python 3.12 y los requisitos fijados;
   - ffmpeg y PortAudio verificados por `doctor`;
   - `ALE_RUNTIME_URL=http://localhost:8060`;
   - cámara `avfoundation` o `v4l2`, o `carpeta:` con fotos de ejemplo;
   - sin brazos.
2. **Voz de salida:** Cartesia si hay llave; si no, `say` en macOS y **un `Locutor` nuevo con espeak/`spd-say` en Linux** (cambio 3, aditivo).
3. **Repetición:** reproductor de `bus-*.jsonl` en los puertos del bus, con la etiqueta «REPLAY · traza real del …» en la cara y `voz/frase` leída por TTS local.
4. **Evidencias** según D8: el corpus de imágenes se etiqueta como «generado con Muse Image» y las fotos reales salen de `sim/*/ojo-datos` y `ojo/`.
5. **Hecho cuando:** Jolly se vincula con el código desde el front, oye, cuenta con SAM una foto, la sube (GCS simulado) y la numerada se ve en la web. La repetición funciona sin backend.

### P5 Empaque, CI y verificación (yo)

1. `demo.sh` con `doctor` (Docker, puertos, llave, ffmpeg y PortAudio), `up` (genera la CA y `.env`, y descarga imágenes), `down` y `reset`.
2. Imágenes multi-arquitectura en GHCR. Si el build de la base es privado, las imágenes son públicas y el `Dockerfile` del overlay queda en el repo.
3. **CI:** compose desde cero más una prueba de extremo a extremo (activar, chatear, contar con una foto de ejemplo, ver Stock) en cada PR.
4. **Modo repetición** sin llave: respuestas grabadas de Muse Spark, marcadas.
5. **Prueba de fuego:** este Mac y luego el otro computador del owner, siguiendo solo el README, con cronómetro.

## 4. Cambios de código permitidos (lista cerrada)

1. ale-runtime: ocultar proveedores no Meta con `LOCAL_MODE` (solo si D4 lo requiere).
2. front: aceptar `http://ale-runtime` como origen interno del servicio.
3. robot: un `Locutor` de Linux (espeak) como respaldo de voz.

Cualquier otro cambio que aparezca se trae al owner antes de hacerlo.

## 5. Orden y paralelismo

- **Día 1:** D0 a D8 aprobadas → P1, P2, P3 y P4 en paralelo, una sesión por pieza en su carpeta y con PR. Yo armo el compose y Caddy (P5.1) y voy integrando.
- **Integración:** P2 con P1 primero (activación y chat), luego P3 (pantallas) y luego P4 (Jolly).
- **Cierre:** CI, prueba de fuego en los dos computadores, README con F5 y el video.

## 6. Riesgos principales y mitigación

| Riesgo | Mitigación |
|---|---|
| Docker-in-docker pesado o bloqueado en la máquina del evaluador | `doctor` lo detecta; plan B: una sola «VM» usando el socket del host (`HERMES_DOCKER` con prefijos) |
| Hermes rechaza la CA local | Montar la CA en la «VM» y en el contenedor de Hermes (`SSL_CERT_FILE`); probarlo el primer día |
| El MCP simulado no cubre una herramienta que Ale invoca | Pruebas por herramienta y registro de herramientas desconocidas durante la integración |
| El evaluador no tiene llave de Meta | Modo repetición marcado |
| Imágenes pesadas o lentas | Imágenes fijadas y descarga previa con `./demo.sh up --pull` |
| Fuga de datos o llaves | Barrido de secretos en CI, lista de exclusión de evidencias y rotación de llaves |
