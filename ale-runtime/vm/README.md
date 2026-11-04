# VM del asistente (COS) — startup-script y watcher

`startup-script.sh` es un único archivo autocontenido. La plantilla de VM de
tu despliegue debe llevar una copia byte a byte; si cambia aquí, actualiza la
plantilla y compara su sha256 antes de crear instancias.

## Qué hace

- **Startup (cada arranque, sin argumentos):** se instala en
  `/var/lib/hermes/bin/hermes-vm.sh`, abre `tcp:8642` en el iptables del host
  (COS lo bloquea por defecto; el firewall de GCP lo limita a `10.202.0.0/16`),
  recrea `/etc/systemd/system/hermes-watcher.service` (en COS `/etc` es volátil)
  y lo arranca.
- **Watcher (`hermes-vm.sh watch`):** long poll a
  `instance/attributes/?recursive=true&wait_for_change=true&last_etag=…`
  (timeout 60 s, que además sirve de reintento). En cada cambio:
  1. Lee solo la lista cerrada de claves: `hermes-api-key`,
     `hermes-archive-url`, `hermes-bundle-version`, `hermes-config`,
     `hermes-env`, `hermes-mcp-tokens`, `hermes-skills`, `hermes-soul` y, desde
     ORQA cliente (OSB-005), `hermes-brain-image`, `hermes-seed-url` y
     `hermes-snapshot-url`, `hermes-restore-url` (restauración, D50) y
     `hermes-profiles` (especialistas, MLB-005a).
  2. Escribe en `/var/lib/hermes/data` (montado como `/opt/data`), dueño
     `10000:10000`, archivos `0600`, directorios `0700`:
     - `hermes-soul` → `SOUL.md`.
     - `hermes-config` → `config.yaml` **por fusión** (OCB-016): SaleADS es
       dueña solo de las claves de primer nivel `model`, `approvals` y
       `timezone` y de `mcp_servers.saleads`, `mcp_servers.saleads-brain` y
       `skills.write_approval` (ORQA, OSB-009; las demás claves de `skills` se
       conservan), `tools.tool_search` y, para el tablero de los especialistas
       (MLB-005a), `kanban.max_in_progress`, `kanban.auto_decompose`,
       `kanban.review_dispatch` y `kanban.auto_subscribe_on_create`. Toman el valor de la metadata; una
       que SaleADS administraba antes (`state/config-managed.list`) y ya no
       viene se elimina. Lo demás del archivo existente (`platforms`,
       `_config_version`, otros MCP… que Hermes escribe al configurar algo
       conversando) se conserva. La fusión corre con el python de la imagen
       (`--network none`): Hermes v0.21.6 trae `ruamel.yaml` detrás de su
       módulo `hermes_yaml` (no PyYAML); el helper prueba `hermes_yaml`,
       `ruamel.yaml` y `yaml`, en ese orden. El archivo fusionado se escribe
       en JSON (subconjunto de YAML: los strings van entre comillas, así `"off"`
       nunca se vuelve booleano). Sin archivo previo, o si el existente no es
       YAML válido, se escribe el valor de la metadata tal cual (lo segundo
       queda en el journal, sin valores). Solo corre si cambió el valor de la
       metadata. Un `hermes-config` que no es YAML válido no se aplica (sin ack).
     - `.env` **por fusión** (OCB-016): SaleADS administra las claves que trae
       `hermes-env` y todas las `API_SERVER_*` (`API_SERVER_ENABLED=true`,
       `API_SERVER_KEY=<hermes-api-key>`, `API_SERVER_HOST=0.0.0.0`,
       `API_SERVER_PORT=8642`; una `API_SERVER_*` de `hermes-env` se ignora).
       Una clave administrada la vez anterior (`state/env-managed.list`) que ya
       no viene se elimina; las demás líneas (p. ej. `TELEGRAM_BOT_TOKEN`,
       `TELEGRAM_ALLOWED_USERS`, que escribe Hermes) se conservan tal cual.
     - `hermes-mcp-tokens` (JSON `{"tokens.json": …, "client.json": …}`) →
       `mcp-tokens/saleads.json` y `mcp-tokens/saleads.client.json`. **Solo se
       escribe si cambió el hash del valor en la metadata**: Hermes es dueño del
       refresh y reescribe ese archivo.
     - `hermes-skills` (JSON `{ruta: contenido}` o tar.gz en base64) →
       `skills/<ruta>`. Rutas validadas (sin `..`, sin absolutas); solo agrega o
       reemplaza los archivos enviados.
  3. **Restauración (D50), una sola vez por VM y antes de crear Hermes:** si
     viene `hermes-restore-url` (GET firmado del último archivo del usuario,
     `gs://<bucket>/<user_id>/<ts>.tgz`) y Hermes nunca se creó en esta VM, la
     baja, la filtra con el helper python (`restore`, en streaming, tope
     `HERMES_RESTORE_MAX_BYTES`) y deja **solo** archivos regulares de
     `memories/`, `sessions/`, `state.db*`, `kanban.db*`, `kanban/` y lo mismo
     bajo `profiles/<n>/`. Nunca restaura `.env`, `auth.json`, `mcp-tokens/`,
     `config.yaml`, `SOUL.md`, `skills/`, enlaces ni rutas fuera de `/opt/data`.
     Lo que ya existe en el disco gana (archivo por archivo; un `-wal`/`-shm`
     solo viaja con su `.db`). Un profile solo se restaura si el archivo trae
     su `state.db` (marca de identidad de Hermes), para que `hermes profile
     create` nunca encuentre un directorio sin identidad. Publica
     `hermes/restore-status` = `restored:<n>:kept:<m>`, `failed:<http|invalid>`
     o `skipped:hermes_exists`. Un error transitorio (`000`, `408`, `429`,
     `5xx`) se reintenta `HERMES_RESTORE_TRIES` veces (3) sin arrancar Hermes
     ni publicar ack; después, o ante cualquier otro error, Hermes arranca sin
     el archivo. `state/restore.sha` marca que ya corrió.
  4. Arranca Hermes si falta: `docker run -d --name hermes --restart=always
     -p 8642:8642 -v /var/lib/hermes/data:/opt/data --env-file <solo API_SERVER_*>
     nousresearch/hermes-agent@sha256:55e192fb… gateway run`. La key de IA no
     va en el entorno del contenedor: Hermes lee `/opt/data/.env` con
     `override=True` en cada turno (G-07 de OCB-002), así que cambiar
     `hermes-env` no reinicia nada.
  5. Reinicia el contenedor **solo** si cambió el valor de `hermes-config`.
  6. **Especialistas (MLB-005a):** si viene `hermes-profiles` (tar.gz en base64
     de `profiles/<n>/{SOUL.md, profile-config.yaml, skills/…}`; el helper
     rechaza cualquier otra ruta), con Hermes corriendo (si no, sin ack):
     - crea cada profile **una sola vez** con `docker exec hermes hermes profile
       create <n> --no-skills` si su carpeta no tiene archivo de identidad
       (`config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json` o
       `state.db`); «already exists» cuenta como éxito. Nunca escribe en
       `profiles/<n>/` antes del `create`;
     - escribe `config.yaml` = `hermes-config` + `profile-config.yaml` (la capa
       gana; sin las claves `kanban`, que son de la raíz), `SOUL.md`, `.env` =
       `hermes-env` sin líneas `TELEGRAM_*`, `API_SERVER_*` ni `WHATSAPP_*`, su
       copia de `mcp-tokens/` (cuando cambia `hermes-mcp-tokens` o el profile
       no tiene) y sus skills, podadas con su propia lista. Estado por profile
       en `state/profiles/<n>/`. No reinicia Hermes: cada worker del tablero es
       un proceso `hermes -p <n>` nuevo;
     - una sola vez: `hermes tools enable kanban --platform` `api_server`,
       `cron`, `telegram` y `whatsapp` en la raíz, y un reinicio.
     Publica siempre `hermes/watcher-version` (3): el servicio solo manda
     `hermes-profiles` a un watcher que lo soporta (MLB-005b).
  7. Si llega una `hermes-archive-url` nueva: detiene Hermes, empaqueta
     `memories/`, `sessions/` y `state.db*` de la raíz y de cada
     `profiles/<n>/`, más `kanban.db*` y `kanban/` (nunca `.env`,
     `mcp-tokens/`, `auth.json`, `config.yaml`, `SOUL.md` ni skills),
     hace `PUT` con `Content-Type: application/gzip`, vuelve a arrancar Hermes y
     publica `hermes/archive-status` = `uploaded:<hash12>` o `failed:<http>`.
  8. Publica el ack en los guest attributes `hermes/applied-version` y
     `hermes/apply-status` (`ok` | `error`). Si algo falla no hay ack nuevo y
     reintenta con backoff.

Los logs (journal) solo llevan nombres de claves y prefijos de hash; nunca
valores, keys, tokens ni la signed URL.

Para comprobar el cargador YAML de la imagen fijada (en la VM, sin red):

```
docker run --rm --network none --entrypoint python3 <HERMES_IMAGE> \
  -c 'import hermes_yaml, ruamel.yaml; print("yaml ok")'
```

## Metadata al crear la VM

`instances.insert` con `sourceInstanceTemplate` **no fusiona** la metadata: si
la instancia trae `metadata.items`, reemplaza entera la de la plantilla. El
servicio debe leer la plantilla y enviar todas sus claves (`startup-script`,
`enable-guest-attributes`, …) más las `hermes-*`.

## Cerebro del negocio (ORQA cliente, OSB-005)

Con `hermes-brain-image` (una imagen de `us-central1-docker.pkg.dev/...@sha256:`,
nunca un tag) el watcher también:

- crea la red docker `hermes-net` y corre `falkordb` (imagen fijada, `--memory
  768m`, `maxmemory 512mb`, sin puertos publicados, datos en
  `/var/lib/hermes/brain/falkordb`);
- autentica docker contra el repositorio privado `saleads-brain` con el token
  de metadata de la VM (`docker-credential-gcr`; la SA de la VM solo puede leer
  ese repositorio) y corre `saleads-brain` en `hermes-net`, con el env derivado
  de `.env` (la key de IA del dueño; nunca `API_SERVER_*` ni `TELEGRAM_*`);
- conecta `hermes` a `hermes-net` con `docker network connect`, sin recrearlo;
- con `hermes-seed-url` (GET firmado) baja la semilla a `saleads/seed/seed.json`
  y la carga con `saleads-brain ingest-seed`, sin IA (`hermes/seed-status`);
- crea, una sola vez, los jobs sin agente `saleads:brain-{ingest-day,analyze,
  export-snapshot,extract-lessons}` con `hermes cron create --no-agent`
  (`POST /api/jobs` no acepta script); sus scripts llaman a
  `http://saleads-brain:8765/run/<cmd>` y con stdout vacío no envían nada;
- sube `saleads/graph/snapshot.json.gz` a `hermes-snapshot-url` (PUT firmado)
  solo cuando cambia su sha (`hermes/graph-snapshot`, `hermes/snapshot-status`).

Skills: el watcher guarda la lista de archivos que escribió desde
`hermes-skills` (`state/skills-managed.list`) y borra solo los que SaleADS ya no
envía. Las skills que crea el agente nunca están en esa lista.

## Contrato `hermes/applied-version`

```
lines = ""
for key in [hermes-api-key, hermes-archive-url, hermes-bundle-version, hermes-config,
            hermes-env, hermes-mcp-tokens, hermes-skills, hermes-soul,
            hermes-brain-image, hermes-seed-url, hermes-snapshot-url,
            hermes-restore-url, hermes-profiles]:   # este orden
    if key está en la metadata:
        lines += key + " " + sha256hex(valor exacto en bytes) + "\n"
applied-version = sha256hex(lines)
```

El servicio calcula lo mismo sobre los items `hermes-*` que dejó en la
metadata (después del merge) y espera la igualdad. La implementación de
referencia está en `test/watcher-test.sh` (`expected_version`). Requiere
`enable-guest-attributes=TRUE`, que viene en la metadata de la plantilla.

## Pruebas

```
bash vm/test/watcher-test.sh
```

Sin Docker ni nube: `test/fake_metadata.py` simula el servidor de metadata
(long poll con ETag, guest attributes y la signed URL) y `test/fake-docker.sh`
registra las llamadas a docker. Requiere bash, curl, python3 y tar.
