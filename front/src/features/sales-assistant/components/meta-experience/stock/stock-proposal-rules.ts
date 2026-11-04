import type { StockProposal } from '../../../types'

export type StockApprovalBlock =
  | 'effects'
  | 'photoLost'
  | 'photoRefreshing'
  | 'unsupported'
  | null

/**
 * Por qué no se puede aprobar. El servidor es la barrera real (O-15), esto solo
 * evita confirmar a ciegas. `sin_foto` sí se puede: un conteo por voz no se
 * queda sin aprobación en pantalla.
 */
export function approvalBlock(
  proposal: StockProposal,
  photoReady: boolean
): StockApprovalBlock {
  if (proposal.tipo === 'no_soportada') return 'unsupported'
  if (!proposal.efectos_si.length || !proposal.efectos_no.length)
    return 'effects'
  if (proposal.tipo !== 'conteo') return null
  if (proposal.detalle.foto_estado === 'no_disponible') return 'photoLost'
  if (proposal.detalle.foto_estado === 'disponible' && !photoReady)
    return 'photoRefreshing'
  return null
}

/** Conteo con causa pendiente: no se aprueba sin elegirla (R6). */
export function needsCause(proposal: StockProposal): boolean {
  return proposal.tipo === 'conteo' && proposal.detalle.causa_requerida
}

/** R15: la foto no distingue la variante, la dueña reparte el total. */
export function needsShare(proposal: StockProposal): boolean {
  return proposal.tipo === 'conteo' && !!proposal.detalle.variante_dudosa
}

export function causeOptions(proposal: StockProposal) {
  return proposal.tipo === 'conteo' ? proposal.detalle.causa_opciones : []
}

/** El texto del botón sigue al subtipo: un complemento no es un kit. */
export function confirmKind(proposal: StockProposal) {
  return proposal.tipo === 'kit' ? proposal.detalle.subtipo : proposal.tipo
}

const NOT_IN_STOCK = ' (no entra al inventario)'
const ARROW = ' → '

/**
 * `descripcion` de una línea de factura trae el destino al final, y lo agrega el
 * servicio después del texto de la factura: por eso se lee desde el final.
 */
export function splitEntryLine(text: string) {
  if (text.endsWith(NOT_IN_STOCK))
    return {
      name: text.slice(0, -NOT_IN_STOCK.length),
      destination: null,
      entersStock: false,
    }
  const at = text.lastIndexOf(ARROW)
  return at < 0
    ? { name: text, destination: null, entersStock: true }
    : {
        name: text.slice(0, at),
        destination: text.slice(at + ARROW.length),
        entersStock: true,
      }
}
