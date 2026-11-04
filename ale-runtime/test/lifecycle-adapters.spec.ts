import {createHash, generateKeyPairSync, sign, verify} from 'node:crypto';
import {ComputeError} from '../src/compute/compute-client';
import {configuration} from '../src/config';
import {RestLifecycleCompute} from '../src/lifecycle/lifecycle-compute';
import {
  archiveObjectName, ArchiveError, GcsArchiveStore, IamCredentialsSigner, signedPutUrlV4, type BlobSigner,
} from '../src/lifecycle/memory-archive';
import {outboundFetch} from '../src/outbound/http-client';
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
const tokens = {token: async () => 'gcp-token'};
const NOW = new Date('2026-10-27T16:25:18.000Z');

describe('signed URL V4 del archivo de memorias', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const signer: BlobSigner = {email: 'sa-assistant-service@saleads-dev.iam.gserviceaccount.com', sign: async payload => sign('sha256', payload, privateKey)};

  it('objeto <user_id>/<YYYYMMDDTHHMMSSZ>.tgz', () => {
    expect(archiveObjectName('f3c1a2b4-1111', NOW)).toBe('f3c1a2b4-1111/20261015T120000Z.tgz');
  });

  it('canonical request PUT con content-type application/gzip firmado y firma RSA-SHA256 verificable', async () => {
    const parts = await signedPutUrlV4({bucket: 'saleads-dev-assistant-memories', object: 'u:1/20261015T120000Z.tgz', now: NOW, ttlSeconds: 900, signer});
    const query = 'X-Goog-Algorithm=GOOG4-RSA-SHA256'
      + '&X-Goog-Credential=sa-assistant-service%40saleads-dev.iam.gserviceaccount.com%2F20261015%2Fauto%2Fstorage%2Fgoog4_request'
      + '&X-Goog-Date=20261015T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=content-type%3Bhost';
    const canonical = [
      'PUT', '/saleads-dev-assistant-memories/u%3A1/20261015T120000Z.tgz', query,
      'content-type:application/gzip', 'host:storage.googleapis.com', '', 'content-type;host', 'UNSIGNED-PAYLOAD',
    ].join('\n');
    expect(parts.canonicalRequest).toBe(canonical);
    const stringToSign = ['GOOG4-RSA-SHA256', '20261015T120000Z', '20261015/auto/storage/goog4_request',
      createHash('sha256').update(canonical).digest('hex')].join('\n');
    expect(parts.stringToSign).toBe(stringToSign);
    const url = new URL(parts.url);
    expect(url.origin + url.pathname).toBe('https://storage.googleapis.com/saleads-dev-assistant-memories/u%3A1/20261015T120000Z.tgz');
    const signature = url.searchParams.get('X-Goog-Signature')!;
    expect(signature).toMatch(/^[a-f0-9]{512}$/);
    expect(verify('sha256', Buffer.from(stringToSign), publicKey, Buffer.from(signature, 'hex'))).toBe(true);
  });

  it('signBlob de IAM Credentials con el token de WI y sin key local', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {keyId: 'k', signedBlob: Buffer.from('firma').toString('base64')}), json(403, {}));
    const iam = new IamCredentialsSigner('sa-assistant-service@saleads-dev.iam.gserviceaccount.com', 'https://iam.test/v1', tokens, fetcher);
    expect((await iam.sign(Buffer.from('hola'))).toString()).toBe('firma');
    expect(calls[0]!.url).toBe('https://iam.test/v1/projects/-/serviceAccounts/sa-assistant-service%40saleads-dev.iam.gserviceaccount.com:signBlob');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({payload: Buffer.from('hola').toString('base64')});
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer gcp-token');
    await expect(iam.sign(Buffer.from('x'))).rejects.toMatchObject({name: 'ArchiveError', reason: 'sign_http_403'});
  });

  it('GCS objects.get: 200 con tamaño = existe; 404 = todavía no; otros = error sin cuerpo', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {name: 'o', size: '1234'}), json(404, {}), json(500, {error: 'detalle'}));
    const store = new GcsArchiveStore('https://storage.test', tokens, fetcher);
    expect(await store.objectExists('saleads-dev-assistant-memories', 'u:1/20261015T120000Z.tgz')).toBe(true);
    expect(calls[0]!.url).toBe('https://storage.test/storage/v1/b/saleads-dev-assistant-memories/o/u%3A1%2F20261015T120000Z.tgz?fields=name,size');
    expect(await store.objectExists('b', 'o')).toBe(false);
    const error = await store.objectExists('b', 'o').catch(e => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect(error.message).not.toContain('detalle');
  });
});

describe('Compute del ciclo de vida (REST v1)', () => {
  const location = {project: 'saleads-dev', zone: 'us-central1-a', apiBase: 'https://compute.test/compute/v1', template: 'projects/saleads-dev/global/instanceTemplates/t'};
  const base = 'https://compute.test/compute/v1/projects/saleads-dev/zones/us-central1-a/instances/sa-assistant-abc';

  it('stop, start, setMetadata y delete por POST/DELETE, con User-Agent explícito', async () => {
    const {calls, fetcher} = fakeFetch(
      json(200, {name: 'op-stop'}), json(200, {name: 'op-start'}), json(200, {name: 'op-md'}), json(200, {name: 'op-del'}), json(404, {}),
    );
    const client = new RestLifecycleCompute(location, tokens, outboundFetch({userAgent: 'SaleADS-Assistant-Service/0.1', timeoutMs: 1000}, fetcher as typeof fetch));
    expect(await client.stopInstance('sa-assistant-abc')).toBe('op-stop');
    expect(await client.startInstance('sa-assistant-abc')).toBe('op-start');
    expect(await client.replaceMetadata('sa-assistant-abc', 'fp', TEMPLATE_ITEMS)).toBe('op-md');
    expect(await client.deleteInstance('sa-assistant-abc')).toBe('op-del');
    expect(await client.deleteInstance('sa-assistant-abc')).toBeNull();
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      `POST ${base}/stop`, `POST ${base}/start`, `POST ${base}/setMetadata`, `DELETE ${base}`, `DELETE ${base}`,
    ]);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({fingerprint: 'fp', items: TEMPLATE_ITEMS});
    for (const call of calls) expect(new Headers(call.init.headers).get('user-agent')).toBe('SaleADS-Assistant-Service/0.1');
  });

  it('instances.get: estado, fingerprint, items e IP privada; 404 = null', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {
      status: 'RUNNING', metadata: {fingerprint: 'abc=', items: [...TEMPLATE_ITEMS, {key: 'bad'}]},
      networkInterfaces: [{networkIP: '10.128.0.7'}],
    }), json(404, {}), json(200, {status: 'RUNNING', metadata: {}}));
    const client = new RestLifecycleCompute(location, tokens, fetcher);
    expect(await client.instanceInfo('sa-assistant-abc')).toEqual({status: 'RUNNING', fingerprint: 'abc=', items: TEMPLATE_ITEMS, privateIp: '10.128.0.7'});
    expect(calls[0]!.url).toBe(base);
    expect(await client.instanceInfo('sa-assistant-abc')).toBeNull();
    await expect(client.instanceInfo('sa-assistant-abc')).rejects.toMatchObject({status: 502, reason: 'invalid_instance'});
    await expect(client.instanceInfo('../x')).rejects.toBeInstanceOf(ComputeError);
  });

  it('guest attribute hermes/archive-status por getGuestAttributes; 404 = null', async () => {
    const {calls, fetcher} = fakeFetch(json(200, {queryValue: {items: [
      {namespace: 'hermes', key: 'applied-version', value: 'v'}, {namespace: 'hermes', key: 'archive-status', value: 'uploaded:0123456789ab'},
    ]}}), json(404, {}));
    const client = new RestLifecycleCompute(location, tokens, fetcher);
    expect(await client.guestAttribute('sa-assistant-abc', 'hermes', 'archive-status')).toBe('uploaded:0123456789ab');
    expect(calls[0]!.url).toBe(`${base}/getGuestAttributes?queryPath=hermes%2F`);
    expect(await client.guestAttribute('sa-assistant-abc', 'hermes', 'archive-status')).toBeNull();
  });
});

describe('configuración de OCB-012', () => {
  it('trae los valores de dev por defecto', () => {
    const config = configuration({
      DATABASE_URL: 'postgresql://assistant:pw@127.0.0.1:5432/assistant_db',
      KEYCLOAK_ISSUER: 'https://keycloak-dev.saleads.ai/realms/sale-ads',
      KEYCLOAK_JWKS_URL: 'http://keycloak.keycloak.svc.cluster.local:8080/realms/sale-ads/protocol/openid-connect/certs',
      POSTHOG_API_KEY: 'phc_test',
      FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    expect(config).toMatchObject({
      ASSISTANT_MEMORIES_BUCKET: 'saleads-dev-assistant-memories',
      ASSISTANT_SIGNER_EMAIL: 'sa-assistant-service@saleads-dev.iam.gserviceaccount.com',
      ARCHIVE_URL_TTL_SECONDS: 900, ARCHIVE_TIMEOUT_MS: 600_000, VM_DELETE_TIMEOUT_MS: 300_000,
    });
  });
});
