# Stock

Inventario de la ola `inventario-vivo-v1`. Es una carpeta separada del servicio para poder apagarla, retirarla o
llevar el resto a SaleADS sin arrastrarla.

## Frontera

- Todo el código vive en `src/stock`; el contrato, en `src/contracts/stock-v1.ts`.
- Fuera de esta carpeta solo la importan `src/main.ts` y `src/app.module.ts`. `test/stock-frontera.spec.ts` falla con
  cualquier otro importador, y también si `src/stock` importa de `robot/` o de `src/activation` algo que no sea un tipo.
- `architecture.md` §4 lista cerrada de piezas compartidas que esta ola puede tocar.
- La tabla de verdad es `assistant.stock_movements`, de solo inserción. El servidor es la barrera: una regla de plata,
  destinatario, tope o no negativo se valida aquí y nunca en el modelo. Las decisiones comerciales son del agente.

## Canal robot

`device-ops.ts` atiende `POST /devices/me/stream` cuando el cuerpo trae `op`. `DevicesController` conoce solo la interfaz
`StockDeviceOps`, y `app.module.ts` la provee. Sin Stock o con usuario fuera, el cuerpo cae a `StreamRequestV1`, que lo
rechaza igual que antes. Nada de esta ruta abre turno. Contrato en `robot/voz-hermes/cuerpo/CONTRATO.md`.

`photos.ts` guarda fotos en `STOCK_BUCKET` con URL firmada, por medio de `PhotoStore`. Con el bucket vacío pedir foto
responde 503. El adaptador real es `gcsPhotoStore`; las pruebas usan un doble.

## Complemento

`distribution/stock-addon/1.0.8` se aplica por usuario sobre `saleads-sales-agent@1.5.13`, que no se toca. `addon.ts` valida
los hashes de `manifest.json` y arma el `AgentBundle` efectivo. Sin `STOCK_USER_IDS`, `OrqaSync` usa la referencia
original: `test/stock-orqa.spec.ts` compara cada llave `hermes-*` con una foto de `origin/main`, byte a byte.
`test/fixtures/stock-igualdad/desired-main.json.gz` se regenera solo si `main` cambia a propósito esas llaves.

`src/orqa` y `src/activation` no importan de aquí: conocen `BundleAddon` y `McpConfig.saleadsExclude`, y `main.ts` conecta.
La versión con `+stock-1.0.8` solo sale en `hermes-bundle-version`. Eventos, `done` y trabajos leen la base.

O-10: al habilitado se le suma `tools.exclude` en `mcp_servers.saleads` de Ale con `supplier_send`, `take_photo`,
`supplier_wait` y `document_extract`. Cambia `hermes-config`, y eso reinicia el gateway una vez por usuario. Ese mismo
reinicio hace que Ale vea las herramientas nuevas (S-33). La capa del perfil `stock` lleva `exclude: []`, porque el watcher
fusiona `hermes-config` debajo de cada perfil.

## Ciclo y despertar

S-19 mostró que una orden en el SOUL no se cumple en un tick. Por eso el ciclo es el trabajo `saleads:stock-tick`
(`jobs.json`), a los 30 minutos de cada tercera hora para no chocar con `saleads:loop-tick`. `ManagedBusinessJobs` recibe un
solo bundle, así que `main.ts` crea una segunda instancia con `stockJobsBundle`, y `stockJobSync` la limita al usuario y al
negocio habilitados. La instancia de 1.5.13 y sus hashes no cambian. Se instala cuando corre el flujo del primer uso, igual
que los demás trabajos gestionados, porque necesita negocio y sesión de confianza.

`wake.ts` corre ese trabajo, no `saleads:loop-tick`, cuyo prompt no conoce a Stock. Lee antes `enabled` y `paused_reason`,
porque en Hermes `trigger_job` borra la pausa del dueño. Tope de 8 al día por negocio y antirrebote de 120 s. Nunca lanza.

`sync-driver.ts` lleva Stock a la VM sin abrir la web: cada `STOCK_SYNC_INTERVAL_MS` para `STOCK_USER_IDS`, y al abrir
`op:events`. Usa el `onReady` envuelto de `main.ts`. No arranca sin `MANAGED_META_ENABLED`.

## Proveedores y negociación

`suppliers.ts` calcula cuándo y cuánto pedir y compara por costo total. Las cotizaciones nacen de `bench_seed`: no hay búsqueda de
proveedores reales. `negotiation.ts` guarda todo en base: mandato, mensajes y cursor del poller, así que un worker o un pod caídos
no pierden nada.

`SupplierChannel` no recibe destinatario: lo fija el adaptador con `STOCK_SUPPLIER_DESTINATION`. Hay dos adaptadores:

- `banco` (`BenchSupplierChannel`): no toca ninguna red y exige `STOCK_BENCH_ENABLED`; `bench_supplier_reply` hace de proveedor.
- `telegram` (`supplier-telegram.ts`): un bot propio de ale-runtime, distinto del bot del asistente en la VM, con el token en
  `STOCK_SUPPLIER_TELEGRAM_TOKEN` (secreto del servicio). El destino es el id numérico de una persona. Telegram confirma a qué chat
  entregó y se corta si no es ese; solo entra lo escrito por esa persona en su chat privado, y lo demás se ignora y se cuenta.
  Si el proveedor nunca le escribió al bot, enviar da `ventana_cerrada`. Lo entrante sigue saliendo `no_confiable`.

Sin `STOCK_SUPPLIER_CHANNEL`, enviar y esperar responden 503 y el resto funciona. El cursor del poller es uno solo: Telegram usa
`TELEGRAM_CURSOR_BASE + update_id`, muy por encima del reloj del banco, así que cambiar de adaptador en cualquier sentido no pierde mensajes.

Recepción: primero `conteo` con `order_id`, que guarda lo recibido sin mover el libro, y luego `entrada` con `order_id`, solo en
pantalla, que entra las unidades, cuadra contra el conteo y escribe `saving_confirmed`. Así un conteo por voz nunca escribe plata.

## Memoria (O-7)

Stock es un rol como los demás subagentes: tablero, ContextPack y `saleads_memory_recall`. `vm/` y `contracts/` no cambian.
`distribution/stock-addon/1.0.8/rol/` trae el catálogo y los esquemas con `stock`, y `addon.extensions` los pone sobre
`hermes-extensions` solo para habilitados: mismos nombres de archivo, así que el watcher los acepta. Ese catálogo mete a `stock`
en `ROLES`, en `COMMERCIAL_PROFILES` y en `PROFILES` de la captura.

Brain solo reconoce roles que están en sus esquemas. `STOCK_BRAIN_IMAGE` es una imagen derivada de la vigente, con receta en
`rol/RECETA-brain.md`, y solo la reciben los habilitados. Sin ella, con `STOCK_USER_IDS` lleno, el servicio no arranca.

Lo de terceros no pasa directo a memoria. Stock solo lee: no tiene `saleads_memory` de escritura, ni herramientas de
`saleads-brain`, ni memoria nativa, ni revisión de fondo. Lo único que sale es su resultado final, que la captura genérica
entrega al curador como trabajo generado y no como testimonio. El SOUL prohíbe citar terceros en ese resultado. Esa última
regla depende del modelo. La barrera dura es que el curador decide y que ninguna herramienta de Stock escribe.

## Avisos

`notices.ts` es la cola de voz sobre `stock_robot_events`, tipo `decir`. Solo Ale escribe con `POST /robot/say`; el servidor
escribe plantillas: autonomía, y el respaldo de S-20 para el conteo de una foto, retenido 120 s para que Ale llegue
primero. `say` con esa propuesta la reemplaza y hereda su cupo. Con propuesta de autonomía el texto del modelo se ignora.

Topes en `STOCK_LIMITS`: 3 por día (`stock_usage.avisos_voz`, o `stock_run_budgets` con corrida y banco), 1 por producto cada
24 h, voz de 07:00 a 21:00 en la zona de `assistants.timezone` con `clock(business)`, vencimiento a 6 h. Lo creado desde
las 21:00 gasta el cupo del día siguiente. Prioridad alta no salta horario ni tope: solo pasa primero en el robot.

Un aviso vencido, sobre el tope o repetido queda `para_canal`. No sale de aquí al canal: WhatsApp y Telegram salen de
Hermes. Ale lo lee una vez, junto, en `avisos_canal` de `GET overview`; leerlo lo marca entregado. La respuesta del dueño
llega a Hermes con `turnContext`, fuera de `deviceContexts`, una sola vez y hasta 180 s después de dicho.

## Apagar

`STOCK_ENABLED=false`, el valor por defecto. `buildStock` devuelve `undefined`: no hay rutas (404 con contrato), ni
consultas a `stock_*`, ni procesos. Para sacar a un negocio basta quitarlo de `STOCK_USER_IDS` o de
`stock_enabled_businesses`. Los datos se conservan.

## Volver atrás en una VM

Sacar al usuario de `STOCK_USER_IDS` devuelve metadata, Brain y catálogo en el siguiente `onReady`, y reinicia el gateway una
vez porque cambia `hermes-config`. El watcher no borra perfiles (S-43) y el trabajo sigue en Hermes, así que después, con
`orqa.synced` visto:

```bash
scripts/stock-retirar-vm.sh --instance sa-assistant-… --zone us-central1-a --project saleads-dev          # simulacro
scripts/stock-retirar-vm.sh --instance sa-assistant-… --zone us-central1-a --project saleads-dev --apply
```

Borra `saleads:stock-tick:*`, el perfil y su estado en el watcher. Usa SSH por IAP, con permiso de quien opera. Para habilitar
de nuevo esa misma VM hay que borrar las filas `base_name='saleads:stock-tick'` de `assistant.managed_job_intents`: si no, se
leen como un trabajo que el dueño borró y no se recrea.

## Retirar

1. Quitar las líneas marcadas de Stock en `src/main.ts` y `src/app.module.ts`, y las llaves `STOCK_*` de `src/config.ts`.
2. Borrar `src/stock`, `src/contracts/stock-v1.ts`, `docs/stock-*.md` y `test/stock-*`.
3. Quitar el trabajo `stock-postgres` y `scripts/stock-postgres-real.sh`.
4. V19 es inmutable y aditiva: las tablas `assistant.stock_*` se pueden dejar, o borrar con una migración nueva. Al
   portar a SaleADS se renumera; no se reservan números altos.

`CONFLICT` y `STOCK_NEGATIVE` son códigos aditivos de `ErrorCodeV1`: pueden quedarse sin efecto.

## Migración V19

`migrations/V19__stock_inventory.sql` queda lista, sin aplicar. El servicio no corre DDL al arrancar. **Pendiente
(S-15):** las plantillas privadas del Job de Flyway no están en el workspace. Hay que reconstruirlas con la receta de
`migrations/README.md` o recibirlas del owner en IVB-021. S-16 sigue parcial, por eso V19 trae sus GRANT explícitos.

`scripts/stock-postgres-real.sh` valida Flyway, un segundo `migrate` sin cambios y la matriz de grants sobre Postgres
desechable. Corre en el trabajo `stock-postgres` de GitHub Actions, nunca con Docker en el Mac.

## Barreras contra inyección

El corpus vive en `test/fixtures/stock-inyeccion/` y corre con un modelo falso que obedece, en rol Stock y en rol Ale.

- `canal`: cita afirmativa, nunca con `order_id`, máximo 3 por negocio en 10 minutos. Queda `canal_atestiguado` en `get_item` y en `stock_audit`, y Jolly lo dice.
- Foto: `contado` no supera el total de SAM, y un reintento conserva la fecha de la foto.
- Texto de `titulo`, `motivo` y efectos: plantilla. Lo de terceros sale sin caracteres ocultos.
- Pregunta por lo recibido de un pedido: la escribe el servidor con la cifra, aunque Ale mande otra.
- Negociación: sin actividad por `abandonedHours` queda `expirada` y el pedido `cancelado`, por temporizador y al abrir otro pedido.
## Operación

`usage.ts` es la única puerta de los topes: `spend` niega al exceder, `record` mide sin negar, `exhausted` frena lo siguiente y `reserveCard` entrega la clave de cada tarjeta. `maintenance.ts` vence negociaciones cada hora y retiene frases una vez al día. `traceMovement`, en `audit.ts`, da la cadena de un movimiento. El manual es `docs/stock-operacion.md`.
