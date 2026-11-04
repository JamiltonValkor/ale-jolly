import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

/**
 * Cifrado de campos en reposo (AES-256-GCM). Adaptado del sobre de
 * 9282e1b:src/security/mcp-grant-vault.ts:38-113 sin épocas, scopes ni
 * llaveros: una clave del ExternalSecret y AAD `assistant:<tabla>.<columna>:<user_id>`,
 * de modo que un valor no se puede mover a otra columna ni a otro usuario.
 *
 * Formato (bytea): versión(1)=0x01 | nonce(12) | tag(16) | ciphertext.
 */
export type EncryptedField =
  | 'notifications.payload'
  | 'notifications.receipt'
  | 'first_loop.brief'
  | 'first_loop.turn'
  | 'first_loop.projection'
  | 'assistants.api_server_key_enc'
  | 'assistant_credentials.refresh_token_enc'
  | 'oauth_flows.verifier_enc';

export class FieldCipherError extends Error {
  constructor() {super('FIELD_CIPHER_FAILED'); this.name = 'FieldCipherError';}
}

const VERSION = 1;
const HEADER = 1 + 12 + 16;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_PLAINTEXT = 32 * 1024;
// First-loop JSON documents are larger than credentials. Keep independent bounds:
// the projection limit matches its existing decompressed snapshot ceiling.
const FIRST_LOOP_PLAINTEXT_LIMITS: Partial<Record<EncryptedField, number>> = {
  'notifications.payload': 128 * 1024,
  'first_loop.brief': 2 * 1024 * 1024,
  'first_loop.turn': 4 * 1024 * 1024,
  'first_loop.projection': 16 * 1024 * 1024,
};

export class FieldCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new FieldCipherError();
    this.key = Buffer.from(key);
  }

  static fromBase64(value: string): FieldCipher {
    return new FieldCipher(Buffer.from(value, 'base64'));
  }

  seal(field: EncryptedField, userId: string, plaintext: string): Buffer {
    try {
      const bytes = Buffer.from(plaintext, 'utf8');
      if (!bytes.byteLength || bytes.byteLength > (FIRST_LOOP_PLAINTEXT_LIMITS[field] ?? MAX_PLAINTEXT)) throw new Error();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(aad(field, userId));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      bytes.fill(0);
      return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
    } catch {
      throw new FieldCipherError();
    }
  }

  open(field: EncryptedField, userId: string, sealed: Buffer): string {
    try {
      if (!Buffer.isBuffer(sealed) || sealed.length <= HEADER || sealed[0] !== VERSION) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(1, 13));
      decipher.setAAD(aad(field, userId));
      decipher.setAuthTag(sealed.subarray(13, HEADER));
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(HEADER)), decipher.final()]);
      try {return plaintext.toString('utf8');} finally {plaintext.fill(0);}
    } catch {
      throw new FieldCipherError();
    }
  }
}

function aad(field: EncryptedField, userId: string): Buffer {
  if (!USER_ID.test(userId)) throw new Error();
  return Buffer.from(`assistant:${field}:${userId}`, 'utf8');
}
