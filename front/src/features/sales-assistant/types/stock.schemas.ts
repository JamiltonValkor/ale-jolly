import { z } from 'zod'

/**
 * Contrato web de Stock v1. Copia de `src/contracts/stock-v1.ts` de
 * ale-runtime (`docs/stock-contract-v1.md`): si difieren, gana ale-runtime.
 * Todo es estricto: un campo nuevo es un cambio de contrato, no un dato suelto.
 * Excepción en propuestas: una que este front no entiende no tira la lista, se
 * degrada a `no_soportada` y no se puede aprobar.
 */

const uuid = z.uuid()
const int = z.number().int()
const iso = z.iso.datetime({ offset: true })
const currency = z.string().length(3)
const money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)

export const STOCK_MOTIVO_MAX = 300
export const STOCK_AREAS = [
  'inventario',
  'reposicion',
  'negociacion',
  'ofertas',
] as const
export const STOCK_CAUSES = ['venta', 'fiado', 'movimiento', 'otra'] as const

const stockArea = z.enum(STOCK_AREAS)
const stockCause = z.enum(STOCK_CAUSES)
const motivo = z.string().max(STOCK_MOTIVO_MAX)
const level = int.min(1).max(4)

/** La foto firmada solo se acepta del bucket: nunca una URL arbitraria. */
const photoUrl = z
  .url()
  .refine(value => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' && url.hostname === 'storage.googleapis.com'
    )
  })
  .nullable()

export const stockStatusSchema = z
  .object({ enabled: z.boolean(), business_ids: z.array(uuid) })
  .strict()

export const stockStatusResponseSchema = z.union([
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), data: stockStatusSchema }).strict(),
])

export const stockSummarySchema = z
  .object({
    unidades_esperadas: int,
    diferencias_por_resolver: int,
    propuestas_pendientes: int,
    pedidos_en_curso: int,
    ultimo_conteo_en: iso.nullable(),
    moneda: currency,
    simulado: z.boolean(),
  })
  .strict()

const stockItemSchema = z
  .object({
    variante_id: uuid,
    producto_id: uuid,
    producto: z.string(),
    variante: z.string(),
    oferta: z
      .object({ id: z.string(), nombre: z.string() })
      .strict()
      .nullable(),
    ultimo_conteo: int.nullable(),
    entradas: int,
    ventas_reportadas: int,
    esperado: int,
    contado: int.nullable(),
    contado_en: iso.nullable(),
    diferencia: int.nullable(),
    estado: z.enum([
      'cuadra',
      'causa_preguntada',
      'conteo_por_aprobar',
      'sin_conteo_reciente',
    ]),
    propuesta_id: uuid.nullable(),
    simulado: z.boolean(),
  })
  .strict()

const stockKitSchema = z
  .object({
    id: uuid,
    nombre: z.string(),
    estado: z.string(),
    componentes: z.array(
      z
        .object({ variante_id: uuid, nombre: z.string(), cantidad: int })
        .strict()
    ),
    alcanzan: int,
    simulado: z.boolean(),
  })
  .strict()

export const stockItemsSchema = z
  .object({ items: z.array(stockItemSchema), kits: z.array(stockKitSchema) })
  .strict()

export const stockOrderSchema = z
  .object({
    id: uuid,
    producto: z.string(),
    cantidad: int,
    proveedor: z.string(),
    costo: money.nullable(),
    costo_tipo: z.enum(['esperado', 'acordado']),
    moneda: currency,
    estado: z.enum([
      'aprobado',
      'negociando',
      'acordado',
      'en_camino',
      'recibido',
      'cancelado',
    ]),
    novedad: z.enum(['respuesta_proveedor']).nullable(),
    pedido_cantidad: int,
    recibido_cantidad: int.nullable(),
    ahorro_confirmado: money.nullable(),
    simulado: z.boolean(),
  })
  .strict()

export const stockOrdersSchema = z
  .object({ pedidos: z.array(stockOrderSchema) })
  .strict()

export const stockAutonomyAreaSchema = z
  .object({
    area: stockArea,
    nivel: level,
    nivel_efectivo: level,
    revision: int.min(1),
  })
  .strict()

export const stockAutonomySchema = z
  .object({ areas: z.array(stockAutonomyAreaSchema) })
  .strict()

const common = {
  id: uuid,
  titulo: z.string().min(1),
  motivo: z.string().min(1),
  creada_en: iso,
  estado: z.enum(['pendiente', 'aprobada', 'rechazada', 'vencida']),
  simulado: z.boolean(),
  revision: int.min(1),
  vence_en: iso,
  efectos_si: z.array(z.string()).min(1),
  efectos_no: z.array(z.string()).min(1),
}

const conteoDetalle = z
  .object({
    producto: z.string(),
    esperado: int,
    contado: int,
    diferencia: int,
    causa_requerida: z.boolean(),
    causa_opciones: z.array(stockCause),
    origen: z.enum(['foto', 'voz', 'canal']),
    foto_estado: z.enum(['sin_foto', 'disponible', 'no_disponible']),
    foto_url: photoUrl,
    foto_expira_en: iso.nullable(),
    foto_tomada_en: iso.nullable(),
    total_objetos: int.nullable(),
    variante_dudosa: z.string().nullable(),
    conteo_en: iso,
  })
  .strict()

const entradaDetalle = z
  .object({
    lineas: z.array(
      z
        .object({
          descripcion: z.string(),
          cantidad: int,
          costo_unitario: money,
          dudoso: z.array(z.string()),
        })
        .strict()
    ),
    proveedor: z.string().nullable(),
    documento_id: uuid,
    moneda: currency,
  })
  .strict()

const ventaDetalle = z
  .object({ producto: z.string(), cantidad: int, kit_id: uuid.nullable() })
  .strict()

const catalogoDetalle = z
  .object({
    producto: z.string(),
    variantes: z.array(z.string()),
    oferta: z
      .object({
        type: z.enum(['product', 'service']),
        id: z.string(),
        nombre: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict()

const unionDetalle = z
  .object({
    origen_id: uuid,
    destino_id: uuid,
    similitud: z.number().min(0).max(1),
  })
  .strict()

const pedidoDetalle = z
  .object({
    producto: z.string(),
    cantidad: int,
    stock_esperado: int,
    ritmo_semanal: z.number(),
    dias_entrega: int,
    proveedores: z.array(
      z
        .object({
          nombre: z.string(),
          precio: money,
          flete: money,
          minimo: int,
          dias_entrega: int,
          plazo_pago_dias: int,
          garantia: z.string(),
          costo_total: money,
          elegido: z.boolean(),
          equivalencia: z.enum(['equivalente', 'alternativa']),
        })
        .strict()
    ),
    mandato: z
      .object({ precio_objetivo: money, tope: money, cantidad: int })
      .strict(),
    moneda: currency,
  })
  .strict()

const kitDetalle = z
  .object({
    subtipo: z.enum(['kit', 'complemento', 'venta_adicional']),
    componentes: z.array(
      z
        .object({
          nombre: z.string(),
          cantidad: int,
          costo: money.nullable(),
        })
        .strict()
    ),
    costo_total: money.nullable(),
    precio_propuesto: money.nullable(),
    margen_dinero: z.string().nullable(),
    margen_pct: z.number().nullable(),
    unidades_alcanzan: int,
    costo_incompleto: z.boolean(),
    precio_pendiente: z.boolean(),
    hipotesis: z.string(),
    /**
     * Aún no salen en `StockProposalV1` (ale-runtime `e467de7` los guarda en
     * `payload`): opcionales para mostrarlos el día que lleguen, sin otra entrega.
     */
    diagnostico: z.string().nullable().optional(),
    precio_fuente: z.string().nullable().optional(),
    fuentes: z
      .array(z.object({ url: z.string(), fecha: z.string() }).strict())
      .optional(),
    moneda: currency,
  })
  .strict()

const apuestaDetalle = z
  .object({
    producto: z.string(),
    presupuesto_diario: money,
    tope: money,
    duracion_dias: int,
    unidades_semana_previstas: z.number().nullable(),
    fuente_prevision: z.enum(['dato', 'supuesto']),
    moneda: currency,
    senal: z.object({ saldo: int, esperado: int }).strict(),
  })
  .strict()

const autonomiaDetalle = z
  .object({
    area: stockArea,
    nivel_actual: int,
    nivel_pedido: int,
    nivel_efectivo: int,
    monto_tope: money,
    evidencia: z.array(
      z
        .object({
          dato: z.string(),
          valor: z.string(),
          fuente: z.string(),
          simulado: z.boolean(),
        })
        .strict()
    ),
  })
  .strict()

function proposal<K extends string, D extends z.ZodType>(tipo: K, detalle: D) {
  return z.object({ ...common, tipo: z.literal(tipo), detalle }).strict()
}

export const stockKnownProposalSchema = z.discriminatedUnion('tipo', [
  proposal('conteo', conteoDetalle),
  proposal('entrada', entradaDetalle),
  proposal('venta', ventaDetalle),
  proposal('catalogo', catalogoDetalle),
  proposal('union_catalogo', unionDetalle),
  proposal('pedido', pedidoDetalle),
  proposal('kit', kitDetalle),
  proposal('apuesta', apuestaDetalle),
  proposal('autonomia', autonomiaDetalle),
])

/**
 * `tipo` nuevo o detalle que ya no cuadra: conserva solo lo común y descarta
 * `detalle`, que aquí no se sabe leer. El dueño la ve y puede rechazarla.
 */
const stockUnsupportedProposalSchema = z
  .object({
    ...common,
    tipo: z.string(),
    efectos_si: z.array(z.string()),
    efectos_no: z.array(z.string()),
  })
  .transform(proposal => ({ ...proposal, tipo: 'no_soportada' as const }))

export const stockProposalSchema = z.union([
  stockKnownProposalSchema,
  stockUnsupportedProposalSchema,
])

export const stockProposalsSchema = z
  .object({ propuestas: z.array(stockProposalSchema) })
  .strict()

/** R15: la dueña reparte el total entre variantes; nunca hay reparto por defecto. */
export const stockShareSchema = z
  .object({
    variante_id: z.string().uuid(),
    contado: z.number().int().min(0),
    causa: stockCause.optional(),
  })
  .strict()

export const stockApproveRequestSchema = z
  .object({
    motivo: motivo.optional(),
    causa: stockCause.optional(),
    reparto: z
      .array(stockShareSchema)
      .min(1)
      .max(20)
      .refine(
        shares =>
          new Set(shares.map(share => share.variante_id)).size ===
          shares.length,
        { message: 'reparto sin variantes repetidas' }
      )
      .optional(),
  })
  .strict()

export const stockRejectRequestSchema = z
  .object({ motivo: motivo.optional() })
  .strict()

export const stockAutonomyLevelRequestSchema = z
  .object({ nivel: level, motivo: motivo.optional() })
  .strict()

export type StockStatus = z.infer<typeof stockStatusSchema>
export type StockStatusResponse = z.infer<typeof stockStatusResponseSchema>
export type StockSummary = z.infer<typeof stockSummarySchema>
export type StockItems = z.infer<typeof stockItemsSchema>
export type StockItem = StockItems['items'][number]
export type StockKit = StockItems['kits'][number]
export type StockOrders = z.infer<typeof stockOrdersSchema>
export type StockOrder = StockOrders['pedidos'][number]
export type StockAutonomy = z.infer<typeof stockAutonomySchema>
export type StockAutonomyArea = z.infer<typeof stockAutonomyAreaSchema>
export type StockAreaName = (typeof STOCK_AREAS)[number]
export type StockCause = (typeof STOCK_CAUSES)[number]
export type StockProposal = z.output<typeof stockProposalSchema>
export type StockProposalOf<T extends StockProposal['tipo']> = Extract<
  StockProposal,
  { tipo: T }
>
export type StockDecision = 'approve' | 'reject'
export type StockShare = z.infer<typeof stockShareSchema>
