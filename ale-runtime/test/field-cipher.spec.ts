import {FieldCipher, FieldCipherError} from '../src/security/field-cipher';

describe('FieldCipher (AES-256-GCM con AAD por tabla, columna y usuario)', () => {
  const cipher = new FieldCipher(Buffer.alloc(32, 1));

  it('cifra y descifra; el texto plano no aparece en el sobre', () => {
    const sealed = cipher.seal('assistant_credentials.refresh_token_enc', 'user-1', 'refresh-secret-value');
    expect(sealed[0]).toBe(1);
    expect(sealed.toString('utf8')).not.toContain('refresh-secret-value');
    expect(cipher.open('assistant_credentials.refresh_token_enc', 'user-1', sealed)).toBe('refresh-secret-value');
  });

  it('usa un nonce distinto en cada cifrado', () => {
    const a = cipher.seal('oauth_flows.verifier_enc', 'user-1', 'v');
    const b = cipher.seal('oauth_flows.verifier_enc', 'user-1', 'v');
    expect(a.equals(b)).toBe(false);
  });

  it('no abre un valor movido a otra columna o a otro usuario', () => {
    const sealed = cipher.seal('assistants.api_server_key_enc', 'user-1', 'api-server-key');
    expect(() => cipher.open('assistant_credentials.refresh_token_enc', 'user-1', sealed)).toThrow(FieldCipherError);
    expect(() => cipher.open('assistants.api_server_key_enc', 'user-2', sealed)).toThrow(FieldCipherError);
  });

  it('detecta manipulación y rechaza otra clave', () => {
    const sealed = cipher.seal('assistants.api_server_key_enc', 'user-1', 'api-server-key');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => cipher.open('assistants.api_server_key_enc', 'user-1', tampered)).toThrow(FieldCipherError);
    expect(() => new FieldCipher(Buffer.alloc(32, 2)).open('assistants.api_server_key_enc', 'user-1', sealed)).toThrow(FieldCipherError);
  });

  it('exige una clave de 32 bytes, texto no vacío y user_id válido', () => {
    expect(() => new FieldCipher(Buffer.alloc(16))).toThrow(FieldCipherError);
    expect(() => cipher.seal('oauth_flows.verifier_enc', 'user-1', '')).toThrow(FieldCipherError);
    expect(() => cipher.seal('oauth_flows.verifier_enc', '../x', 'v')).toThrow(FieldCipherError);
  });

  it('el error nunca lleva el valor', () => {
    try {cipher.open('oauth_flows.verifier_enc', 'user-1', Buffer.from('secret-material-xxxxxxxxxxxxxxxxxxxx'));}
    catch (error) {expect(String(error)).not.toContain('secret');}
  });
  it.each(['assistants.api_server_key_enc', 'assistant_credentials.refresh_token_enc', 'oauth_flows.verifier_enc'] as const)('keeps the 32 KiB credential boundary for %s', field => {
    const value = 'x'.repeat(32 * 1024);
    expect(cipher.open(field, 'user-1', cipher.seal(field, 'user-1', value))).toBe(value);
    expect(() => cipher.seal(field, 'user-1', value + 'x')).toThrow(FieldCipherError);
  });

  it.each([
    ['first_loop.turn', 4 * 1024 * 1024],
    ['first_loop.brief', 2 * 1024 * 1024],
    ['first_loop.projection', 16 * 1024 * 1024],
  ] as const)('supports a bounded larger JSON document for %s without weakening AAD', (field, limit) => {
    const value = JSON.stringify({synthetic: 'x'.repeat(40 * 1024)});
    const sealed = cipher.seal(field, 'user-1', value);
    expect(cipher.open(field, 'user-1', sealed)).toBe(value);
    expect(() => cipher.open(field, 'other-user', sealed)).toThrow(FieldCipherError);
    expect(() => cipher.open('assistants.api_server_key_enc', 'user-1', sealed)).toThrow(FieldCipherError);
    const boundary = 'x'.repeat(limit);
    expect(cipher.open(field, 'user-1', cipher.seal(field, 'user-1', boundary))).toBe(boundary);
    expect(() => cipher.seal(field, 'user-1', 'x'.repeat(limit + 1))).toThrow(FieldCipherError);
  });

});
