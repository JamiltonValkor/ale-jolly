# Herramientas de Stock v1

Entrada y salida de las 15 herramientas `saleads_stock_*` que sa-mcp-server expone, una ruta interna por herramienta, bajo `/internal/stock/businesses/:businessId`. Lista cerrada: entra tal cual en `routes.stock.ts` de IVB-005. Esquemas: `STOCK_TOOLS` en `src/contracts/stock-v1.ts`. Una prueba pasa cada ejemplo por su esquema.

Reglas comunes:

- Guard `InternalTokenGuard`. `x-internal-api-token` y `x-user-id` obligatorios. `x-business-id` debe coincidir con la ruta, o 404.
- Toda herramienta recibe además `business_id` UUID, validado por `guard.verify`. El MCP lo lleva a la ruta: no va en el cuerpo ni en la consulta. Los ejemplos de entrada lo omiten por eso.
- Esquema cerrado: un campo extra da 400. Ninguna recibe `user_id`, `to`, `phone` ni `destinatario`.
- En GET la entrada viaja en la consulta, salvo los ids de la ruta. En `confirm_count` el `proposal_id` va en la ruta.
- Decimal: cadena `^\d+(\.\d{1,2})?$`. `idempotency_key` cumple `^[A-Za-z0-9_-]{8,128}$`.
- Las rutas de lógica pendiente validan su entrada y responden 503 hasta su tarea. `supplier_send` y `supplier_wait` responden 503 mientras `STOCK_SUPPLIER_CHANNEL` esté vacío. Adaptadores: `banco` (simulado) y `telegram` (bot propio del servicio, destino fijo). Su contrato ya está congelado aquí. Las salidas de `supplier_send`, `supplier_wait` y `document_extract` las fija este documento, porque sus tareas solo daban la forma parcial.
- No existe ruta interna para aprobar plata. La columna Ale es convención, no barrera: el servidor no distingue a Ale de Stock (`architecture.md` §7.4).

## saleads_stock_get_overview

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /overview` | `saleads:read` | Sí | Sí | IVB-004. IVB-024: `avisos_pendientes` trae los avisos activos que aún no se dijeron en la corrida activa, calculados por el servidor (ver «Avisos pendientes» en `docs/stock-contract-v1.md`). Se dicen con `saleads_stock_robot_say` y su `alerta_id`. `avisos_canal` es opcional: `{mensaje, cantidad}` o `null`. Son los avisos que no se pudieron decir. Solo sale una vez, y Ale los lleva por su canal. `rotacion` es opcional: productos en `frenazo`, `lento` o `sin_pauta`, con `variante_id`, `producto`, `estado`, `base_semanal`, `actual_semanal` y `saldo`. `facturas_sin_procesar` es opcional: facturas del run vigente en `registrado` o `fallido`, con `document_id`, `estado`, `canal` y `recibido_en`, las más viejas primero y hasta 10. Ale les crea su tarjeta `factura` en el tick o al recibir un bloqueo |

Con `tarjeta` reserva una tarjeta Stock y responde `tarjeta`, `{permitida, nueva, clave, id}` o `{permitida:false, motivo:"tope_diario"}`. `order_id` va solo con `tarjeta:"negociar"`. `document_id` va solo con `tarjeta:"factura"`: la clave pasa a ser `stock:<negocio>:factura:<document_id>`, una por documento, y un documento ajeno da 404. La misma ventana de 3 horas devuelve la misma clave sin gastar otro cupo. Es aditivo: regenerar el MCP antes de sincronizar el complemento.

<!-- entrada: saleads_stock_get_overview -->
```json
{"tarjeta":"tick"}
```

<!-- salida: saleads_stock_get_overview -->
```json
{"resumen":{"unidades_esperadas":123,"diferencias_por_resolver":1,"propuestas_pendientes":3,"pedidos_en_curso":1,"ultimo_conteo_en":"2026-11-02T14:40:00Z","moneda":"COP","simulado":true},"items":[{"variante_id":"11111111-1111-4111-8111-111111111111","producto_id":"22222222-2222-4222-8222-222222222222","producto":"Shampoo Reparador","variante":"250 ml","oferta":{"id":"33333333-3333-4333-8333-333333333333","nombre":"Rutina Reparación"},"ultimo_conteo":24,"entradas":36,"ventas_reportadas":18,"esperado":42,"contado":39,"contado_en":"2026-11-03T14:40:00Z","diferencia":-3,"estado":"causa_preguntada","propuesta_id":"44444444-4444-4444-8444-444444444444","simulado":true}],"kits":[{"id":"55555555-5555-4555-8555-555555555555","nombre":"Kit Reparación","estado":"activo","componentes":[{"variante_id":"11111111-1111-4111-8111-111111111111","nombre":"Shampoo 250 ml","cantidad":1}],"alcanzan":15,"simulado":true}],"avisos_pendientes":[{"alerta_id":"5a1f0c3e-9b2d-5c4e-8f6a-7b8c9d0e1f2a","tipo":"frenazo","variante_id":"11111111-1111-4111-8111-111111111111","producto_id":"22222222-2222-4222-8222-222222222222","producto":"Shampoo Reparador 250 ml","estado_desde":"2026-10-29T04:45:11.000Z","siguiente":"marketing","texto":"Shampoo Reparador 250 ml vendía 2 por semana y lleva 8 días sin ventas. Quedan 24. ¿Se lo paso a marketing para que lo mueva? Datos simulados.","pregunta":true,"simulado":true,"cifras":{"saldo":24,"base_semanal":2,"actual_semanal":0,"dias_sin_venta":8,"cobertura_dias":null,"punto_pedido_dias":null,"ritmo_actual_semana":0,"dias_cobertura_al_ritmo_actual":null}}]}
```

## saleads_stock_get_item

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /items/:variantId` | `saleads:read` | Sí | Sí | IVB-004 |

<!-- entrada: saleads_stock_get_item -->
```json
{"variante_id":"11111111-1111-4111-8111-111111111111"}
```

<!-- salida: saleads_stock_get_item -->
```json
{"item":{"variante_id":"11111111-1111-4111-8111-111111111111","producto_id":"22222222-2222-4222-8222-222222222222","producto":"Shampoo Reparador","variante":"250 ml","oferta":{"id":"33333333-3333-4333-8333-333333333333","nombre":"Rutina Reparación"},"ultimo_conteo":24,"entradas":36,"ventas_reportadas":18,"esperado":42,"contado":39,"contado_en":"2026-11-02T14:40:00Z","diferencia":-3,"estado":"causa_preguntada","propuesta_id":"44444444-4444-4444-8444-444444444444","simulado":true},"saldo":42,"ultimo_conteo_en":"2026-11-02T14:40:00Z","costo_unitario":"17000.00","moneda":"COP","unidades_por_caja":12}
```

## saleads_stock_list_proposals

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /proposals` | `saleads:read` | Sí | Sí | IVB-004 |

Misma forma que la web (`docs/stock-contract-v1.md`), salvo la foto: por aquí `foto_url` y `foto_expira_en` siempre van nulas, también en `saleads_stock_propose` y `saleads_stock_confirm_count`. La imagen se pide con `saleads_stock_get_photo`. En `kit`, `hipotesis`, `diagnostico`, `precio_fuente` y `fuentes` son texto no confiable que escribió el propio agente.

<!-- entrada: saleads_stock_list_proposals -->
```json
{"status":"pendiente","limit":20}
```

<!-- salida: saleads_stock_list_proposals -->
```json
{"propuestas":[{"id":"44444444-4444-4444-8444-444444444444","tipo":"conteo","titulo":"Conteo de Shampoo Reparador 250 ml","motivo":"Se contaron 39 y el libro espera 42.","creada_en":"2026-11-02T14:40:00Z","estado":"pendiente","simulado":false,"revision":1,"vence_en":"2026-11-03T14:40:00Z","efectos_si":["Se registra el conteo y, si hay diferencia, un ajuste con su causa."],"efectos_no":["El stock no cambia."],"detalle":{"producto":"Shampoo Reparador 250 ml","esperado":42,"contado":39,"diferencia":-3,"causa_requerida":true,"causa_opciones":["venta","fiado","movimiento","otra"],"origen":"foto","foto_estado":"disponible","foto_url":null,"foto_expira_en":null,"foto_tomada_en":"2026-11-01T14:40:00Z","total_objetos":39,"variante_dudosa":null,"conteo_en":"2026-10-28T14:40:00Z"}}]}
```

## saleads_stock_propose

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /proposals` | `saleads:strategy` | Sí | Sí | IVB-004 y IVB-015 |

Si el nivel efectivo del área es 1, responde 200 con `{"estado":"bloqueado","bloqueo":{"codigo":"nivel_autonomia","area":"inventario","nivel_efectivo":1,"texto":"..."}}` y no crea propuesta. Áreas: `conteo`, `entrada`, `venta`, `catalogo` y `union_catalogo` son `inventario`; `pedido`, `reposicion`; `kit` y `apuesta`, `ofertas`; `autonomia`, la de su `detalle`.

<!-- entrada: saleads_stock_propose -->
```json
{"idempotency_key":"stock-20261101-abcd","kind":"conteo","detalle":{"variante_id":"11111111-1111-4111-8111-111111111111","contado":39,"origen":"foto","photo_id":"88888888-8888-4888-8888-888888888888"}}
```

<!-- salida: saleads_stock_propose -->
```json
{"estado":"creada","propuesta":{"id":"44444444-4444-4444-8444-444444444444","tipo":"conteo","titulo":"Conteo de Shampoo Reparador 250 ml","motivo":"Se contaron 39 y el libro espera 42.","creada_en":"2026-10-28T14:40:00Z","estado":"pendiente","simulado":false,"revision":1,"vence_en":"2026-10-30T14:40:00Z","efectos_si":["Se registra el conteo y, si hay diferencia, un ajuste con su causa."],"efectos_no":["El stock no cambia."],"detalle":{"producto":"Shampoo Reparador 250 ml","esperado":42,"contado":39,"diferencia":-3,"causa_requerida":true,"causa_opciones":["venta","fiado","movimiento","otra"],"origen":"foto","foto_estado":"disponible","foto_url":null,"foto_expira_en":null,"foto_tomada_en":"2026-11-03T14:40:00Z","total_objetos":39,"variante_dudosa":null,"conteo_en":"2026-10-28T14:40:00Z"}},"enlace":null}
```

R15: si otro conteo vivo de otra variante del mismo producto usa los mismos objetos de la misma imagen, no se reparte. La respuesta es `{"estado":"variante_por_confirmar","propuesta":{...},"enlace":...,"pregunta":{"codigo":"variante","texto":"Conté 10 de Shampoo y no distingo Reparador o Hidratante. ¿Cuántos hay de cada una?","opciones":[{"variante_id":"...","nombre":"Reparador"},{"variante_id":"...","nombre":"Hidratante"}]}}`: una sola propuesta `conteo` por producto, con `variante_dudosa` llena, y el conteo anterior pasa a `vencida`. Si la otra variante ya se aprobó desde esa foto, `{"estado":"pregunta","pregunta":{"codigo":"variante","texto":"..."}}` sin propuesta. Qué cuenta como evidencia de la variante: `docs/stock-contract-v1.md`, «Variante por confirmar (R15)».

## saleads_stock_confirm_count

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /proposals/:id/confirm-count` | `saleads:strategy` | No | Sí | IVB-004 |

Con `variante_dudosa` (R15), `reparto` es obligatorio: `[{"variante_id","contado","causa"?}]`, entre las opciones y con la suma de `contado`. La frase del dueño (voz) o la cita (canal) debe nombrar cada variante y cada cantidad: un «sí» no basta y da `CONFLICT`. En otro conteo, `reparto` da `INVALID_REQUEST`.

<!-- entrada: saleads_stock_confirm_count -->
```json
{"revision":1,"metodo":"canal","causa":"venta","cita":"sí, fueron tres","canal":"whatsapp","session_id":"sesion-1"}
```

<!-- salida: saleads_stock_confirm_count -->
```json
{"id":"44444444-4444-4444-8444-444444444444","tipo":"conteo","titulo":"Conteo de Shampoo Reparador 250 ml","motivo":"Se contaron 39 y el libro espera 42.","creada_en":"2026-10-28T14:40:00Z","estado":"aprobada","simulado":false,"revision":2,"vence_en":"2026-11-03T14:40:00Z","efectos_si":["Se registra el conteo y, si hay diferencia, un ajuste con su causa."],"efectos_no":["El stock no cambia."],"detalle":{"producto":"Shampoo Reparador 250 ml","esperado":42,"contado":39,"diferencia":-3,"causa_requerida":true,"causa_opciones":["venta","fiado","movimiento","otra"],"origen":"foto","foto_estado":"disponible","foto_url":null,"foto_expira_en":null,"foto_tomada_en":"2026-11-01T14:40:00Z","total_objetos":39,"variante_dudosa":null,"conteo_en":"2026-11-01T14:40:00Z"}}
```

## saleads_stock_list_suppliers

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /suppliers` | `saleads:read` | Sí | Sí | IVB-004 |

<!-- entrada: saleads_stock_list_suppliers -->
```json
{"variante_id":"11111111-1111-4111-8111-111111111111"}
```

<!-- salida: saleads_stock_list_suppliers -->
```json
{"proveedores":[{"id":"99999999-9999-4999-8999-999999999999","nombre":"Distribuidora Capilar","contacto":"Ventas","dias_entrega":5,"simulado":true,"cotizaciones":[{"variante_id":"11111111-1111-4111-8111-111111111111","precio":"17000.00","flete":"20000.00","minimo":24,"plazo_pago_dias":30,"garantia":"30 días","equivalencia":"equivalente","moneda":"COP"}]}]}
```

Con `variante_id`, la salida suma `reposicion`: `saldo`, `ritmo_vigente`, `ritmo_estable`, `moneda` y `opciones`, con `proveedor_id`, `nombre`, `costo_total`, `elegible`, `motivo_no`, `equivalencia`, `fecha_pedido`, `cobertura_dias`, `punto_pedido_dias` y `cantidad_sugerida`. Es aditivo: sin ese filtro no sale.

## saleads_stock_list_orders

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /orders` | `saleads:read` | Sí | Sí | IVB-004 |

<!-- entrada: saleads_stock_list_orders -->
```json
{"status":"negociando"}
```

<!-- salida: saleads_stock_list_orders -->
```json
{"pedidos":[{"id":"66666666-6666-4666-8666-666666666666","producto":"Shampoo 250 ml","cantidad":60,"proveedor":"Distribuidora Capilar","costo":"1155000.00","costo_tipo":"esperado","moneda":"COP","estado":"negociando","novedad":null,"pedido_cantidad":60,"recibido_cantidad":null,"ahorro_confirmado":null,"simulado":true}]}
```

## saleads_stock_get_bet_signal

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /bet-signal/:variantId` | `saleads:read` | Sí | Sí | IVB-016. Variante inexistente: 200 con `motivo_no:"sin_producto"`. Si el id es de un producto o de una oferta del mismo negocio y corrida (IVB-023), `motivo_no` es `id_de_producto` o `id_de_oferta` y suma `variantes` con `variante_id` y `nombre`, hasta 20. La compuerta de R19 no cambia: crear la apuesta con ese id sigue dando 409. `motivo_no` también puede ser `sin_stock`. `pauta.activa` es `desconocido` sin corrida, y `senales` nulo sin campaña simulada. `alcance_pauta` mide la apuesta vigente (R22) y `seguimiento` existe tras aprobarla (R21). IVB-024, aditivo: `pegando`, `ritmo_actual_semana`, `motivo_pegando` y `dias_cobertura_al_ritmo_actual`, con el criterio de `docs/stock-contract-v1.md` § «Señal pegando». Son datos: decide el agente |

<!-- entrada: saleads_stock_get_bet_signal -->
```json
{"variante_id":"11111111-1111-4111-8111-111111111111"}
```

<!-- salida: saleads_stock_get_bet_signal -->
```json
{"variante_id":"11111111-1111-4111-8111-111111111111","stock":{"saldo":42,"esperado":42,"ultimo_conteo_en":"2026-11-01T14:40:00Z"},"costo":{"unitario":"17000.00","moneda":"COP","fuente":"factura"},"ritmo":{"base_semanal":6.2,"actual_semanal":14,"estado":"sano"},"margen":{"dinero":"12000.00","pct":41},"cobertura_dias":10.5,"motivo_cobertura":null,"pauta":{"activa":true,"simulado":true,"presupuesto_diario":"50000.00","senales":{"gasto":0,"mensajes":0}},"alcance_pauta":{"apuesta_id":"44444444-4444-4444-8444-444444444444","estado":"no_alcanza","unidades_necesarias":60,"unidades_disponibles":42,"dias_alcanza":21,"unidades_semana_alcanzables":9.8,"presupuesto_diario_proporcional":"35000.00"},"seguimiento":{"desde":"2026-11-02T14:40:00Z","pauta":{"gasto":0,"mensajes":0,"simulado":true},"ventas_reportadas":{"unidades":14,"simulado":true},"salida_inventario":{"unidades":14,"simulado":true}},"se_puede_pautar":true,"motivo_no":null,"datos_simulados":["stock","ventas","pauta"],"pegando":true,"ritmo_actual_semana":31.5,"motivo_pegando":"Con la pauta vende a 31,5 por semana en los últimos 2 días: 1,5 veces o más de las 20 previstas por semana.","dias_cobertura_al_ritmo_actual":9.3}
```

## saleads_stock_take_photo

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /photos` | `saleads:strategy` | Sí | No | IVB-009; 503 hasta entonces |

<!-- entrada: saleads_stock_take_photo -->
```json
{"idempotency_key":"stock-20261101-abcd","concepto":"jar","etiqueta":"frascos"}
```

<!-- salida: saleads_stock_take_photo -->
```json
{"status":"ok","photo_id":"88888888-8888-4888-8888-888888888888","total":22,"objetos":[{"n":1,"caja":[10,20,110,220],"confianza":0.93}],"image_url":"https://storage.googleapis.com/saleads-dev-meta-assistant-stock-photos/numerada.png","image_expires_in":900,"fuente":"camara","simulado":false}
```

## saleads_stock_get_photo

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /photos/:id` | `saleads:read` | Sí | Sí | IVB-009; 503 hasta entonces |

<!-- entrada: saleads_stock_get_photo -->
```json
{"photo_id":"88888888-8888-4888-8888-888888888888"}
```

<!-- salida: saleads_stock_get_photo -->
```json
{"status":"pending","photo_id":"88888888-8888-4888-8888-888888888888"}
```

## saleads_stock_document_register

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /documents` | `saleads:strategy` | No | Sí | IVB-013. Sin `STOCK_BUCKET`, 503. `url` nula si el archivo ya está subido. `canal:"banco"` es el canal simulado: sin `STOCK_BENCH_ENABLED` da 403 |

<!-- entrada: saleads_stock_document_register -->
```json
{"idempotency_key":"stock-20261101-abcd","tipo":"factura","content_type":"application/pdf","tamano":120000,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canal":"whatsapp"}
```

<!-- salida: saleads_stock_document_register -->
```json
{"document_id":"77777777-7777-4777-8777-777777777777","url":"https://storage.googleapis.com/saleads-dev-meta-assistant-stock-photos/factura.pdf","content_type":"application/pdf","ya_existia":false}
```

## saleads_stock_document_extract

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /documents/:id/extract` | `saleads:strategy` | Sí | No | IVB-013. Sin bucket o sin `STOCK_EXTRACT_MODEL`, 503. Repetir devuelve lo guardado sin llamar al modelo |

Todo el texto de `extraccion` es dato no confiable, por eso `no_confiable` siempre va en `true`. `status` también puede ser `no_subido`, `tope_diario`, `revision_manual` con `motivo` (`fuera_de_esquema`, `paginas_incompletas`, `archivo_distinto`, `tipo_no_coincide`, `muy_grande`) o `fallida` con `motivo` (`meta_http_*`, `meta_no_responde`, `almacenamiento`, `en_curso`, `modelo_no_permitido`).

<!-- entrada: saleads_stock_document_extract -->
```json
{"document_id":"77777777-7777-4777-8777-777777777777"}
```

<!-- salida: saleads_stock_document_extract -->
```json
{"status":"ok","document_id":"77777777-7777-4777-8777-777777777777","no_confiable":true,"extraccion":{"proveedor":{"nombre":"Distribuidora Capilar","nit":"900"},"fecha":"2026-10-28","moneda":"COP","lineas":[{"linea_id":"11111111-1111-4111-8111-111111111111","descripcion":"Shampoo 250 ml","cantidad":36,"costo_unitario":"17000.00","total_linea":"612000.00"}],"total":"612000.00","dudas":[{"campo":"lineas[0].cantidad","motivo":"Borroso"}],"es_factura":true}}
```

## saleads_stock_supplier_send

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /supplier/send` | `saleads:strategy` | Sí | No | IVB-015. Sin canal, 503. Con `negociacion` en nivel 1, 403 |

No hay campo de destino: el adaptador lo toma de la configuración. `texto` no lleva cifras: usa `{oferta}`, `{precio_proveedor}` y `{cantidad}`, que llena el servidor. Motivos de `bloqueado`: `pedido_no_disponible`, `pedido_no_negociando`, `tope_mensajes`, `sobre_tope`, `cantidad_sobre_mandato`, `marcador_desconocido`, `cifra_fuera_de_marcador`, `dato_cliente`, `identidad_falsa`, `promesa_de_pago`, `compra_sin_cierre`, `falta_oferta`, `falta_cantidad`, `sin_precio_proveedor`, `cita_sobre_tope_sin_oferta`, `cierre_incompleto`, `cierre_sin_marcadores`, `cierre_con_otro_precio`, `sin_respuesta_proveedor`, `texto_largo`, y `ventana_cerrada: …`. `cierre:true` solo vale contestando un mensaje del proveedor, al último precio que dio o, si no dio cifra, a la oferta que contestó, con `{oferta}` y `{cantidad}` y sin otros dígitos. La misma `idempotency_key` no reenvía; con otro contenido da `CONFLICT`.

<!-- entrada: saleads_stock_supplier_send -->
```json
{"idempotency_key":"stock-20261101-abcd","order_id":"66666666-6666-4666-8666-666666666666","texto":"Podemos pagar {oferta} por unidad.","precio_unitario_ofrecido":"16000.00","cantidad":60,"cierre":false}
```

<!-- salida: saleads_stock_supplier_send -->
```json
{"status":"bloqueado","motivo":"sobre_tope"}
```

## saleads_stock_supplier_wait

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `GET /supplier/wait` | `saleads:read` | Sí | No | IVB-015. Sin canal, 503. Pedido ajeno, 404 |

Espera hasta `STOCK_TOOL_WAIT_MS`. `cursor` cuenta mensajes leídos: `after:0` trae todo el historial, y así retoma otra tarjeta. `no_confiable` marca lo que escribió el proveedor, y `trae_instruccion` lo que además parece una orden. Sale `mandato`, para que Stock lo lea del servidor. `precio_proveedor` es nulo si no hay dato o si el último mensaje trae dos montos distintos.

<!-- entrada: saleads_stock_supplier_wait -->
```json
{"order_id":"66666666-6666-4666-8666-666666666666","after":0}
```

<!-- salida: saleads_stock_supplier_wait -->
```json
{"status":"respuesta","cursor":3,"estado_negociacion":"esperando_stock","mensajes":[{"id":"11111111-1111-4111-8111-111111111111","direccion":"entrante","texto":"Lo dejo en 16500.","en":"2026-10-29T14:40:00Z","no_confiable":true,"trae_instruccion":false}],"mandato":{"precio_objetivo":"16000.00","tope":"17000.00","cantidad":60},"moneda":"COP","rondas":1,"rondas_max":12,"precio_proveedor":"16500.00"}
```

## saleads_stock_robot_say

| Ruta | Scope | Perfil Stock | Ale | Lógica |
|---|---|---|---|---|
| `POST /robot/say` | `saleads:strategy` | No | Sí | Máximo 240 caracteres: más da 400 `STOCK_TEXT_TOO_LONG`. `proposal_id` o `producto_id` ajenos dan 404. IVB-024 (F-R2b): con una corrida activa, un `producto_id` o `proposal_id` de otra corrida, o real, da 400 `STOCK_OTHER_RUN`, y la deduplicación por `dedupe_key` y día es por corrida. Un duplicado responde `ya_dicho` con `evento_original` (`id`, `estado`, `creado_en`) y no crea evento: solo `dicho` afirma que Jolly lo dijo. Con `alerta_id` (de `avisos_pendientes`) va solo ese campo y `prioridad` opcional: el texto lo arma el servidor; un aviso ya dicho responde `ya_dicho` y uno que ya no está activo `no_vigente`, sin hablar. Sin `alerta_id`, un texto `AVISO:` o una clave `alerta…`/`stock-alerta…` da 400 `STOCK_ALERT_ID_REQUIRED`. Con propuesta `autonomia` se ignora `texto`: habla la plantilla |

<!-- entrada: saleads_stock_robot_say -->
```json
{"texto":"¿Qué pasó con los 3 que faltan?","pregunta":true,"proposal_id":"44444444-4444-4444-8444-444444444444","producto_id":null,"prioridad":"normal","dedupe_key":"causa-conteo-1"}
```

<!-- salida: saleads_stock_robot_say -->
```json
{"status":"ya_dicho","evento_original":{"id":"1842","estado":"en_cola","creado_en":"2026-11-02T14:16:38.000Z"}}
```

## `detalle` de `saleads_stock_propose`

`enlace` lo arma el servidor con `STOCK_WEB_BASE_URL` y el idioma del asistente: `{base}/{idioma}/dashboard/meta-assistant?tab=stock&vista=por-aprobar&negocio=<id>&propuesta=<id>`. Sin `STOCK_WEB_BASE_URL` es `null`. Se entrega tal cual.

El servidor calcula todo lo demás. Título, motivo, efectos, vencimiento, márgenes, evidencia y cifras de costo nunca se reciben: enviarlos da 400. Con `cajas` y sin `units_per_box`, la respuesta es `{"estado":"pregunta","pregunta":{"codigo":"unidades_por_caja","texto":"..."}}`, sin propuesta (R16).

### `conteo`

Con `order_id`, el pedido debe estar `acordado` y ser del mismo producto: si no, `CONFLICT` o `INVALID_REQUEST`. `contado` es todo el estante. `esperado` suma lo que trae el pedido, y `received_qty` guarda solo lo que llegó. El libro no se mueve hasta aprobar la `entrada`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `variante_id` | uuid | No | Sí |
| `contado` | entero | No | Sí |
| `origen` | `foto`, `voz`, `canal` | No | Sí |
| `photo_id` | uuid | No | No |
| `order_id` | uuid | No | No |
| `cajas` | entero | No | No |

### `entrada`

Con `order_id`, el pedido debe estar `acordado`, ya contado, y la factura debe traer su producto: sin conteo, `CONFLICT`. Aprobarla, solo en pantalla, pasa el pedido a `recibido`, cuadra el libro contra el conteo y escribe `saving_confirmed`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `document_id` | uuid | No | Sí |
| `order_id` | uuid | No | No |
| `lineas` | lista de objeto | No | Sí |
| `lineas[].linea_id` | uuid | No | Sí |
| `lineas[].variante_id` | uuid | Sí | Sí |

### `venta`

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `variante_id` | uuid | No | Sí |
| `cantidad` | entero | No | Sí |
| `nota` | cadena | No | No |

### `catalogo`

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `variantes` | lista de objeto | No | Sí |
| `variantes[].nombre` | cadena | No | Sí |
| `variantes[].unidades_por_caja` | entero | No | No |
| `oferta` | objeto | No | Sí |
| `oferta.type` | `product`, `service` | No | Sí |
| `oferta.id` | cadena | No | Sí |

### `union_catalogo`

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `origen_id` | uuid | No | Sí |
| `destino_id` | uuid | No | Sí |

### `pedido`

`precio_objetivo` no puede superar `tope`. Un proveedor sin cotización da 404, y uno no elegible (`minimo` mayor que `cantidad`, sin plazo de entrega u otra moneda) da `CONFLICT`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `variante_id` | uuid | No | Sí |
| `proveedor_id` | uuid | No | Sí |
| `cantidad` | entero | No | Sí |
| `mandato` | objeto | No | Sí |
| `mandato.precio_objetivo` | decimal en cadena | No | Sí |
| `mandato.tope` | decimal en cadena | No | Sí |

### `kit`

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `subtipo` | `kit`, `complemento`, `venta_adicional` | No | Sí |
| `componentes` | lista de objeto | No | Sí |
| `componentes[].variante_id` | uuid | No | Sí |
| `componentes[].cantidad` | entero | No | Sí |
| `precio_propuesto` | decimal en cadena | No | No |
| `precio_fuente` | cadena | No | No |
| `diagnostico` | cadena | No | Sí |
| `fuentes` | lista de objeto | No | Sí |
| `fuentes[].url` | URL; solo se guardan `http` y `https` sin credenciales, las demás se descartan | No | Sí |
| `fuentes[].fecha` | cadena | No | Sí |
| `hipotesis` | cadena | No | Sí |

### `apuesta`

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `variante_id` | uuid | No | Sí |
| `presupuesto_diario` | decimal en cadena | No | Sí |
| `tope` | decimal en cadena | No | Sí |
| `duracion_dias` | entero | No | Sí |
| `unidades_semana_previstas` | número | Sí | Sí |
| `fuente_prevision` | `dato`, `supuesto` | No | Sí |

### `autonomia`

Pide subir un peldaño. `nivel_pedido` debe ser el nivel guardado más uno y `monto_tope` mayor a 0: si no, `INVALID_REQUEST`. Exige un pedido recibido sin diferencia y ahorro confirmado mayor a 0, calculados por el servidor: si no, 409 `CONFLICT`. Enviar `evidencia` da 400. La misma solicitud en 7 días, o una ya aprobada y vigente, devuelve la propuesta existente sin crear otra. Al crearla, el servidor deja el aviso de voz con plantilla.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `area` | `inventario`, `reposicion`, `negociacion`, `ofertas` | No | Sí |
| `nivel_pedido` | entero | No | Sí |
| `monto_tope` | decimal en cadena | No | Sí |

