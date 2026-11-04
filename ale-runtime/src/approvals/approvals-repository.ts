import type {AgentActivationDetailsV1, ApprovalDetailsV1, ApprovalItemV1, ApprovalKindV1, ApprovalParamsV1, ApprovalStatusV1} from '../contracts/v1';
import type {Database} from '../persistence/database';

/** Fila de assistant.approvals (V4). */
export interface ApprovalRow {
  id: string;
  user_id: string;
  business_id: string;
  kind: ApprovalKindV1;
  item_id: string;
  item_version: string;
  item_name: string;
  item_summary: string | null;
  status: ApprovalStatusV1;
  decision_key: string | null;
  result: Record<string, unknown> | null;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  /** MLB-013 (V7): lo que el dueño aprueba, los params validados y el código de un solo uso (solo su hash). */
  details: ApprovalDetailsV1 | AgentActivationDetailsV1 | null;
  params: ApprovalParamsV1 | null;
  otp_hash: string | null;
  otp_expires_at: Date | null;
  otp_attempts: number;
  otp_issued: number;
}

const COLUMNS = 'id, user_id, business_id, kind, item_id, item_version, item_name, item_summary, status, decision_key, result, expires_at, created_at, decided_at, details, params, otp_hash, otp_expires_at, otp_attempts, otp_issued';

export class ApprovalsRepository {
  constructor(private readonly db: Database) {}

  async find(id: string): Promise<ApprovalRow | null> {
    const {rows} = await this.db.pool.query(`SELECT ${COLUMNS} FROM assistant.approvals WHERE id=$1`, [id]);
    return (rows[0] as ApprovalRow | undefined) ?? null;
  }

  /** Último registro del mismo ítem y versión (pendiente o rechazado) para no duplicar ni insistir. */
  async latestForItem(userId: string, kind: ApprovalKindV1, itemId: string, version: string): Promise<ApprovalRow | null> {
    const {rows} = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM assistant.approvals
        WHERE user_id=$1 AND kind=$2 AND item_id=$3 AND item_version=$4 AND status IN ('pending','rejected')
        ORDER BY created_at DESC LIMIT 1`,
      [userId, kind, itemId, version]);
    return (rows[0] as ApprovalRow | undefined) ?? null;
  }

  async insert(
    id: string, userId: string,
    input: {business_id: string; kind: ApprovalKindV1; item: ApprovalItemV1; details?: ApprovalDetailsV1 | AgentActivationDetailsV1 | null; params?: ApprovalParamsV1 | null},
    expiresAt: Date,
  ): Promise<ApprovalRow> {
    const {rows} = await this.db.pool.query(
      `INSERT INTO assistant.approvals (id, user_id, business_id, kind, item_id, item_version, item_name, item_summary, expires_at, details, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLUMNS}`,
      [id, userId, input.business_id, input.kind, input.item.id, input.item.version, input.item.name, input.item.summary, expiresAt,
        input.details ? JSON.stringify(input.details) : null, input.params ? JSON.stringify(input.params) : null]);
    return rows[0] as ApprovalRow;
  }

  /** Nuevo código (invalida el anterior): solo si la aprobación sigue pendiente y no agotó sus 3 códigos. */
  async issueCode(id: string, hash: string, expiresAt: Date, now: Date): Promise<ApprovalRow | null> {
    const {rows} = await this.db.pool.query(
      `UPDATE assistant.approvals SET otp_hash=$2, otp_expires_at=$3, otp_attempts=0, otp_issued=otp_issued+1
        WHERE id=$1 AND status='pending' AND expires_at > $4 AND otp_issued < 3 RETURNING ${COLUMNS}`,
      [id, hash, expiresAt, now]);
    return (rows[0] as ApprovalRow | undefined) ?? null;
  }

  async failedAttempt(id: string): Promise<number> {
    const {rows} = await this.db.pool.query(
      `UPDATE assistant.approvals SET otp_attempts=LEAST(otp_attempts+1, 3) WHERE id=$1 RETURNING otp_attempts`, [id]);
    return Number((rows[0] as {otp_attempts?: number} | undefined)?.otp_attempts ?? 3);
  }

  /** Un solo uso: el código correcto se consume antes de ejecutar. */
  async consumeCode(id: string, hash: string): Promise<boolean> {
    const {rowCount} = await this.db.pool.query(
      `UPDATE assistant.approvals SET otp_hash=NULL WHERE id=$1 AND otp_hash=$2 AND otp_attempts < 3`, [id, hash]);
    return (rowCount ?? 0) === 1;
  }

  /** Toma la decisión una sola vez: solo pasa de `pending` si no venció. */
  async claim(id: string, status: 'executing' | 'rejected' | 'stale', key: string, now: Date): Promise<ApprovalRow | null> {
    const {rows} = await this.db.pool.query(
      `UPDATE assistant.approvals SET status=$2, decision_key=$3, decided_at=$4
        WHERE id=$1 AND status='pending' AND expires_at > $4 RETURNING ${COLUMNS}`,
      [id, status, key, now]);
    return (rows[0] as ApprovalRow | undefined) ?? null;
  }

  /** AAB-012: a newer proposal for the same item replaces the pending ones of other versions (one button per publication). */
  async expireOtherPending(userId: string, kind: ApprovalKindV1, itemId: string, version: string): Promise<number> {
    const result = await this.db.pool.query(
      `UPDATE assistant.approvals SET status='expired'
        WHERE user_id=$1 AND kind=$2 AND item_id=$3 AND item_version<>$4 AND status='pending'`,
      [userId, kind, itemId, version]);
    return result.rowCount ?? 0;
  }

  async markExpired(id: string): Promise<void> {
    await this.db.pool.query(`UPDATE assistant.approvals SET status='expired' WHERE id=$1 AND status='pending'`, [id]);
  }

  async finish(id: string, status: 'executed' | 'failed', result: Record<string, unknown>): Promise<ApprovalRow> {
    const {rows} = await this.db.pool.query(
      `UPDATE assistant.approvals SET status=$2, result=$3 WHERE id=$1 RETURNING ${COLUMNS}`,
      [id, status, JSON.stringify(result)]);
    return rows[0] as ApprovalRow;
  }
}
