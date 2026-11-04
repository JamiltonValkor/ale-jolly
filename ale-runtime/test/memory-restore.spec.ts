import {Logger} from '@nestjs/common';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {Provisioner, type RestoreUrlSource} from '../src/activation/provisioner';
import {instanceNameFor} from '../src/compute/instance-name';
import {computeAppliedVersion} from '../src/compute/metadata';
import {ArchiveError, GcsObjectLister, latestArchiveObject} from '../src/lifecycle/memory-archive';
import type {OutboundFetch} from '../src/outbound/http-client';
import {AssistantRepository} from '../src/persistence/assistant-repository';
import {FieldCipher} from '../src/security/field-cipher';
import {FakeCompute, FakeTokens} from './support/fakes';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {USER_ID} from './support/tokens';

/**
 * D50: la VM nueva de un usuario recibe por `hermes-restore-url` un GET
 * firmado de su último archivo de memorias; el watcher lo restaura una vez
 * (vm/test/watcher-test.sh, sección 12).
 */
const SIGNED = 'https://storage.googleapis.com/b/u/20261019T000000Z.tgz?X-Goog-Signature=restore-SECRET';
const TOKENS = {accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer' as const, scope: 'openid', expiresIn: 300};

describe('último archivo de memorias del usuario (D50)', () => {
  it('elige el más reciente del usuario e ignora vacíos, anidados y otros objetos', () => {
    expect(latestArchiveObject('u1', [
      {name: 'u1/20261015T213903Z.tgz', size: 10},
      {name: 'u1/20261019T110000Z.tgz', size: 12},
      {name: 'u1/20261020T000000Z.tgz', size: 0},
      {name: 'u1/x/20261021T000000Z.tgz', size: 5},
      {name: 'u1/20261022T000000Z.tar', size: 5},
      {name: 'u10/20261023T000000Z.tgz', size: 5},
    ])).toBe('u1/20261019T110000Z.tgz');
    expect(latestArchiveObject('u1', [{name: 'seeds/u1/abc.json', size: 3}])).toBeNull();
  });

  it('lista por prefijo siguiendo las páginas y falla con ArchiveError', async () => {
    const urls: string[] = [];
    const pages = [
      {items: [{name: 'u1/20261015T213903Z.tgz', size: '10'}], nextPageToken: 'p2'},
      {items: [{name: 'u1/20261019T110000Z.tgz', size: '12'}]},
    ];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages.shift()), {status: 200});
    }) as unknown as OutboundFetch;
    const lister = new GcsObjectLister('https://storage.example', {token: async () => 'gcp'}, fetcher);
    await expect(lister.list('bucket', 'u1/')).resolves.toEqual([
      {name: 'u1/20261015T213903Z.tgz', size: 10}, {name: 'u1/20261019T110000Z.tgz', size: 12},
    ]);
    expect(urls[0]).toContain('/storage/v1/b/bucket/o?prefix=u1%2F');
    expect(urls[1]).toContain('pageToken=p2');

    const denied = (async () => new Response('no', {status: 403})) as unknown as OutboundFetch;
    await expect(new GcsObjectLister('https://storage.example', {token: async () => 'gcp'}, denied).list('bucket', 'u1/'))
      .rejects.toEqual(new ArchiveError('storage_http_403'));
  });
});

describe('la VM nueva recibe hermes-restore-url (D50)', () => {
  let db: TestDatabase;
  let repository: AssistantRepository;
  let compute: FakeCompute;
  let lines: string[];
  const cipher = new FieldCipher(Buffer.alloc(32, 7));
  const bundle = loadAgentBundle('distribution/saleads-sales-agent/1.1.0', 'saleads-sales-agent@1.1.0');

  beforeAll(async () => {db = await startTestDatabase();});
  afterAll(async () => {await db.close();});

  beforeEach(async () => {
    await db.database.pool.query('TRUNCATE assistant.assistants, assistant.assistant_events', []);
    await db.database.pool.query(
      `INSERT INTO assistant.assistants(user_id, status, step, activation_started_at) VALUES ($1, 'activating', 'preparing_environment', now())`, [USER_ID]);
    repository = new AssistantRepository(db.database);
    compute = new FakeCompute();
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {lines.push(args.map(String).join(' '));});
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const provision = async (restoreUrl?: RestoreUrlSource) => {
    const provisioner = new Provisioner({
      zone: 'us-central1-a', issuer: 'https://kc.example/realms/sale-ads',
      mcp: {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid'},
      bundle, operationTimeoutMs: 0, retryDelayMs: 0,
    }, {repository, compute, tokens: new FakeTokens(), cipher, restoreUrl});
    await provisioner.provision(USER_ID, TOKENS);
    const items = compute.inserts[0]!.items;
    const events = (await db.database.pool.query(
      'SELECT kind, detail_safe FROM assistant.assistant_events WHERE user_id = $1 ORDER BY id', [USER_ID])).rows as Array<{kind: string; detail_safe: string | null}>;
    return {items, events};
  };

  it('con archivo previo: la URL firmada va en la metadata del insert y cuenta en el ack', async () => {
    const asked: string[] = [];
    const {items, events} = await provision(async userId => {asked.push(userId); return SIGNED;});
    expect(asked).toEqual([USER_ID]);
    expect(items.find(item => item.key === 'hermes-restore-url')?.value).toBe(SIGNED);
    expect(computeAppliedVersion(items)).not.toBe(computeAppliedVersion(items.filter(item => item.key !== 'hermes-restore-url')));
    expect(events.map(event => event.kind)).toEqual(['restore.offered', 'vm.create_requested']);
    expect(lines.join('\n')).toContain(`restore offered instance=${instanceNameFor(USER_ID)}`);
    expect(JSON.stringify({lines, events})).not.toContain('restore-SECRET');
  });

  it('sin archivo previo: la VM nace sin la clave', async () => {
    const {items, events} = await provision(async () => null);
    expect(items.some(item => item.key === 'hermes-restore-url')).toBe(false);
    expect(events.map(event => event.kind)).toEqual(['restore.none', 'vm.create_requested']);
  });

  it('un fallo al buscar o firmar no frena la activación', async () => {
    const {items, events} = await provision(async () => {throw new ArchiveError('storage_http_503');});
    expect(compute.inserts).toHaveLength(1);
    expect(items.some(item => item.key === 'hermes-restore-url')).toBe(false);
    expect(events[0]).toEqual({kind: 'restore.lookup_failed', detail_safe: 'reason=storage_http_503'});
  });

  it('sin fuente configurada no se busca nada', async () => {
    const {items, events} = await provision();
    expect(items.some(item => item.key === 'hermes-restore-url')).toBe(false);
    expect(events.map(event => event.kind)).toEqual(['vm.create_requested']);
  });
});
