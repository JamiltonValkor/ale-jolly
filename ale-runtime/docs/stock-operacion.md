# Operación de Stock

Manual de apagar, retener, rotar la llave y leer los topes. Se escribe en IVB-020 y se prueba en IVB-028. En dev ya se probaron el bucket, la coexistencia, los topes y el apagado con la VM encendida (2-nov-2026).

## Apagar

1. Pon `STOCK_ENABLED=false` y despliega. **Cambiar variables reinicia el pod, y dev tiene una sola réplica:** avisa a las sesiones que lo usen.
2. Con la bandera apagada, `buildStock` no construye nada: sin rutas, sin temporizadores, sin poller, sin retención. Las rutas web responden 404 y el front lo lee como apagado.
3. Los datos quedan intactos en Postgres y en el bucket. Volver a encender retoma.

**Si se apaga con la VM encendida.** El `SOUL.md` de la VM sigue pidiendo tarjetas a un Stock sin herramientas hasta la siguiente sincronización. El trabajo `saleads:stock-tick` sigue corriendo cada 3 horas y cada turno falla pagando IA. Para cortar ese gasto, sincroniza el asistente (reinicia el gateway) o pausa `saleads:stock-tick` en la VM. Para medirlo, corre el tick a mano (`POST /api/jobs/<id>/run` en la API de Hermes de la VM) y suma `input_tokens` de la sesión `cron_<id>_*` y de la tarjeta que cree. Retirar un usuario no borra el perfil del disco: usa `scripts/stock-retirar-vm.sh`.

Medido en dev (IVB-028): con Stock apagado, un tick de `saleads:stock-tick` falla en 3 herramientas, no crea tarjeta y cuesta 10.647 tokens de entrada sin caché, 1.750 de salida y 337.830 de caché. La pausa es `POST /api/jobs/<id>/pause` en la API de Hermes de la VM, y se reanuda con `/resume`. La pausa sobrevive a la sync del asistente. Al encender, `orqa.synced` llegó sin web 5 minutos después del reinicio.

Parar solo el canal con el proveedor: deja `STOCK_SUPPLIER_CHANNEL` vacío. Enviar y esperar responden 503, y el resto sigue. Con `telegram`, eso basta: el bot deja de leerse y de escribir. Para cortarlo del todo, el owner revoca el token en @BotFather (`/revoke`).

## Topes

Viven en `src/stock/usage.ts`, y el servidor es la barrera.

| Métrica | Tope diario | Al exceder |
|---|---|---|
| `sam_llamadas` | 60 | `take_photo` da `tope_diario`, sin foto ni orden al robot. Stock usa `kanban_block` y lo reporta |
| `extraccion` | 20 | `document_extract` da `tope_diario`, y el documento queda `registrado` para reintentar mañana |
| `despertares_ale` | 8 | `wake` responde `tope`. Queda el tick de 3 h |
| `avisos_voz` | 3 | Se agrupa; el resumen va por canal |
| `tarjetas_stock` | 12 | `tarjeta.permitida:false`, sin clave. Ale no crea nada y espera al día siguiente |
| `tokens_ale` | 2.200.000 | No corta el turno en curso. `wake` responde `tope` hasta el día siguiente |

Por unidad: `mensajes_proveedor` 12 por pedido, y al pasarse el pedido queda `cancelado`. `fotos_por_conteo` 3: foto original más 2 reintentos, y una foto nueva con la misma etiqueta en 60 minutos cuenta como el mismo conteo (`tope_fotos_conteo`).

**Corridas de banco.** Los turnos del dueño por el canal robot cuentan en `tokens_ale`. En IVB-027, una corrida sin `presupuestos.tokens_ale` llegó a 5,7 M. Con el tope gastado, `wake` responde `tope` y la respuesta del proveedor no despierta a Ale: la negociación espera al tick de 3 horas. Fija `tokens_ale` en la semilla según los turnos que vas a correr.

**Cerrar una corrida.** Desde IVB-023 (pendiente de despliegue) hay orden de dispositivo: `{"op":"bench_close","run_id":"<corrida>"}` por `POST /devices/me/stream`. Pasa a `cerrado`, nada se borra, el reloj del negocio vuelve a la hora real con su salto registrado (el desfase es por negocio, no por corrida) y repetir da `CONFLICT`. Mientras no esté desplegada, se cierra por la base como sigue. Solo puede haber una `activa` por negocio (`stock_runs_active_uq`), y mientras viva, las herramientas Stock del negocio ven solo los datos de esa corrida. Al terminar, ciérrala con una sola fila, en transacción, verificando que afecte exactamente esa:

```sql
BEGIN;
UPDATE assistant.stock_runs SET status = 'cerrado' WHERE id = '<run_id>' AND business_id = '<negocio>' AND status = 'activo' RETURNING id;  -- 1 fila, si no ROLLBACK
COMMIT;
```

Los datos de la corrida quedan, marcados con su `run_id` y `simulado`, y dejan de verse. Por la base, el desfase del reloj queda puesto: si la corrida movió `bench_clock`, pon `offset_seconds = 0` en `assistant.stock_clock_offsets` en la misma transacción. `bench_state` de esa corrida pasa a responder 409. Así se cerró `86985e74` en IVB-028.

**Tras reiniciar el pod.** El canal robot responde 409 `ASSISTANT_NOT_READY` durante el primer minuto y medio. Espera 2 minutos antes de probarlo.

**Fotos.** Un `photo_id` que no existe en el negocio responde `fallida` con `foto_desconocida`, sin orden al robot. Antes daba 404, que el MCP mostraba como «negocio no encontrado».

**Reloj.** Sin corrida, el contador es por día real en la zona del asistente del negocio, y sale del reloj real. Con `run_id` activo y `STOCK_BENCH_ENABLED`, cuenta `stock_run_budgets`, definido en `bench_seed.semilla.presupuestos`. Si la semilla no trae una métrica, la corrida hereda el tope diario como total. Un salto de reloj no reinicia ninguno de los dos. `bench_state` devuelve `presupuestos` con lo gastado.

Mirar lo gastado hoy:

```sql
SELECT metric, value FROM assistant.stock_usage WHERE business_id = '<negocio>' AND day = current_date;
```

**Límite honesto de `tarjetas_stock`.** Las tarjetas nacen en la VM y el servidor no puede impedir un `kanban_create`. Lo que hace es entregar la clave y gastar el cupo con `saleads_stock_get_overview` y `tarjeta`, y el prompt y las skills obligan a usarla. Un modelo que la ignore crearía la tarjeta; la clave idempotente de Hermes sigue evitando el doble tick solo si la usa.

## Coexistencia con 2 workers

`max_in_progress` sigue en 2, y no se sube. La skill de Ale pide máximo 1 tarjeta Stock en curso por negocio, también las de negociación, pero **el tablero no lo impone**: en dev (IVB-028) hubo 2 en curso del mismo negocio, por ejemplo negociación y foto, sin daño. La cola de pedidos sí es una sola en el servidor (R30). Una tarjeta bloqueada no cuenta: `kanban_block` libera su worker, comprobado en dev con 5 bloqueadas y trabajo nuevo despachado al instante.

Medido en dev, VM de 2 vCPU y 3,9 GB: gateway en reposo, 626 MB; cada worker `-p stock`, de 275 a 330 MB. Pico con 2 workers Stock, 1,77 GB usados. El curador corre de 26 a 76 s tras cada tarjeta. Stock espera como mucho 240 s por llamada y hasta 15 minutos por proveedor antes de bloquear. Si hay contención, baja la frecuencia de Stock antes de tocar capacidad.

## Consumo

Medido en T0 (S-30), en tokens de entrada por turno de Ale: 44.000 a 136.000, y hasta 503.000 cuando usó terminal. El peor día posible sin terminal son 16 turnos a 136.000, es decir 2.176.000. Por eso el presupuesto es 2.200.000. Con terminal en todos los turnos serían 8 millones: la skill limita la terminal a `notify-subscribe`.

| Dónde | Qué mide | Cómo |
|---|---|---|
| Turnos de chat | `input_tokens` de `run.completed` | Línea `chat turn` del log, y suma en `stock_usage.tokens_ale` para usuarios de Stock |
| Ticks y workers en la VM | Sesiones de Hermes | `python3 scripts/stock-consumo.py --horas 24` en la VM, solo lectura sobre `~/.hermes/state.db` |
| Corridas de banco | Presupuesto `tokens_ale` | `bench_state.presupuestos` |

`tokens_ale` no ve ticks ni workers: corren en la VM. El script sí, y clasifica cada sesión en `ok` (hasta 136.000), `alto` (hasta 503.000) y `fuera`. Falta remedir S-30 con las 15 herramientas reales en IVB-028.

## Retener

| Dato | Plazo | Mecanismo |
|---|---|---|
| Fotos y documentos en bucket | 30 días | Ciclo de vida del bucket |
| Máscaras y fotos en la Pi | 7 días | `limpiar` de `robot/ojo/ojo.py` |
| `stock_owner_utterances` | 7 días, solo las no citadas por `stock_confirmations` | `StockMaintenance`, diaria |
| URLs firmadas | Nunca se guardan | Código: en Postgres van objetos, no URLs |
| Movimientos, confirmaciones, auditoría | Sin borrar | R3, y `REVOKE` en V19 |

`StockMaintenance` corre cada hora dentro del pod, y apaga limpio con el servicio. Vence negociaciones en cada pasada, y retiene al arrancar y luego una vez al día. Dos pods no se estorban: ambas cosas son idempotentes. Usa el reloj de la base, así que un salto de banco no borra nada antes de tiempo.

**Bucket.** `saleads-dev-meta-assistant-stock-photos`, privado, en `STOCK_BUCKET`. Se crea en IVB-021 y se verifica en IVB-028. Regla de ciclo de vida, en `lifecycle.json`:

```json
{
  "rule": [
    {"action": {"type": "Delete"}, "condition": {"age": 30}}
  ]
}
```

```sh
gcloud storage buckets update gs://saleads-dev-meta-assistant-stock-photos --lifecycle-file=lifecycle.json
gcloud storage buckets describe gs://saleads-dev-meta-assistant-stock-photos --format='value(lifecycle_config)'
```

Pasados 30 días, `trace` sigue llegando al registro de la foto o del documento y a su nombre de objeto, no a la imagen. Es aceptado: el registro no se borra.

## Negociaciones

Una negociación sin actividad por 72 horas expira: `state='expirada'`, pedido `cancelado`, aviso por plantilla y auditoría `negociacion_expirada`. Eso libera la única cola con el proveedor. Lo hace `Negotiation.sweep()`, que escribió IVB-019: corre con el poller, al abrir un pedido y en `StockMaintenance`. El plazo corre con el reloj del negocio.

El dueño cancela en pantalla con `POST .../stock/orders/:orderId/cancel`: solo en `negociando`, repetir no falla, y queda `sin_acuerdo` con auditoría `pedido_cancelado`. No le escribe al proveedor. Un mensaje en vuelo consta como enviado, pero no revive el pedido ni lo acuerda.

## Rastrear

`trace_id` nace en la tarjeta: `tarjeta.id` va en el cuerpo, y Stock arma la `idempotency_key` como `<tarjeta.id>-<n>`. El servidor adopta ese id solo si reservó esa tarjeta para ese negocio. En el bus, `solicitud_id` es el id de la foto y su traza en `stock_audit`.

Con corrida: `op:bench_state` con `movement_id` devuelve `trace` y `cadena`, en una consulta: confirmación, propuesta, foto o documento, tarjeta y frase. El catálogo MCP sigue en 15. Sin corrida, `traceMovement` de `src/stock/audit.ts` es la misma consulta.

## Rotar la llave

Este servicio lee `INTERNAL_API_TOKEN`, y sa-mcp-server lee el mismo valor en `MCP_META_ASSISTANT_INTERNAL_TOKEN`.

1. Genera el valor nuevo y actualiza ambos secretos.
2. Reinicia este servicio y luego el MCP. Entre los dos reinicios las llamadas de Stock fallan con 401: elige una ventana sin turnos.
3. Comprueba con una lectura de `saleads_stock_get_overview`.

`STOCK_USER_IDS` y `STOCK_BUSINESS_SEEDS` no llevan llaves. Las URLs firmadas vencen solas: 300 s de subida y 900 s de lectura.
