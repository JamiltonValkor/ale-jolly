import {Logger} from '@nestjs/common';
import {createHash, randomBytes, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import type {DeviceClaimResponseV1, DevicesResponseV1, PairingPollResponseV1, PairingStartResponseV1} from '../contracts/v1';
import {notFound, pairingAttempts, serviceUnavailable} from '../domain/errors';
import type {DevicesRepository} from './devices-repository';

export const DEVICES_SERVICE = Symbol('DEVICES_SERVICE');

/** Sin 0/O, 1/I/L: el dueño lo lee de la cara del robot y lo puede teclear. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_PREFIX = 'ale_dev_';
const TOKEN = /^ale_dev_[A-Za-z0-9_-]{43}$/;

export interface DevicesOptions {
  /** Vida del código (el robot lo muestra y sondea mientras tanto). */
  pairingTtlMs: number;
  /** Tope de emparejamientos pendientes vivos (la ruta es pública: frena el abuso). */
  maxPending: number;
  /** Página del front para reclamar (`?code=`); vacío = el robot solo muestra el código. */
  claimUrl?: string;
  /** Códigos fallidos por usuario dentro de `claimWindowMs` antes de responder 429. */
  claimAttempts: number;
  claimWindowMs: number;
  now?: () => Date;
}

export interface DeviceIdentity { deviceId: string; userId: string }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

/** Normaliza lo que teclea el dueño: mayúsculas, sin guiones ni espacios. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Emparejamiento del canal robot. El robot es del USUARIO (Ale maneja todos sus negocios), así que el
 * emparejamiento no elige negocio. Privacidad y seguridad (el repo es público):
 * - el código (8 caracteres, ~39 bits) vive `pairingTtlMs`, es de un solo uso y solo se guarda su hash;
 * - reclamarlo exige la sesión web del dueño y se limita por usuario;
 * - la credencial del robot se entrega UNA vez, solo a quien tiene el secreto de sondeo, y se guarda hasheada;
 * - revocarla corta el canal al instante (cada petición la busca en la base).
 */
export class DevicesService {
  private readonly logger = new Logger('devices');
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => Date;

  constructor(private readonly options: DevicesOptions, private readonly repository: DevicesRepository) {
    this.now = options.now ?? (() => new Date());
  }

  async startPairing(name: string | undefined): Promise<PairingStartResponseV1> {
    const now = this.now();
    if (await this.repository.sweepAndCountPending(now) >= this.options.maxPending) {
      this.logger.warn('pairing refused reason=too_many_pending');
      throw serviceUnavailable();
    }
    const code = Array.from({length: 8}, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('');
    const pollSecret = secret();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + this.options.pairingTtlMs);
    await this.repository.createPairing(id, sha256(code), sha256(pollSecret), name || 'Jolly', expiresAt);
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    const claimUrl = this.options.claimUrl ? `${this.options.claimUrl}?code=${shown}` : null;
    this.logger.log(`pairing started id=${id}`);
    return {pairing_id: id, code: shown, poll_secret: pollSecret, expires_at: expiresAt.toISOString(), claim_url: claimUrl};
  }

  /** El robot pregunta si ya lo reclamaron. `paired` llega una sola vez, con la credencial. */
  async poll(pairingId: string, pollSecret: string): Promise<PairingPollResponseV1> {
    const now = this.now();
    const row = await this.repository.findPairing(pairingId);
    if (!row || !sameHash(row.poll_hash, sha256(pollSecret)) || row.status === 'delivered' || row.expires_at <= now) throw notFound();
    if (row.status === 'pending') return {status: 'pending'};
    const deviceId = randomUUID();
    const token = `${TOKEN_PREFIX}${secret()}`;
    if (!await this.repository.deliver(pairingId, deviceId, sha256(token), now)) throw notFound();
    this.logger.log(`pairing delivered id=${pairingId} device=${deviceId}`);
    return {status: 'paired', device_id: deviceId, device_token: token};
  }

  async claim(userId: string, code: string): Promise<DeviceClaimResponseV1> {
    const now = this.now();
    const recent = (this.failures.get(userId) ?? []).filter(t => now.getTime() - t < this.options.claimWindowMs);
    if (recent.length >= this.options.claimAttempts) throw pairingAttempts();
    const normalized = normalizeCode(code);
    const name = normalized.length === 8 ? await this.repository.claim(sha256(normalized), userId, now) : null;
    if (!name) {
      this.failures.set(userId, [...recent, now.getTime()]);
      throw notFound();
    }
    this.failures.delete(userId);
    return {device_name: name};
  }

  async list(userId: string): Promise<DevicesResponseV1> {
    const rows = await this.repository.list(userId);
    return {devices: rows.map(row => ({
      id: row.id, name: row.name, created_at: row.created_at.toISOString(), last_seen_at: row.last_seen_at?.toISOString() ?? null,
    }))};
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    if (!await this.repository.revoke(userId, deviceId, this.now())) throw notFound();
    this.logger.log(`device revoked device=${deviceId}`);
  }

  /** Credencial del robot → su dueño. null si no existe, tiene otro formato o fue revocada. */
  async authenticate(authorization: string | undefined): Promise<DeviceIdentity | null> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!TOKEN.test(token)) return null;
    const device = await this.repository.findByToken(sha256(token));
    if (!device) return null;
    const now = this.now();
    if (!device.last_seen_at || now.getTime() - device.last_seen_at.getTime() > 60_000) {
      void this.repository.touch(device.id, now).catch(() => this.logger.warn('device touch failed'));
    }
    return {deviceId: device.id, userId: device.user_id};
  }
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
