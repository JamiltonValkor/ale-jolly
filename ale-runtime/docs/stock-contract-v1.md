# Contrato web de Stock v1

Fuente única del contrato entre `ale-runtime` y `sa-domain-client`. Esquemas: `src/contracts/stock-v1.ts`. Si difieren, gana el código y se corrige este documento. Una prueba (`test/stock-http.spec.ts`) pasa cada ejemplo por su esquema. Las fixtures del front copian estos ejemplos.

Congelado en IVB-004. Los esquemas del front son `.strict()`, así que un campo nuevo tira la lista a 503: todo cambio va con nota en `progress.md` y ajuste en `front/`.

Cambios frente a `back/tasks/004`:

- `conteo.detalle` suma `causa_opciones`: la pregunta de R6 viaja en la lectura. Vacía si `causa_requerida=false`.
- `apuesta.detalle.senal` se queda en `{saldo, esperado}`: el front es estricto. La señal completa va por `saleads_stock_get_bet_signal`, y el motivo dice si el stock no alcanza.
- Después de congelar (2-nov-2026, aditivo): `kit.detalle` suma `diagnostico`, `precio_fuente` y `fuentes`; `conteo.detalle.foto_url` sale firmada en la web; las tablas marcan como nulables `foto_url`, `variante_dudosa`, `entrada.proveedor`, `margen_dinero`, `margen_pct` y `unidades_semana_previstas`, como ya eran en el código. `test/stock-contract-doc.spec.ts` compara cada tabla con su esquema.
- R15 (2-nov-2026, aditivo, IVB-023): `StockApproveRequestV1` suma `reparto`, opcional. La forma de la propuesta no cambia: un conteo con variante por confirmar sale como `conteo` con `variante_dudosa` llena. Ver «Variante por confirmar (R15)».
- «Pegando» (2-nov-2026, aditivo, IVB-024): la señal de pauta suma `pegando`, `ritmo_actual_semana`, `motivo_pegando` y `dias_cobertura_al_ritmo_actual`. No toca el front: viaja solo por `saleads_stock_get_bet_signal`. Ver «Señal pegando».
- Recepción sin `order_id` (2-nov-2026, IVB-024, P8): un conteo sin `order_id` que sube sobre el saldo, con un único pedido `acordado` de la variante en la corrida, se liga a ese pedido. El motivo lo dice («Se ligó al pedido acordado de este producto»), y como lleva pedido, solo se confirma en pantalla. Con dos o más pedidos acordados, o sin subir sobre el saldo, no se liga. La forma de la propuesta no cambia.
- Al crear una propuesta `catalogo`, `oferta` es obligatoria, porque V19 exige oferta en todo producto que no sea kit. `catalogo.detalle.oferta` conserva el nulable y suma `type`.

## Rutas

| Método | Ruta en servicio | Uso |
|---|---|---|
| GET | `/assistants/me/stock/status` | `{enabled, business_ids}`; 404 = apagado |
| GET | `/assistants/me/businesses/:id/stock/summary` | Resumen |
| GET | `.../stock/items` | Stock actual y kits |
| GET | `.../stock/proposals?status=pendiente` | Por aprobar |
| POST | `.../stock/proposals/:pid/approve` | `If-Match`, `Idempotency-Key` |
| POST | `.../stock/proposals/:pid/reject` | `If-Match`, `Idempotency-Key` |
| GET | `.../stock/orders` | Pedidos |
| POST | `.../stock/orders/:oid/cancel` | Solo en `negociando`, sin cuerpo. Devuelve el pedido. Repetir no falla; `acordado` o `recibido` dan `CONFLICT`. No le avisa al proveedor |
| GET | `.../stock/autonomy` | Niveles por área |
| POST | `.../stock/autonomy/:area/level` | El dueño baja de nivel, o regresa de 1 a 2. `If-Match`, `Idempotency-Key` |

Las rutas por negocio llevan `AuthGuard` y `AssistantFlagGuard`. `If-Match: "<revision>"` lleva comillas y sale del cuerpo de la propuesta. `Idempotency-Key` cumple `^[A-Za-z0-9_-]{8,128}$`. Todas responden `Cache-Control: no-store`. Dinero en cadena decimal, `margen_pct` como número de 0 a 100, días y unidades como enteros. Una lectura sin datos da listas vacías.

## Errores

Cuerpo `{code, request_id}` con UUID.

| Código | Estado | Cuándo |
|---|---|---|
| `INVALID_REQUEST` | 400 | Cuerpo inválido, campo extra, encabezados faltantes, falta `causa`, falta o sobra `reparto`, reparto que no suma el total |
| `UNAUTHORIZED` | 401 | Sin sesión |
| `FORBIDDEN` | 403 | `confirm-count` sobre un tipo distinto de `conteo` |
| `ASSISTANT_NOT_ENABLED`, `FLAG_UNAVAILABLE` | 403, 503 | `AssistantFlagGuard`, solo en rutas por negocio |
| `NOT_FOUND` | 404 | Ajeno, inexistente, usuario no habilitado o bandera apagada |
| `CONFLICT` | 409 | Resuelta, vencida, revisión vieja, misma clave con otro hash, conteo superado, apuesta sin stock |
| `STOCK_NEGATIVE` | 409 | Saldo insuficiente |
| `SERVICE_UNAVAILABLE` | 503 | Propiedad no determinable, dependencia caída o lógica pendiente de su tarea |

## Respuestas y cuerpos

### StockStatusV1

`GET /assistants/me/stock/status`. Lleva solo `AuthGuard`. Con `STOCK_ENABLED=true` y usuario no habilitado: 200 `{"enabled":false,"business_ids":[]}`. Con la bandera apagada la ruta no existe: 404 `{code:"NOT_FOUND",request_id}`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `enabled` | booleano | No | Sí |
| `business_ids` | lista de uuid | No | Sí |

<!-- ejemplo: StockStatusV1 -->
```json
{
  "enabled": true,
  "business_ids": [
    "7e88bd4a-0000-4000-8000-000000000000"
  ]
}
```

### StockSummaryV1

`GET .../stock/summary`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `unidades_esperadas` | entero | No | Sí |
| `diferencias_por_resolver` | entero | No | Sí |
| `propuestas_pendientes` | entero | No | Sí |
| `pedidos_en_curso` | entero | No | Sí |
| `ultimo_conteo_en` | ISO-8601 | Sí | Sí |
| `moneda` | cadena | No | Sí |
| `simulado` | booleano | No | Sí |

<!-- ejemplo: StockSummaryV1 -->
```json
{
  "unidades_esperadas": 123,
  "diferencias_por_resolver": 1,
  "propuestas_pendientes": 3,
  "pedidos_en_curso": 1,
  "ultimo_conteo_en": "2026-11-03T14:40:00Z",
  "moneda": "COP",
  "simulado": true
}
```

### StockItemsV1

`GET .../stock/items`. Mientras falte causa, `estado=causa_preguntada` y `propuesta_id` no es nulo.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `items` | lista de objeto | No | Sí |
| `items[].variante_id` | uuid | No | Sí |
| `items[].producto_id` | uuid | No | Sí |
| `items[].producto` | cadena | No | Sí |
| `items[].variante` | cadena | No | Sí |
| `items[].oferta` | objeto | Sí | Sí |
| `items[].oferta.id` | cadena | No | Sí |
| `items[].oferta.nombre` | cadena | No | Sí |
| `items[].ultimo_conteo` | entero | Sí | Sí |
| `items[].entradas` | entero | No | Sí |
| `items[].ventas_reportadas` | entero | No | Sí |
| `items[].esperado` | entero | No | Sí |
| `items[].contado` | entero | Sí | Sí |
| `items[].contado_en` | ISO-8601 | Sí | Sí |
| `items[].diferencia` | entero | Sí | Sí |
| `items[].estado` | `cuadra`, `causa_preguntada`, `conteo_por_aprobar`, `sin_conteo_reciente` | No | Sí |
| `items[].propuesta_id` | uuid | Sí | Sí |
| `items[].simulado` | booleano | No | Sí |
| `kits` | lista de objeto | No | Sí |
| `kits[].id` | uuid | No | Sí |
| `kits[].nombre` | cadena | No | Sí |
| `kits[].estado` | cadena | No | Sí |
| `kits[].componentes` | lista de objeto | No | Sí |
| `kits[].componentes[].variante_id` | uuid | No | Sí |
| `kits[].componentes[].nombre` | cadena | No | Sí |
| `kits[].componentes[].cantidad` | entero | No | Sí |
| `kits[].alcanzan` | entero | No | Sí |
| `kits[].simulado` | booleano | No | Sí |

<!-- ejemplo: StockItemsV1 -->
```json
{
  "items": [
    {
      "variante_id": "11111111-1111-4111-8111-111111111111",
      "producto_id": "22222222-2222-4222-8222-222222222222",
      "producto": "Shampoo Reparador",
      "variante": "250 ml",
      "oferta": {
        "id": "33333333-3333-4333-8333-333333333333",
        "nombre": "Rutina Reparación"
      },
      "ultimo_conteo": 24,
      "entradas": 36,
      "ventas_reportadas": 18,
      "esperado": 42,
      "contado": 39,
      "contado_en": "2026-11-03T14:40:00Z",
      "diferencia": -3,
      "estado": "causa_preguntada",
      "propuesta_id": "44444444-4444-4444-8444-444444444444",
      "simulado": true
    }
  ],
  "kits": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "nombre": "Kit Reparación",
      "estado": "activo",
      "componentes": [
        {
          "variante_id": "11111111-1111-4111-8111-111111111111",
          "nombre": "Shampoo 250 ml",
          "cantidad": 1
        }
      ],
      "alcanzan": 15,
      "simulado": true
    }
  ]
}
```

### StockOrdersV1

`GET .../stock/orders`. `en_camino` no se emite en esta ola.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `pedidos` | lista de objeto | No | Sí |
| `pedidos[].id` | uuid | No | Sí |
| `pedidos[].producto` | cadena | No | Sí |
| `pedidos[].cantidad` | entero | No | Sí |
| `pedidos[].proveedor` | cadena | No | Sí |
| `pedidos[].costo` | decimal en cadena | Sí | Sí |
| `pedidos[].costo_tipo` | `esperado`, `acordado` | No | Sí |
| `pedidos[].moneda` | cadena | No | Sí |
| `pedidos[].estado` | `aprobado`, `negociando`, `acordado`, `en_camino`, `recibido`, `cancelado` | No | Sí |
| `pedidos[].novedad` | `respuesta_proveedor` | Sí | Sí |
| `pedidos[].pedido_cantidad` | entero | No | Sí |
| `pedidos[].recibido_cantidad` | entero | Sí | Sí |
| `pedidos[].ahorro_confirmado` | decimal en cadena | Sí | Sí |
| `pedidos[].simulado` | booleano | No | Sí |

<!-- ejemplo: StockOrdersV1 -->
```json
{
  "pedidos": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "producto": "Shampoo 250 ml",
      "cantidad": 60,
      "proveedor": "Distribuidora Capilar",
      "costo": "1155000.00",
      "costo_tipo": "esperado",
      "moneda": "COP",
      "estado": "negociando",
      "novedad": null,
      "pedido_cantidad": 60,
      "recibido_cantidad": null,
      "ahorro_confirmado": null,
      "simulado": true
    }
  ]
}
```

### StockAutonomyV1

`GET .../stock/autonomy`.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `areas` | lista de objeto | No | Sí |
| `areas[].area` | `inventario`, `reposicion`, `negociacion`, `ofertas` | No | Sí |
| `areas[].nivel` | entero | No | Sí |
| `areas[].nivel_efectivo` | entero | No | Sí |
| `areas[].revision` | entero | No | Sí |

<!-- ejemplo: StockAutonomyV1 -->
```json
{
  "areas": [
    {
      "area": "inventario",
      "nivel": 2,
      "nivel_efectivo": 2,
      "revision": 1
    },
    {
      "area": "reposicion",
      "nivel": 2,
      "nivel_efectivo": 2,
      "revision": 1
    },
    {
      "area": "negociacion",
      "nivel": 2,
      "nivel_efectivo": 2,
      "revision": 1
    },
    {
      "area": "ofertas",
      "nivel": 2,
      "nivel_efectivo": 2,
      "revision": 1
    }
  ]
}
```

### StockApproveRequestV1

Cuerpo de `POST .../proposals/:pid/approve`. `causa` es obligatoria solo con `causa_requerida=true`. `reparto` va solo, y siempre, en un conteo con `variante_dudosa` (R15).

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `motivo` | cadena | No | No |
| `causa` | `venta`, `fiado`, `movimiento`, `otra` | No | No |
| `reparto` | lista de objeto, de 1 a 20 | No | No |
| `reparto[].variante_id` | uuid | No | Sí |
| `reparto[].contado` | entero ≥ 0 | No | Sí |
| `reparto[].causa` | `venta`, `fiado`, `movimiento`, `otra` | No | No |

<!-- ejemplo: StockApproveRequestV1 -->
```json
{
  "causa": "venta",
  "motivo": "opcional"
}
```

### StockRejectRequestV1

Cuerpo de `POST .../proposals/:pid/reject`. Rechazar nunca exige causa.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `motivo` | cadena | No | No |

<!-- ejemplo: StockRejectRequestV1 -->
```json
{
  "motivo": "opcional"
}
```

### StockAutonomyLevelRequestV1

Cuerpo de `POST .../autonomy/:area/level`. Exige `If-Match` e `Idempotency-Key`: sin ellos, 400. Solo baja de nivel, con una excepción: un área en 1 puede regresar a 2. Cualquier otro `nivel` igual o mayor al actual da `INVALID_REQUEST`. Regresar no revive un permiso anterior. Revisión vieja o la misma clave con otro cuerpo, `CONFLICT`. Responde el área actualizada (`StockAutonomyV1.areas[]`). Bajar anula los permisos ya aprobados de esa área.

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `nivel` | entero | No | Sí |
| `motivo` | cadena | No | No |

<!-- ejemplo: StockAutonomyLevelRequestV1 -->
```json
{
  "nivel": 1,
  "motivo": "opcional"
}
```

## Propuesta

`GET .../stock/proposals` devuelve `{"propuestas":[...]}`. `POST approve` y `POST reject` devuelven la propuesta actualizada. Forma común, con `detalle` por `tipo`. `motivo`, `efectos_si` y `efectos_no` los arma el servidor, con al menos un efecto. Los textos de `detalle` tienen máximo 300 caracteres, sin saltos de línea: el front los muestra como dato.

### Propuesta `conteo`

La foto se firma al leer, nunca se guarda la URL. `GET .../stock/proposals`, `approve` y `reject` de la web devuelven en `foto_url` una URL GET firmada del bucket, `https` en `storage.googleapis.com`, que vence en 15 minutos (`foto_expira_en`). Vencida, el front vuelve a leer la lista y recibe otra. La ruta del objeto no sale como campo. Por MCP, `foto_url` y `foto_expira_en` van nulas: el modelo ve la imagen con `saleads_stock_get_photo`.

| Estado de la foto | `foto_estado` | `foto_url` |
|---|---|---|
| Vigente: lista, dentro de los 30 días del bucket y firmada | `disponible` | URL firmada (nula por MCP) |
| Vencida: pasó el ciclo de vida de 30 días, el objeto ya no existe | `no_disponible` | nula |
| Perdida: no quedó lista, no es del negocio, sin bucket o la firma falló | `no_disponible` | nula |
| Sin foto: conteo por voz o canal | `sin_foto` | nula |

Con `no_disponible` el front no deja aprobar (IVF-004). `foto_tomada_en` y `total_objetos` salen si la foto existe, aunque esté vencida o perdida.

#### Variante por confirmar (R15)

Si en una foto no se distingue la variante, Jolly pregunta. El servidor nunca reparte un total entre variantes, aunque lo pida el modelo (IVB-023: Stock propuso 5 y 5 entre reparador e hidratante desde una foto de botellas iguales).

**Cuándo se bloquea.** Llega un conteo con `photo_id` de la variante B y ya hay otro conteo vivo (pendiente sin vencer, o aprobado) de la variante A, del mismo producto, cuya foto **comparte objetos** con esta. Dos fotos comparten objetos si son de la misma imagen (la misma foto, o un reintento de R14 con `parent_photo_id`), ambas tienen al menos un objeto y además pasa una de estas cosas:

- es la misma foto;
- SAM buscó el mismo concepto, ignorando mayúsculas, tildes y plural (`bottle` y `bottles` son lo mismo);
- una caja de una se solapa con una caja de la otra (IoU ≥ 0,5): los dos conceptos encontraron las mismas botellas.

**Qué pasa.** Si el conteo de A sigue pendiente, A pasa a `vencida` (auditoría `reemplazada_r15`), su plantilla de voz se descarta y nace una sola propuesta `conteo` por producto: `producto` es el nombre del producto, `contado` es lo que Stock atribuyó al producto sin pasar de lo que vio SAM, `esperado` es la suma de las variantes, y `variante_dudosa` nombra las opciones («Reparador o Hidratante»). Jolly pregunta con un texto del servidor, sin reparto sugerido. Otro conteo desde esa imagen, o repetir la clave de A, devuelve la misma propuesta. Si A ya estaba aprobado, no nace nada: la respuesta es una pregunta con código `variante`.

**Qué cuenta como evidencia de la variante**, y por eso no se bloquea:

- SAM con un concepto por variante que separa objetos distintos sobre la misma imagen: conceptos distintos y ninguna caja compartida;
- fotos distintas: otra toma, otra repisa;
- la dueña lo dijo: conteo sin foto, con origen `voz` o `canal`;
- el reparto que da la dueña al confirmar la propuesta por producto.

**No cuenta:** lo que el modelo cree leer en la etiqueta con un solo concepto de SAM, que la suma cuadre con lo esperado, el orden de las propuestas, un conteo anterior ni repartir lo esperado en proporción.

**Confirmar.** El reparto es una lista `{variante_id, contado, causa?}` entre las opciones, sin repetir, que suma `contado`. Cada variante deja su conteo y, si difiere, su ajuste con su causa (la de la línea o la general), todo con una sola confirmación. Una variante fuera del reparto no se cuenta.

- En pantalla: `approve` con `reparto`. Sin él, `INVALID_REQUEST`. El front aún no lo envía (pendiente de front).
- Por voz o canal (`saleads_stock_confirm_count` con `reparto`): la frase del dueño, o la cita, debe nombrar cada variante del reparto y cada cantidad, en palabras o cifras, sin negaciones. Un «sí» a un reparto que dijo Jolly no confirma, porque ese reparto sería del modelo. Si no alcanza, `CONFLICT` y se confirma en pantalla.

**Límites.** Solo variantes de un mismo producto. Un conteo de una sola variante desde una foto sigue siendo interpretación de Stock (R12): el servidor no puede saber si había otra variante. Un conteo de recepción de pedido que cae en R15 pierde el `order_id`: el pedido se recibe con otro conteo por variante.

Campos comunes:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `id` | uuid | No | Sí |
| `titulo` | cadena | No | Sí |
| `motivo` | cadena | No | Sí |
| `creada_en` | ISO-8601 | No | Sí |
| `estado` | `pendiente`, `aprobada`, `rechazada`, `vencida` | No | Sí |
| `simulado` | booleano | No | Sí |
| `revision` | entero | No | Sí |
| `vence_en` | ISO-8601 | No | Sí |
| `efectos_si` | lista de cadena | No | Sí |
| `efectos_no` | lista de cadena | No | Sí |
| `tipo` | `conteo` | No | Sí |

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `esperado` | entero | No | Sí |
| `contado` | entero | No | Sí |
| `diferencia` | entero | No | Sí |
| `causa_requerida` | booleano | No | Sí |
| `causa_opciones` | lista de `venta`, `fiado`, `movimiento`, `otra` | No | Sí |
| `origen` | `foto`, `voz`, `canal` | No | Sí |
| `foto_estado` | `sin_foto`, `disponible`, `no_disponible` | No | Sí |
| `foto_url` | URL firmada `https` | Sí | Sí |
| `foto_expira_en` | ISO-8601 | Sí | Sí |
| `foto_tomada_en` | ISO-8601 | Sí | Sí |
| `total_objetos` | entero | Sí | Sí |
| `variante_dudosa` | cadena | Sí | Sí |
| `conteo_en` | ISO-8601 | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "conteo",
  "titulo": "Conteo de Shampoo Reparador 250 ml",
  "motivo": "Se contaron 39 y el libro espera 42.",
  "creada_en": "2026-10-29T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-28T14:40:00Z",
  "efectos_si": [
    "Se registra el conteo y, si hay diferencia, un ajuste con su causa."
  ],
  "efectos_no": [
    "El stock no cambia."
  ],
  "detalle": {
    "producto": "Shampoo Reparador 250 ml",
    "esperado": 42,
    "contado": 39,
    "diferencia": -3,
    "causa_requerida": true,
    "causa_opciones": [
      "venta",
      "fiado",
      "movimiento",
      "otra"
    ],
    "origen": "foto",
    "foto_estado": "disponible",
    "foto_url": "https://storage.googleapis.com/saleads-dev-meta-assistant-stock-photos/numerada.png",
    "foto_expira_en": "2026-11-03T14:55:00Z",
    "foto_tomada_en": "2026-11-03T14:40:00Z",
    "total_objetos": 39,
    "variante_dudosa": null,
    "conteo_en": "2026-10-29T14:40:00Z"
  }
}
```

### Propuesta `entrada`

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `lineas` | lista de objeto | No | Sí |
| `lineas[].descripcion` | cadena | No | Sí |
| `lineas[].cantidad` | entero | No | Sí |
| `lineas[].costo_unitario` | decimal en cadena | No | Sí |
| `lineas[].dudoso` | lista de cadena | No | Sí |
| `proveedor` | cadena | Sí | Sí |
| `documento_id` | uuid | No | Sí |
| `moneda` | cadena | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "entrada",
  "titulo": "Entrada de mercancía",
  "motivo": "Factura con 1 líneas por confirmar.",
  "creada_en": "2026-10-31T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-30T14:40:00Z",
  "efectos_si": [
    "Entran las unidades y queda registrado el costo."
  ],
  "efectos_no": [
    "Ni el stock ni el costo cambian."
  ],
  "detalle": {
    "lineas": [
      {
        "descripcion": "Shampoo 250 ml",
        "cantidad": 36,
        "costo_unitario": "17000.00",
        "dudoso": [
          "cantidad"
        ]
      }
    ],
    "proveedor": "Distribuidora Capilar",
    "documento_id": "77777777-7777-4777-8777-777777777777",
    "moneda": "COP"
  }
}
```

### Propuesta `venta`

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `cantidad` | entero | No | Sí |
| `kit_id` | uuid | Sí | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "venta",
  "titulo": "Venta de Shampoo Reparador 250 ml",
  "motivo": "Venta reportada de 2 unidades.",
  "creada_en": "2026-10-28T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-11-02T14:40:00Z",
  "efectos_si": [
    "Se descuentan las unidades."
  ],
  "efectos_no": [
    "El stock no cambia."
  ],
  "detalle": {
    "producto": "Kit Reparación",
    "cantidad": 3,
    "kit_id": "55555555-5555-4555-8555-555555555555"
  }
}
```

### Propuesta `catalogo`

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `variantes` | lista de cadena | No | Sí |
| `oferta` | objeto | Sí | Sí |
| `oferta.type` | `product`, `service` | No | Sí |
| `oferta.id` | cadena | No | Sí |
| `oferta.nombre` | cadena | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "catalogo",
  "titulo": "Producto nuevo: Mascarilla Capilar",
  "motivo": "Producto nuevo para el catálogo.",
  "creada_en": "2026-10-28T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-30T14:40:00Z",
  "efectos_si": [
    "Se crea el producto ligado a su oferta, sin cambiar la oferta."
  ],
  "efectos_no": [
    "El catálogo no cambia."
  ],
  "detalle": {
    "producto": "Mascarilla de Argán",
    "variantes": [
      "250 ml"
    ],
    "oferta": {
      "type": "product",
      "id": "33333333-3333-4333-8333-333333333333",
      "nombre": "Rutina Reparación"
    }
  }
}
```

### Propuesta `union_catalogo`

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `origen_id` | uuid | No | Sí |
| `destino_id` | uuid | No | Sí |
| `similitud` | número | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "union_catalogo",
  "titulo": "Unir Shampoo Reparador 250ml con Shampoo Reparador 250 ml",
  "motivo": "Parecen el mismo producto.",
  "creada_en": "2026-10-31T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-29T14:40:00Z",
  "efectos_si": [
    "Sus saldos se suman. Ningún movimiento cambia."
  ],
  "efectos_no": [
    "Siguen como productos separados."
  ],
  "detalle": {
    "origen_id": "11111111-1111-4111-8111-111111111111",
    "destino_id": "22222222-2222-4222-8222-222222222222",
    "similitud": 0.72
  }
}
```

### Propuesta `pedido`

Solo se aprueba en pantalla. Aprobar crea pedido en `negociando` y negociación `abierta` en la misma transacción, y despierta a Ale. Con otra negociación abierta en el relé, de cualquier negocio, da 409 `CONFLICT`. `proveedores` va por costo total, y `plazo_pago_dias: 0` con `garantia: "Sin dato"` significa que la cotización no los trae.

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `cantidad` | entero | No | Sí |
| `stock_esperado` | entero | No | Sí |
| `ritmo_semanal` | número | No | Sí |
| `dias_entrega` | entero | No | Sí |
| `proveedores` | lista de objeto | No | Sí |
| `proveedores[].nombre` | cadena | No | Sí |
| `proveedores[].precio` | decimal en cadena | No | Sí |
| `proveedores[].flete` | decimal en cadena | No | Sí |
| `proveedores[].minimo` | entero | No | Sí |
| `proveedores[].dias_entrega` | entero | No | Sí |
| `proveedores[].plazo_pago_dias` | entero | No | Sí |
| `proveedores[].garantia` | cadena | No | Sí |
| `proveedores[].costo_total` | decimal en cadena | No | Sí |
| `proveedores[].elegido` | booleano | No | Sí |
| `proveedores[].equivalencia` | `equivalente`, `alternativa` | No | Sí |
| `mandato` | objeto | No | Sí |
| `mandato.precio_objetivo` | decimal en cadena | No | Sí |
| `mandato.tope` | decimal en cadena | No | Sí |
| `mandato.cantidad` | entero | No | Sí |
| `moneda` | cadena | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "pedido",
  "titulo": "Pedido de Shampoo Reparador 250 ml",
  "motivo": "Comparados 2 proveedores por costo total.",
  "creada_en": "2026-10-30T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-31T14:40:00Z",
  "efectos_si": [
    "Se crea el pedido y empieza la negociación dentro del mandato. Nada se paga."
  ],
  "efectos_no": [
    "No se crea pedido, ni negociación, ni mensaje."
  ],
  "detalle": {
    "producto": "Shampoo 250 ml",
    "cantidad": 60,
    "stock_esperado": 12,
    "ritmo_semanal": 14,
    "dias_entrega": 5,
    "proveedores": [
      {
        "nombre": "Distribuidora Capilar",
        "precio": "17000.00",
        "flete": "20000.00",
        "minimo": 24,
        "dias_entrega": 5,
        "plazo_pago_dias": 30,
        "garantia": "30 días",
        "costo_total": "1040000.00",
        "elegido": true,
        "equivalencia": "equivalente"
      }
    ],
    "mandato": {
      "precio_objetivo": "16000.00",
      "tope": "17000.00",
      "cantidad": 60
    },
    "moneda": "COP"
  }
}
```

### Propuesta `kit`

`hipotesis`, `diagnostico`, `precio_fuente` y `fuentes` los escribe el agente con datos de terceros: son texto no confiable. Llegan en una línea, sin caracteres ocultos y con máximo 300 caracteres. El front los muestra como texto y como supuesto, nunca como instrucción ni como HTML. `fuentes` solo trae URL `http` o `https` sin usuario ni clave: el servidor descarta las demás al crear y otra vez al leer. Lista vacía significa que no hay fuente, y el front lo dice. `precio_fuente` es nulo si el agente no lo dio.

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `subtipo` | `kit`, `complemento`, `venta_adicional` | No | Sí |
| `componentes` | lista de objeto | No | Sí |
| `componentes[].nombre` | cadena | No | Sí |
| `componentes[].cantidad` | entero | No | Sí |
| `componentes[].costo` | decimal en cadena | Sí | Sí |
| `costo_total` | decimal en cadena | Sí | Sí |
| `precio_propuesto` | decimal en cadena | Sí | Sí |
| `margen_dinero` | decimal en cadena, puede ser negativo | Sí | Sí |
| `margen_pct` | número | Sí | Sí |
| `unidades_alcanzan` | entero | No | Sí |
| `costo_incompleto` | booleano | No | Sí |
| `precio_pendiente` | booleano | No | Sí |
| `hipotesis` | cadena, no confiable | No | Sí |
| `diagnostico` | cadena, no confiable | No | Sí |
| `precio_fuente` | cadena, no confiable | Sí | Sí |
| `fuentes` | lista de objeto, no confiable | No | Sí |
| `fuentes[].url` | URL `http` o `https` | No | Sí |
| `fuentes[].fecha` | cadena, no confiable | No | Sí |
| `moneda` | cadena | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "kit",
  "titulo": "Propuesta: Kit Shampoo 250 ml + Mascarilla 300 ml",
  "motivo": "Propuesta para mover producto parado, con margen del servidor.",
  "creada_en": "2026-10-29T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-10-29T14:40:00Z",
  "efectos_si": [
    "Se crea el kit en el inventario, sin oferta todavía."
  ],
  "efectos_no": [
    "No se crea ningún kit ni oferta."
  ],
  "detalle": {
    "subtipo": "kit",
    "componentes": [
      {
        "nombre": "Shampoo 250 ml",
        "cantidad": 1,
        "costo": "17000.00"
      }
    ],
    "costo_total": "17000.00",
    "precio_propuesto": "29000.00",
    "margen_dinero": "12000.00",
    "margen_pct": 41.38,
    "unidades_alcanzan": 15,
    "costo_incompleto": false,
    "precio_pendiente": false,
    "hipotesis": "El kit arrastra la mascarilla parada.",
    "diagnostico": "valor_percibido",
    "precio_fuente": "Suma de precios actuales con 10 % de descuento.",
    "fuentes": [
      {
        "url": "https://www.ejemplo.com/mascarilla-capilar",
        "fecha": "2026-10-27"
      }
    ],
    "moneda": "COP"
  }
}
```

### Propuesta `apuesta`

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `producto` | cadena | No | Sí |
| `presupuesto_diario` | decimal en cadena | No | Sí |
| `tope` | decimal en cadena | No | Sí |
| `duracion_dias` | entero | No | Sí |
| `unidades_semana_previstas` | número | Sí | Sí |
| `fuente_prevision` | `dato`, `supuesto` | No | Sí |
| `moneda` | cadena | No | Sí |
| `senal` | objeto | No | Sí |
| `senal.saldo` | entero | No | Sí |
| `senal.esperado` | entero | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "apuesta",
  "titulo": "Apuesta de pauta: Shampoo 250 ml",
  "motivo": "Propuesta de pauta con presupuesto y tope, para decidir en la pantalla.",
  "creada_en": "2026-10-31T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-11-01T14:40:00Z",
  "efectos_si": [
    "Se guarda el ritmo base. No lanza campañas ni gasta."
  ],
  "efectos_no": [
    "No pasa nada con la pauta."
  ],
  "detalle": {
    "producto": "Shampoo 250 ml",
    "presupuesto_diario": "50000.00",
    "tope": "350000.00",
    "duracion_dias": 7,
    "unidades_semana_previstas": 20,
    "fuente_prevision": "supuesto",
    "moneda": "COP",
    "senal": {
      "saldo": 42,
      "esperado": 42
    }
  }
}
```

## Avisos pendientes (IVB-024)

Qué aviso ya se le dijo a la dueña lo sabe el servidor, no la memoria del modelo. El tick corre sin memoria y repetía avisos viejos del tablero, y la sesión larga callaba avisos nuevos porque los creía repetidos (`evidencia/diagnostico-memoria-vieja.md`).

**Quién los calcula.** El servidor, con el mismo cálculo de rotación de `saleads_stock_get_bet_signal`, en la corrida activa y con el reloj del negocio. Stock no los registra. Solo cuentan productos con saldo mayor a 0.

| `tipo` | Cuándo | `estado_desde` (ancla) | `siguiente` |
|---|---|---|---|
| `frenazo` | `ritmo.estado` = `frenazo` | Última venta | `marketing` |
| `lento` | `ritmo.estado` = `lento` | Última venta | `marketing` |
| `sin_pauta` | `ritmo.estado` = `sin_pauta` | Última entrada | `marketing` |
| `cobertura` | La cobertura de la opción elegible más rápida es menor que `punto_pedido_dias` (entrega + 3 días) | Última entrada | `pedido` |
| `pegando` | `pegando` de la señal de pauta | Inicio de la apuesta aprobada | `pedido` |

**`alerta_id`.** UUID derivado de un SHA-256 de negocio, corrida, variante, `tipo` y `estado_desde`. Es estable mientras dure ese estado: se dice una vez y no se repite a diario. Si el estado se limpia y vuelve (otra venta, otra entrada u otra apuesta), cambia el ancla y nace otro id.

**`get_overview.avisos_pendientes`.** Lo activo que no tiene evento de voz en la corrida activa. Cada entrada:

| Campo | Tipo | Nulable |
|---|---|---|
| `alerta_id` | uuid | No |
| `tipo` | `frenazo`, `lento`, `sin_pauta`, `cobertura`, `pegando` | No |
| `variante_id`, `producto_id` | uuid | No |
| `producto` | cadena | No |
| `estado_desde` | fecha ISO | Sí |
| `siguiente` | `marketing`, `pedido` | No |
| `texto` | cadena, hasta 240 | No |
| `pregunta` | booleano, siempre `true` | No |
| `simulado` | booleano | No |
| `cifras` | `saldo`, `base_semanal`, `actual_semanal`, `dias_sin_venta`, `cobertura_dias`, `punto_pedido_dias`, `ritmo_actual_semana`, `dias_cobertura_al_ritmo_actual` | Las cuatro con «días», `cobertura_dias` y `punto_pedido_dias` pueden ser nulas |

`texto` lo arma el servidor con las cifras actuales y termina con la pregunta: «¿Se lo paso a marketing para que lo mueva?» si `siguiente` es `marketing`, o «¿Le pido a Stock que prepare el pedido?» si es `pedido`. Con corrida, además, « Datos simulados.».

**Decirlo.** `saleads_stock_robot_say` con solo `alerta_id` (y `prioridad` opcional). El servidor:
- valida que el aviso esté activo ahora. Si no, responde `no_vigente` y no habla;
- si ya tiene evento en la corrida, responde `ya_dicho` con `evento_original` y no habla;
- si no, crea el evento con la frase del servidor y la clave `alerta:<alerta_id>` (con corrida, `@corrida-<run_id>`). Crear el evento es lo que lo marca como dicho, aunque quede `agrupado` o `tope_diario` para el canal.
- Con `robot_offline` no se crea nada y el aviso sigue pendiente.

`robot_say` libre sigue para las respuestas de turno. Un texto que empiece por `AVISO:` o una clave que empiece por `alerta` o `stock-alerta`, sin `alerta_id`, da 400 `STOCK_ALERT_ID_REQUIRED`.

**Sin migración.** Lo dicho vive en `stock_robot_events` y su `dedupe_key`.

#### Señal pegando (IVB-024)

`saleads_stock_get_bet_signal` suma cuatro campos aditivos. Los calcula el servidor con el reloj del negocio, y el agente no los estima:

| Campo | Tipo | Nulable | Qué es |
|---|---|---|---|
| `pegando` | booleano | No | La apuesta aprobada y en curso vende muy por encima de lo previsto |
| `ritmo_actual_semana` | número | No | Ventas de los últimos 2 días × 7 / 2, con un decimal |
| `motivo_pegando` | cadena | Sí | Frase fija con las cifras. Nula si `pegando` es falso |
| `dias_cobertura_al_ritmo_actual` | número | Sí | `saldo / (ritmo_actual_semana / 7)`. Nulo con ritmo 0 |

Criterio:

1. **Ventana:** los últimos 2 días. Con una apuesta aprobada en curso, solo cuentan las ventas desde su inicio, porque son las atribuidas a la pauta. Fiado y movimiento no cuentan, igual que en el ritmo base.
2. **Proyección:** las unidades de la ventana se multiplican por 7 y se dividen siempre por 2 días, aunque la apuesta lleve menos. Así unas horas de pauta nunca se proyectan a una semana: el primer día subestima y nunca exagera.
3. **Referencia:** `unidades_semana_previstas` de la apuesta. Si la apuesta no trae previsión, se usa el ritmo base congelado al aprobarla (R17).
4. **Pega** si hay apuesta aprobada en curso, la ventana suma al menos 2 unidades y `ritmo_actual_semana ≥ 1,5 × referencia`. Sin apuesta aprobada en curso, `pegando` es falso. `ritmo_actual_semana` y la cobertura igual se informan.

Por qué así:

- **1,5 veces:** es el mismo factor que la previsión `supuesto` de la skill: base × 1,5. Sin previsión, pegar significa superar lo que la apuesta habría supuesto. Con previsión, vender 1,5 veces lo previsto agota lo planeado un tercio antes, y eso ya cambia la reposición.
- **2 días:** una apuesta dura unos 5 días. Con 2 días se reacciona a mitad de la apuesta. Con 1, un solo día bueno decide.
- **Mínimo de 2 unidades:** con base 0 y sin previsión, una sola venta daría «pega». Una venta no es tendencia.
- **Cobertura al ritmo actual:** es la cifra para decidir el pedido. `cobertura_dias` suma la previsión al ritmo de la semana y puede quedarse corta cuando el producto pega.

Ejemplo: apuesta con 20 previstas por semana y 9 ventas en los últimos 2 días. El ritmo es 9 × 7 / 2 = 31,5 ≥ 30, así que pega. Con saldo 42, la cobertura al ritmo actual es 42 / 4,5 = 9,3 días.

### Propuesta `autonomia`

Solo se aprueba en pantalla. Aprobar registra el permiso y no cambia `nivel` ni `nivel_efectivo` mientras el tope del servidor sea 2. `nivel_actual` y `nivel_efectivo` se leen al momento; `evidencia` la calcula el servidor al pedir. Si el nivel bajó o la evidencia dejó de cumplirse, aprobar da `CONFLICT`.

Detalle:

| Campo | Tipo | Nulable | Obligatorio |
|---|---|---|---|
| `area` | `inventario`, `reposicion`, `negociacion`, `ofertas` | No | Sí |
| `nivel_actual` | entero | No | Sí |
| `nivel_pedido` | entero | No | Sí |
| `nivel_efectivo` | entero | No | Sí |
| `monto_tope` | decimal en cadena | No | Sí |
| `evidencia` | lista de objeto | No | Sí |
| `evidencia[].dato` | cadena | No | Sí |
| `evidencia[].valor` | cadena | No | Sí |
| `evidencia[].fuente` | cadena | No | Sí |
| `evidencia[].simulado` | booleano | No | Sí |

<!-- ejemplo: StockProposalV1 -->
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "tipo": "autonomia",
  "titulo": "Permiso para reponer: nivel 3",
  "motivo": "Pedido recibido sin diferencia y ahorro confirmado de 60.000 COP.",
  "creada_en": "2026-10-29T14:40:00Z",
  "estado": "pendiente",
  "simulado": false,
  "revision": 1,
  "vence_en": "2026-11-03T14:40:00Z",
  "efectos_si": [
    "Queda registrado tu permiso. El nivel real sigue en 2: nada se compra ni se paga solo."
  ],
  "efectos_no": [
    "Todo sigue igual, en nivel 2."
  ],
  "detalle": {
    "area": "reposicion",
    "nivel_actual": 2,
    "nivel_pedido": 3,
    "nivel_efectivo": 2,
    "monto_tope": "500000.00",
    "evidencia": [
      {
        "dato": "Pedidos recibidos sin diferencia",
        "valor": "1",
        "fuente": "libro",
        "simulado": true
      }
    ]
  }
}
```

