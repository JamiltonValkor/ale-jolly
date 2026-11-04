import type {Database} from '../persistence/database';

export interface PairingRow {
  id: string;
  poll_hash: string;
  device_name: string;
  status: 'pending' | 'claimed' | 'delivered';
  user_id: string | null;
  expires_at: Date;
}

export interface DeviceRow { id: string; user_id: string; name: string; created_at: Date; last_seen_at: Date | null }

/** Emparejamientos y robots del canal robot. Solo hashes; nunca códigos, secretos ni credenciales en claro. */
export class DevicesRepository {
  constructor(private readonly database: Database) {}

  /** Borra emparejamientos vencidos sin entregar y cuenta los pendientes vivos. */
  async sweepAndCountPending(now: Date): Promise<number> {
    await this.database.pool.query(
      `DELETE FROM assistant.robot_pairings WHERE expires_at <= $1 AND status <> 'delivered'`, [now]);
    const {rows} = await this.database.pool.query(
      `SELECT count(*)::int AS n FROM assistant.robot_pairings WHERE status = 'pending' AND expires_at > $1`, [now]);
    return (rows[0] as {n: number}).n;
  }

  async createPairing(id: string, codeHash: string, pollHash: string, deviceName: string, expiresAt: Date): Promise<void> {
    await this.database.pool.query(`
      INSERT INTO assistant.robot_pairings (id, code_hash, poll_hash, device_name, expires_at)
      VALUES ($1, $2, $3, $4, $5)`, [id, codeHash, pollHash, deviceName, expiresAt]);
  }

  async findPairing(id: string): Promise<PairingRow | null> {
    const {rows} = await this.database.pool.query(`
      SELECT id, poll_hash, device_name, status, user_id, expires_at FROM assistant.robot_pairings WHERE id = $1`, [id]);
    return (rows[0] as PairingRow | undefined) ?? null;
  }

  /** El dueño reclama un código pendiente y vivo. Devuelve el nombre del robot, o null si no hay tal código. */
  async claim(codeHash: string, userId: string, now: Date): Promise<string | null> {
    const {rows} = await this.database.pool.query(`
      UPDATE assistant.robot_pairings SET status = 'claimed', user_id = $2
      WHERE code_hash = $1 AND status = 'pending' AND expires_at > $3
      RETURNING device_name`, [codeHash, userId, now]);
    return (rows[0] as {device_name: string} | undefined)?.device_name ?? null;
  }

  /**
   * Entrega única: marca el emparejamiento reclamado como entregado (atómico; un segundo sondeo no
   * gana) y crea el robot con el hash de su credencial.
   */
  async deliver(pairingId: string, deviceId: string, tokenHash: string, now: Date): Promise<boolean> {
    const {rows} = await this.database.pool.query(`
      UPDATE assistant.robot_pairings SET status = 'delivered', device_id = $2
      WHERE id = $1 AND status = 'claimed' AND expires_at > $3
      RETURNING user_id, device_name`, [pairingId, deviceId, now]);
    const won = rows[0] as {user_id: string; device_name: string} | undefined;
    if (!won) return false;
    await this.database.pool.query(`
      INSERT INTO assistant.robot_devices (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
    [deviceId, won.user_id, won.device_name, tokenHash]);
    return true;
  }

  async findByToken(tokenHash: string): Promise<{id: string; user_id: string; last_seen_at: Date | null} | null> {
    const {rows} = await this.database.pool.query(`
      SELECT id, user_id, last_seen_at FROM assistant.robot_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    return (rows[0] as {id: string; user_id: string; last_seen_at: Date | null} | undefined) ?? null;
  }

  async touch(deviceId: string, now: Date): Promise<void> {
    await this.database.pool.query(`UPDATE assistant.robot_devices SET last_seen_at = $2 WHERE id = $1`, [deviceId, now]);
  }

  async list(userId: string): Promise<DeviceRow[]> {
    const {rows} = await this.database.pool.query(`
      SELECT id, user_id, name, created_at, last_seen_at FROM assistant.robot_devices
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [userId]);
    return rows as DeviceRow[];
  }

  async revoke(userId: string, deviceId: string, now: Date): Promise<boolean> {
    const {rowCount} = await this.database.pool.query(`
      UPDATE assistant.robot_devices SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId, now]);
    return (rowCount ?? 0) > 0;
  }
}
