import {configuration} from '../src/config';
import {outboundFetch} from '../src/outbound/http-client';

const base = {
  DATABASE_URL: 'postgresql://assistant:pw@127.0.0.1:5432/assistant_db',
  KEYCLOAK_ISSUER: 'https://keycloak-dev.saleads.ai/realms/sale-ads',
  KEYCLOAK_JWKS_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/certs',
  POSTHOG_API_KEY: 'phc_test',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
};

describe('configuración', () => {
  it('acepta el JWKS interno por HTTP con otro origen que el issuer y aplica los valores por defecto', () => {
    const config = configuration(base);
    expect(config).toMatchObject({
      PORT: 8060, OIDC_AUDIENCE: '', OIDC_ALLOWED_CLIENTS: ['front'],
      ASSISTANT_FLAG_KEY: 'sales-assistant-enabled', ASSISTANT_FLAG_CACHE_TTL_MS: 30_000,
      POSTHOG_HOST: 'https://posthog.saleads.ai',
      ASSISTANT_RUNTIME_NAMESPACE: '',
      MANAGED_META_ENABLED: false, MANAGED_META_ALL_USERS: false, MANAGED_META_USER_ID: '',
      ORQA_SYNC_RETRY_AFTER_MS: 600_000,
    });
    expect(config.OUTBOUND_USER_AGENT).toMatch(/^SaleADS-Assistant-Service\//);
  });

  it('permite acortar la espera tras un sync de ORQA fallido, dentro de límites', () => {
    expect(configuration({...base, ORQA_SYNC_RETRY_AFTER_MS: '30000'}).ORQA_SYNC_RETRY_AFTER_MS).toBe(30_000);
    expect(() => configuration({...base, ORQA_SYNC_RETRY_AFTER_MS: '500'})).toThrow();
  });

  it('no exige un nombre de base fijo (sin el literal viejo /sa_assistant_dev)', () => {
    expect(configuration({...base, DATABASE_URL: 'postgres://assistant@127.0.0.1:5432/assistant_db'}).DATABASE_URL).toContain('assistant_db');
  });

  it('accepts a private runtime scope and rejects invalid scope input without exposing it', () => {
    expect(configuration({...base, ASSISTANT_RUNTIME_NAMESPACE: 'meta'}).ASSISTANT_RUNTIME_NAMESPACE).toBe('meta');
    for (const value of ['../other', 'x'.repeat(33), 'has space']) {
      expect(() => configuration({...base, ASSISTANT_RUNTIME_NAMESPACE: value})).toThrow(/^CONFIGURATION_INVALID: ASSISTANT_RUNTIME_NAMESPACE$/);
    }
  });

  it('requires a pilot subject by default and permits explicit all-account scope without a pilot identity', () => {
    const managed = {...base, MANAGED_META_ENABLED: 'true', MANAGED_META_API_KEY: 'synthetic-private-key'};
    expect(() => configuration(managed)).toThrow('CONFIGURATION_INVALID: MANAGED_META_USER_ID');
    expect(configuration({...managed, MANAGED_META_USER_ID: 'pilot-owner'})).toMatchObject({
      MANAGED_META_ALL_USERS: false, MANAGED_META_USER_ID: 'pilot-owner',
    });
    const allUsers = {...managed, MANAGED_META_ALL_USERS: 'true', MANAGED_META_RELAY_BASE_URL: 'https://app.example.invalid/inference/v1/'};
    expect(configuration(allUsers)).toMatchObject({
      MANAGED_META_ALL_USERS: true, MANAGED_META_USER_ID: '',
      MANAGED_META_RELAY_BASE_URL: 'https://app.example.invalid/inference/v1',
    });
    expect(() => configuration({...managed, MANAGED_META_ALL_USERS: 'true'})).toThrow('CONFIGURATION_INVALID: MANAGED_META_RELAY_BASE_URL');
    expect(() => configuration({...base, MANAGED_META_ENABLED: 'true', MANAGED_META_ALL_USERS: 'true'}))
      .toThrow('CONFIGURATION_INVALID: MANAGED_META_API_KEY,MANAGED_META_RELAY_BASE_URL');
    for (const invalid of ['http://app.example.invalid/v1', 'https://key@app.example.invalid/v1', 'https://app.example.invalid/v1?key=value', 'https://app.example.invalid/v1#fragment']) {
      expect(() => configuration({...allUsers, MANAGED_META_RELAY_BASE_URL: invalid})).toThrow('CONFIGURATION_INVALID: MANAGED_META_RELAY_BASE_URL');
    }
    expect(() => configuration({...base, MANAGED_META_ALL_USERS: '*'})).toThrow('CONFIGURATION_INVALID: MANAGED_META_ALL_USERS');
  });

  it('falla sin revelar valores', () => {
    expect(() => configuration({...base, FIELD_ENCRYPTION_KEY: 'c2hvcnQ='})).toThrow(/^CONFIGURATION_INVALID: FIELD_ENCRYPTION_KEY$/);
    expect(() => configuration({...base, KEYCLOAK_ISSUER: 'http://keycloak-dev.saleads.ai/realms/sale-ads'})).toThrow(/KEYCLOAK_ISSUER/);
    try {configuration({...base, POSTHOG_API_KEY: ''});} catch (error) {expect(String(error)).not.toContain('phc_');}
  });
});

describe('cliente HTTP saliente', () => {
  it('manda siempre el User-Agent explícito (Cloudflare da 403 al UA por defecto)', async () => {
    const base = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'));
    const fetcher = outboundFetch({userAgent: 'SaleADS-Assistant-Service/0.1', timeoutMs: 1000}, base as unknown as typeof fetch);
    await fetcher('https://dev.saleads.ai/mcp', {headers: {'User-Agent': 'python-requests/2', accept: 'application/json'}});
    const init = base.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('SaleADS-Assistant-Service/0.1');
    expect(headers.get('accept')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('corta la llamada al vencer el timeout', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
    await expect(outboundFetch({userAgent: 'SaleADS-Assistant-Service/0.1', timeoutMs: 20}, hanging)('https://x.test')).rejects.toBeDefined();
  });
});
