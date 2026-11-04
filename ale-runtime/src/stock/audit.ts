import {createHash, randomUUID} from 'node:crypto';
import type {StockQuery} from './store';

export const argsHash = (args: unknown): string => createHash('sha256').update(JSON.stringify(args)).digest('hex');

export interface AuditEntry {businessId: string; traceId: string; actor: string; action: string; entity: string; entityId: string; args: unknown}

/** Traza de solo inserción. Guarda el hash de los argumentos, nunca el texto de un tercero. */
export async function writeAudit(q: StockQuery, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO assistant.stock_audit(id,business_id,trace_id,actor,action,entity,entity_id,args_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), entry.businessId, entry.traceId, entry.actor, entry.action, entry.entity, entry.entityId, argsHash(entry.args)]);
}

interface TraceRow {
  movement_id: string; trace_id: string; kind: string; confirmation_id: string | null; method: string | null; actor: string | null; quote: string | null;
  proposal_id: string | null; proposal_kind: string | null; photo_id: string | null; photo_status: string | null; photo_object: string | null; document_id: string | null; document_status: string | null;
  utterance_id: string | null; utterance: string | null; audit: Array<{action: string; entity: string; entity_id: string; actor: string; recorded_at: string}> | null;
}

/**
 * Cadena de un movimiento en una sola consulta. A los 30 días el bucket borra la imagen: `foto` sigue llegando al
 * registro y a su `object_original`, aunque el objeto ya no exista. Una frase usada en una confirmación no se purga.
 */
export async function traceMovement(q: StockQuery, movementId: string, runId: string | null) {
  const {rows} = await q.query<TraceRow>(
    `SELECT m.id AS movement_id, m.trace_id, m.kind, c.id AS confirmation_id, c.method, c.actor, c.quote, p.id AS proposal_id, p.kind AS proposal_kind,
            f.id AS photo_id, f.status AS photo_status, f.object_original AS photo_object, d.id AS document_id, d.status AS document_status, u.id AS utterance_id, u.text AS utterance,
            (SELECT jsonb_agg(jsonb_build_object('action', a.action, 'entity', a.entity, 'entity_id', a.entity_id, 'actor', a.actor, 'recorded_at', a.recorded_at) ORDER BY a.recorded_at)
               FROM assistant.stock_audit a WHERE a.business_id = m.business_id AND a.trace_id IN (m.trace_id, f.id, d.id)) AS audit
       FROM assistant.stock_movements m
       LEFT JOIN assistant.stock_confirmations c ON c.id = m.confirmation_id
       LEFT JOIN assistant.stock_proposals p ON p.id = m.proposal_id
       LEFT JOIN assistant.stock_owner_utterances u ON u.id = c.utterance_id
       LEFT JOIN assistant.stock_photos f ON f.id::text = p.payload->>'photo_id'
       LEFT JOIN assistant.stock_documents d ON d.id::text = p.payload->>'document_id'
      WHERE m.id = $1 AND m.run_id IS NOT DISTINCT FROM $2`, [movementId, runId]);
  const row = rows[0];
  if (!row) return null;
  const audit = row.audit ?? [];
  const card = audit.find(item => item.action === 'tarjeta_reservada');
  return {
    movimiento: {id: row.movement_id, trace_id: row.trace_id, tipo: row.kind},
    confirmacion: row.confirmation_id ? {id: row.confirmation_id, metodo: row.method, actor: row.actor, cita: row.quote} : null,
    propuesta: row.proposal_id ? {id: row.proposal_id, tipo: row.proposal_kind} : null,
    foto: row.photo_id ? {id: row.photo_id, estado: row.photo_status, objeto: row.photo_object} : null,
    documento: row.document_id ? {id: row.document_id, estado: row.document_status} : null,
    tarjeta: card ? {clave: card.entity_id.split('@')[0]} : null,
    frase: row.utterance_id ? {id: row.utterance_id, texto: row.utterance} : null,
    auditoria: audit,
  };
}
