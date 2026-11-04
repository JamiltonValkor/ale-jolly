import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hermesConfig, loadAgentBundle} from '../src/activation/hermes-files';
import {RestComputeClient, ComputeError} from '../src/compute/compute-client';
import {MetadataServerTokenSource, GcpTokenError} from '../src/compute/gcp-token';
import {instanceNameFor, insertRequestId, uuidv5} from '../src/compute/instance-name';
import {computeAppliedVersion, HERMES_KEYS, mergeMetadata, MetadataMergeError} from '../src/compute/metadata';
import {configuration} from '../src/config';
import {buildAuthorizeUrl, OAuthFlowSecrets, pkceChallenge} from '../src/oauth/authorize';
import {KeycloakTokenClient, OAuthTokenError} from '../src/oauth/token-client';
import {TEMPLATE_ITEMS} from './support/fakes';

type Call = {url: string; init: RequestInit};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({url: String(input), init});
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  };
  return {calls, fetcher};
}

describe('ack hermes/applied-version (contrato de vm/README.md)', () => {
  it('el orden de claves es el de KEYS en vm/startup-script.sh', () => {
    const script = readFileSync(join(__dirname, '..', 'vm', 'startup-script.sh'), 'utf8');
    const keys = /^KEYS="([^"]+)"/m.exec(script)?.[1]?.split(' ');
    expect(keys).toEqual([...HERMES_KEYS]);
  });

  it('coincide con el vector calculado como expected_version() de vm/test/watcher-test.sh', () => {
    // python3: sha256(''.join(f"{k} {sha256(v)}\n" for k in KEYS if k in md)) sobre estos items.
    const items = [
      {key: 'startup-script', value: '#!/bin/bash'},
      {key: 'hermes-soul', value: '# Alma\nÑandú ✓\n'},
      {key: 'hermes-api-key', value: 'k_aaaaaaaaaaaaaaaaaaaa'},
      {key: 'hermes-config', value: 'model: { provider: "openrouter", default: "openai/gpt-4o-mini" }'},
      {key: 'hermes-mcp-tokens', value: '{"tokens.json":{"access_token":"a"}}'},
      {key: 'hermes-bundle-version', value: 'saleads-sales-agent@1.1.0'},
    ];
    expect(computeAppliedVersion(items)).toBe('b02fc766afd28e8611cdf4679842c7fd2aab552467890dd4ffb93f7b8e9b3b00');
    // El orden de entrada no importa; sin claves hermes-* es sha256("").
    expect(computeAppliedVersion([...items].reverse())).toBe('b02fc766afd28e8611cdf4679842c7fd2aab552467890dd4ffb93f7b8e9b3b00');
    expect(computeAppliedVersion([{key: 'startup-script', value: 'x'}])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('merge de la metadata con la plantilla', () => {
  it('conserva todas las claves de la plantilla y agrega/reemplaza las hermes-*', () => {
    const template = [...TEMPLATE_ITEMS, {key: 'hermes-soul', value: 'viejo'}];
    const merged = mergeMetadata(template, {'hermes-soul': 'nuevo', 'hermes-api-key': 'k'.repeat(20)});
    expect(merged.map(item => item.key)).toEqual([...TEMPLATE_ITEMS.map(item => item.key), 'hermes-soul', 'hermes-api-key']);
    expect(merged.find(item => item.key === 'hermes-soul')?.value).toBe('nuevo');
    expect(merged.filter(item => item.key === 'hermes-soul')).toHaveLength(1);
  });

  it('rechaza claves fuera de la lista cerrada y plantillas sin startup-script', () => {
    expect(() => mergeMetadata(TEMPLATE_ITEMS, {'hermes-otra': 'x'} as never)).toThrow(MetadataMergeError);
    expect(() => mergeMetadata([{key: 'enable-oslogin', value: 'TRUE'}], {})).toThrow(/template_without_startup_script/);
  });
});

describe('nombres y requestId', () => {
  it('isolates Compute names and request deduplication for the same real owner', () => {
    expect(instanceNameFor('user-1', '')).toBe(instanceNameFor('user-1'));
    const meta = instanceNameFor('user-1', 'meta');
    expect(meta).toMatch(/^sa-assistant-[a-f0-9]{32}$/);
    expect(meta).toBe(instanceNameFor('user-1', 'meta'));
    expect(meta).not.toBe(instanceNameFor('user-1'));
    expect(meta).not.toBe(instanceNameFor('user-1', 'other'));
    for (const generation of [undefined, 1000]) {
      expect(insertRequestId('user-1', 1, generation, '')).toBe(insertRequestId('user-1', 1, generation));
      expect(insertRequestId('user-1', 1, generation, 'meta')).not.toBe(insertRequestId('user-1', 1, generation));
      expect(insertRequestId('user-1', 1, generation, 'meta')).toBe(insertRequestId('user-1', 1, generation, 'meta'));
    }
  });

  it("nombre = 'sa-assistant-' + sha256(user_id)[0:32], estable y válido para GCE y el CHECK de V1", () => {
    expect(instanceNameFor('user-1')).toBe(instanceNameFor('user-1'));
    expect(instanceNameFor('user-1')).toMatch(/^sa-assistant-[a-f0-9]{32}$/);
    expect(instanceNameFor('user-1')).not.toBe(instanceNameFor('user-2'));
  });

  it('UUIDv5 conforme (vector RFC 9562: DNS + www.example.com) y distinto por intento', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(insertRequestId('u', 1)).not.toBe(insertRequestId('u', 2));
    expect(insertRequestId('u', 1)).toBe(insertRequestId('u', 1));
    // OCB-012: otra generación (activación tras un borrado) no repite el requestId.
    expect(insertRequestId('u', 1, 1000)).not.toBe(insertRequestId('u', 1, 2000));
    expect(insertRequestId('u', 1, 1000)).toBe(insertRequestId('u', 1, 1000));
  });
});

describe('cliente REST de Compute', () => {
  const location = {
    project: 'saleads-dev', zone: 'us-central1-a', apiBase: 'https://compute.test/compute/v1',
    template: 'projects/saleads-dev/global/instanceTemplates/sa-assistant-oneclick-dev-20261015162357982000000001',
  };
  const tokens = {token: async () => 'gcp-token'};

  it('lee la metadata de la plantilla con GET', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {properties: {metadata: {items: TEMPLATE_ITEMS}}}));
    expect(await new RestComputeClient(location, tokens, fetcher).templateMetadata()).toEqual(TEMPLATE_ITEMS);
    expect(calls[0]!.url).toBe(`https://compute.test/compute/v1/${location.template}`);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer gcp-token');
  });

  it('insert manda solo nombre + metadata, con sourceInstanceTemplate y requestId', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {name: 'operation-123', status: 'RUNNING'}));
    const result = await new RestComputeClient(location, tokens, fetcher)
      .insertInstance({name: 'sa-assistant-x', items: TEMPLATE_ITEMS, requestId: insertRequestId('u', 1)});
    expect(result).toEqual({kind: 'created', operation: 'operation-123'});
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/compute/v1/projects/saleads-dev/zones/us-central1-a/instances');
    expect(Object.fromEntries(url.searchParams)).toEqual({sourceInstanceTemplate: location.template, requestId: insertRequestId('u', 1)});
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({name: 'sa-assistant-x', metadata: {items: TEMPLATE_ITEMS}});
  });

  it('409 alreadyExists = ya existe; otros errores salen sin el mensaje de GCP', async () => {
    const conflict = json(409, {error: {code: 409, message: "The resource 'x' already exists", errors: [{reason: 'alreadyExists'}]}});
    const {fetcher} = fakeFetch(conflict, json(403, {error: {message: 'secret-ish detail', errors: [{reason: 'forbidden'}]}}), new Error('ECONNRESET'));
    const client = new RestComputeClient(location, tokens, fetcher);
    const input = {name: 'sa-assistant-x', items: TEMPLATE_ITEMS, requestId: 'r'};
    expect(await client.insertInstance(input)).toEqual({kind: 'exists'});
    const forbidden = await client.insertInstance(input).catch(error => error);
    expect(forbidden).toBeInstanceOf(ComputeError);
    expect(forbidden).toMatchObject({status: 403, reason: 'forbidden'});
    expect(String(forbidden.message)).not.toContain('secret-ish');
    await expect(client.insertInstance(input)).rejects.toMatchObject({status: 0, reason: 'unavailable'});
  });

  it('lee el estado de la operación y sanea el código de error', async () => {
    const {calls, fetcher} = fakeFetch(
      json(200, {status: 'RUNNING'}),
      json(200, {status: 'DONE', error: {errors: [{code: 'QUOTA_EXCEEDED', message: 'x'}]}}),
      json(200, {status: 'DONE', error: {errors: [{code: 'bad code with spaces'}]}}),
    );
    const client = new RestComputeClient(location, tokens, fetcher);
    expect(await client.operationStatus('operation-1')).toEqual({done: false, errorReason: null});
    expect(await client.operationStatus('operation-1')).toEqual({done: true, errorReason: 'QUOTA_EXCEEDED'});
    expect(await client.operationStatus('operation-1')).toEqual({done: true, errorReason: 'other'});
    expect(calls[0]!.url).toBe('https://compute.test/compute/v1/projects/saleads-dev/zones/us-central1-a/operations/operation-1');
    await expect(client.operationStatus('../x')).rejects.toBeInstanceOf(ComputeError);
  });
});

describe('token de GCP por el metadata server (Workload Identity)', () => {
  it('pide el token con Metadata-Flavor y lo cachea hasta 60 s antes de vencer', async () => {
    let now = 1_000_000;
    const {calls, fetcher} = fakeFetch(json(200, {access_token: 't1', expires_in: 3600, token_type: 'Bearer'}),
      json(200, {access_token: 't2', expires_in: 3600, token_type: 'Bearer'}));
    const source = new MetadataServerTokenSource(fetcher, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', () => now);
    expect(await source.token()).toBe('t1');
    expect(await source.token()).toBe('t1');
    now += 3_541_000;
    expect(await source.token()).toBe('t2');
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('metadata-flavor')).toBe('Google');
  });

  it('un fallo es GcpTokenError sin detalle', async () => {
    const {fetcher} = fakeFetch(json(404, {}));
    await expect(new MetadataServerTokenSource(fetcher, 'http://m/token').token()).rejects.toBeInstanceOf(GcpTokenError);
  });
});

describe('token endpoint de Keycloak (cliente público + PKCE)', () => {
  const options = {
    tokenUrl: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/token',
    clientId: 'mcp-saleads-assistant-dev',
    redirectUri: 'https://dev.saleads.ai/api/sales-assistant/oauth/callback',
  };
  const ok = {access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 300, scope: 'openid offline_access'};

  it('canjea por el endpoint interno con code_verifier, redirect y client_id (sin secreto)', async () => {
    const {calls, fetcher} = fakeFetch(json(200, ok));
    const set = await new KeycloakTokenClient(options, fetcher).exchangeCode({code: 'c', verifier: 'v'});
    expect(set).toEqual({accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', scope: 'openid offline_access', expiresIn: 300});
    expect(calls[0]!.url).toBe(options.tokenUrl);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      grant_type: 'authorization_code', code: 'c', code_verifier: 'v', redirect_uri: options.redirectUri, client_id: options.clientId,
    });
  });

  it('refresh_token grant', async () => {
    const {calls, fetcher} = fakeFetch(json(200, ok));
    await new KeycloakTokenClient(options, fetcher).refresh('rt0');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      grant_type: 'refresh_token', refresh_token: 'rt0', client_id: options.clientId,
    });
  });

  it('400 → rejected con el código OAuth; 5xx, red y respuestas sin refresh → unavailable', async () => {
    const {fetcher} = fakeFetch(json(400, {error: 'invalid_grant', error_description: 'Code not valid'}), json(502, {}),
      new Error('ECONNREFUSED'), json(200, {...ok, refresh_token: undefined}));
    const client = new KeycloakTokenClient(options, fetcher);
    const rejected = await client.exchangeCode({code: 'c', verifier: 'v'}).catch(error => error);
    expect(rejected).toBeInstanceOf(OAuthTokenError);
    expect(rejected).toMatchObject({kind: 'rejected', reason: 'invalid_grant'});
    expect(String(rejected.message)).not.toContain('Code not valid');
    await expect(client.exchangeCode({code: 'c', verifier: 'v'})).rejects.toMatchObject({kind: 'unavailable', reason: 'http_502'});
    await expect(client.exchangeCode({code: 'c', verifier: 'v'})).rejects.toMatchObject({kind: 'unavailable', reason: 'network'});
    await expect(client.exchangeCode({code: 'c', verifier: 'v'})).rejects.toMatchObject({kind: 'unavailable', reason: 'invalid_response'});
  });
});

describe('authorize_url y secretos del flujo', () => {
  it('state y verifier dependen del usuario y de la key, y el verifier cumple RFC 7636', () => {
    const secrets = new OAuthFlowSecrets(Buffer.alloc(32, 1));
    const a = secrets.derive('u1', 'click-0001');
    expect(secrets.derive('u1', 'click-0001')).toEqual(a);
    expect(secrets.derive('u2', 'click-0001').state).not.toBe(a.state);
    expect(new OAuthFlowSecrets(Buffer.alloc(32, 2)).derive('u1', 'click-0001').state).not.toBe(a.state);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.verifier).not.toBe(a.state);
  });

  it('PKCE S256: vector del apéndice B de RFC 7636', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const url = new URL(buildAuthorizeUrl({authorizeUrl: 'https://kc.test/auth', clientId: 'c', redirectUri: 'https://r.test/cb', scope: 'openid'},
      {state: 's'.repeat(43), verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'}));
    expect(url.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(url.searchParams.get('prompt')).toBe('none');
  });
});

describe('config.yaml y bundle', () => {
  const mcp = {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid offline_access saleads-mcp'};

  it('config.yaml sin modelo (hasta OCB-010) con el MCP en auth: oauth, la zona (fallback America/Bogota) y approvals off', () => {
    expect(hermesConfig({mcp})).toBe([
      'mcp_servers:',
      '  saleads:',
      '    url: "https://dev.saleads.ai/mcp"',
      '    auth: oauth',
      '    oauth:',
      '      client_id: "mcp-saleads-assistant-dev"',
      '      scope: "openid offline_access saleads-mcp"',
      'timezone: "America/Bogota"',
      'approvals:',
      '  mode: "off"',
      'skills:',
      '  write_approval: true',
      'cron:',
      '  wrap_response: false',
      'display:',
      '  file_mutation_verifier: false',
      '',
    ].join('\n'));
    expect(hermesConfig({mcp, model: {provider: 'openrouter', model: 'openai/gpt-4o-mini'}, timezone: 'Europe/Madrid'}))
      .toMatch(/^model: \{ provider: "openrouter", default: "openai\/gpt-4o-mini" \}\nmcp_servers:[\s\S]*\ntimezone: "Europe\/Madrid"\n/);
  });

  it('el bundle 1.1.0 trae el SOUL y las 5 skills con rutas relativas a skills/, sin el README', () => {
    const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.1.0', 'saleads-sales-agent@1.1.0');
    const skills = JSON.parse(bundle.skills) as Record<string, string>;
    expect(Object.keys(skills).filter(path => path.endsWith('/SKILL.md'))).toHaveLength(5);
    expect(Object.keys(skills)).toEqual([...Object.keys(skills)].sort());
    expect(Object.keys(skills).every(path => /^saleads-[a-z-]+\/(SKILL\.md|references\/[a-z-]+\.md)$/.test(path))).toBe(true);
    expect(bundle.soul).toBe(readFileSync('distribution/saleads-sales-agent/1.1.0/SOUL.md', 'utf8'));
    expect(bundle.skills).not.toContain('Serialización');
  });
});

describe('configuración de OCB-007', () => {
  const base = {
    DATABASE_URL: 'postgresql://assistant:pw@127.0.0.1:5432/assistant_db',
    KEYCLOAK_ISSUER: 'https://keycloak-dev.saleads.ai/realms/sale-ads',
    KEYCLOAK_JWKS_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/certs',
    POSTHOG_API_KEY: 'phc_test',
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  };

  it('valores por defecto de dev: authorize público, token interno, MCP, plantilla real y zona', () => {
    expect(configuration(base)).toMatchObject({
      ASSISTANT_OAUTH_CLIENT_ID: 'mcp-saleads-assistant-dev',
      ASSISTANT_OAUTH_REDIRECT_URI: 'https://dev.saleads.ai/api/sales-assistant/oauth/callback',
      ASSISTANT_OAUTH_SCOPE: 'openid offline_access saleads-mcp saleads:read saleads:strategy saleads:campaigns saleads:launch saleads:events',
      KEYCLOAK_AUTHORIZE_URL: 'https://keycloak-dev.saleads.ai/realms/sale-ads/protocol/openid-connect/auth',
      KEYCLOAK_TOKEN_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/token',
      MCP_URL: 'https://dev.saleads.ai/mcp',
      GCP_PROJECT: 'saleads-dev',
      GCP_ZONE: 'us-central1-a',
      ASSISTANT_INSTANCE_TEMPLATE: 'projects/saleads-dev/global/instanceTemplates/sa-assistant-oneclick-dev-20261015162357982000000001',
    });
  });

  it('valida la plantilla y el MCP en https', () => {
    expect(() => configuration({...base, ASSISTANT_INSTANCE_TEMPLATE: 'global/instanceTemplates/x'})).toThrow(/ASSISTANT_INSTANCE_TEMPLATE/);
    expect(() => configuration({...base, MCP_URL: 'http://dev.saleads.ai/mcp'})).toThrow(/MCP_URL/);
  });
});
