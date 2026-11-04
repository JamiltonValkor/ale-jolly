import type {AiConfigService} from '../src/ai/ai-config.service';
import {ManagedMetaBootstrap, ManagedMetaStateReader} from '../src/ai/managed-meta';
import {META_MODEL_ID, META_PROVIDER_ID} from '../src/ai/meta-model';
import type {AssistantStateV1} from '../src/contracts/v1';
import {AiController} from '../src/http/ai.controller';
import type {AuthenticatedRequest} from '../src/http/auth.guard';

const USER = 'example-owner';
const options = {enabled: true, userId: USER, apiKey: 'synthetic-meta-key', retryAfterMs: 1000};
const readyRow = {status: 'ready' as const, step: null, instance_name: 'example-instance'};
const state = (): AssistantStateV1 => ({
  status: 'ready', step: null, slow: false, session_id: 'existing-conversation',
  ai: {configured: true, provider: 'openrouter', model: 'existing-legacy-model'},
  ready_since: '2027-08-21T00:00:00Z', timezone: 'America/Bogota',
});

describe('automatic managed Meta setup', () => {
  it('restores previously configured inference after a control-plane restart without writing or probing again', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const reconcile = jest.fn(async () => 'ready' as const);
    const deps = {read: async () => readyRow, configure, reconcile};
    const current = {...state(), ai: {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}};

    for (let restart = 0; restart < 2; restart++) {
      const meta = new ManagedMetaBootstrap(options, deps);
      const reader = new ManagedMetaStateReader({read: async () => current}, meta);
      expect(await reader.read(USER)).toEqual(current);
      await meta.idle();
      expect(await reader.read(USER)).toEqual(current);
      expect(meta.isReady(USER, current.ai)).toBe(true);
      // A normal poll and a direct bootstrap request must also remain read-only.
      meta.request(USER);
      await meta.idle();
    }
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(USER, options.apiKey);
    expect(configure).not.toHaveBeenCalled();
  });

  it('invalidates restored readiness when persisted inference is no longer configured', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const reconcile = jest.fn(async () => 'ready' as const);
    const meta = new ManagedMetaBootstrap(options, {read: async () => readyRow, configure, reconcile});
    meta.request(USER);
    await meta.idle();
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(true);
    expect(meta.isReady(USER, {configured: false, provider: null, model: null})).toBe(false);
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
  });

  it('waits for transient reconciliation failures without replaying configuration', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const reconcile = jest.fn(async () => 'deferred' as const);
    const deps = {read: async () => readyRow, configure, reconcile};
    const meta = new ManagedMetaBootstrap(options, deps);
    meta.request(USER);
    await meta.idle();
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });

  it('bounds the first state read while a read-only reconciliation remains unavailable', async () => {
    let finish!: (value: 'ready') => void;
    const reconcile = jest.fn(() => new Promise<'ready'>(resolve => {finish = resolve;}));
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const meta = new ManagedMetaBootstrap({...options, reconciliationTimeoutMs: 10},
      {read: async () => readyRow, configure, reconcile});
    const current = {...state(), ai: {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}};
    const reader = new ManagedMetaStateReader({read: async () => current}, meta);
    expect(await reader.read(USER)).toMatchObject({status: 'activating', step: 'configure_ai'});
    expect(configure).not.toHaveBeenCalled();
    finish('ready');
    await meta.idle();
    expect(await reader.read(USER)).toEqual(current);
  });

  it('still performs setup when reconciliation identifies a provider, credential or transport migration', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const reconcile = jest.fn(async () => 'configure' as const);
    const deps = {read: async () => readyRow, configure, reconcile};
    const meta = new ManagedMetaBootstrap(options, deps);
    meta.request(USER);
    await meta.idle();
    expect(reconcile).toHaveBeenCalledWith(USER, options.apiKey);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(true);
  });

  it('never waits for inference when the read-only stage identifies a required setup', async () => {
    let finish!: (value: {result: 'ok'}) => void;
    const configure = jest.fn(() => new Promise<{result: 'ok'}>(resolve => {finish = resolve;}));
    const meta = new ManagedMetaBootstrap(options, {read: async () => readyRow, configure,
      reconcile: async () => 'configure'});
    expect(await new ManagedMetaStateReader({read: async () => state()}, meta).read(USER))
      .toMatchObject({status: 'activating', step: 'configure_ai'});
    expect(configure).toHaveBeenCalledTimes(1);
    finish({result: 'ok'});
    await meta.idle();
  });

  it('keeps state reads responsive and deduplicates setup until a real probe succeeds', async () => {
    let finish!: (value: {result: 'ok'}) => void;
    const probe = new Promise<{result: 'ok'}>(resolve => {finish = resolve;});
    const configure = jest.fn(() => probe);
    const meta = new ManagedMetaBootstrap(options, {read: async () => readyRow, configure});
    let current = state();
    const reader = new ManagedMetaStateReader({read: async () => current}, meta);
    expect(await reader.read(USER)).toMatchObject({status: 'activating', ai: {configured: false}, session_id: 'existing-conversation'});
    await reader.read(USER);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(USER, {provider: META_PROVIDER_ID, model: META_MODEL_ID, api_key: options.apiKey});
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
    finish({result: 'ok'});
    await meta.idle();
    current = {...current, ai: {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID}};
    expect(await reader.read(USER)).toEqual(current);
  });

  it('does not distribute this assistant credential to another user', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const meta = new ManagedMetaBootstrap(options, {read: async () => readyRow, configure});
    meta.request('another-owner');
    await meta.idle();
    expect(configure).not.toHaveBeenCalled();
    const legacy = state();
    expect(await new ManagedMetaStateReader({read: async () => legacy}, meta).read('another-owner')).toEqual(legacy);
    expect(meta.isReady('another-owner', legacy.ai)).toBe(true);
  });

  it('prepares two managed accounts independently using only their account-bound credentials', async () => {
    const other = 'unrelated-owner';
    const read = jest.fn(async (userId: string) => ({...readyRow, instance_name: 'vm-' + userId}));
    const configure = jest.fn(async (_userId: string, _input: unknown) => ({result: 'ok' as const}));
    const credentialForUser = jest.fn(async (userId: string) => 'relay-credential-' + userId);
    const meta = new ManagedMetaBootstrap({...options, allUsers: true}, {read, configure, credentialForUser});
    meta.request(USER); meta.request(other); meta.request(other);
    await meta.idle();
    expect(configure.mock.calls).toEqual([USER, other].map(userId => [userId, {
      provider: META_PROVIDER_ID, model: META_MODEL_ID, api_key: 'relay-credential-' + userId,
    }]));
    expect(configure.mock.calls.flat()).not.toContain(options.apiKey);
    for (const userId of [USER, other]) {
      expect(read).toHaveBeenCalledWith(userId);
      expect(credentialForUser).toHaveBeenCalledWith(userId);
      expect(meta.isReady(userId, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(true);
    }
    expect(meta.isReady('not-prepared', {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
  });

  it('never copies the pilot upstream key when all-account inference transport is unavailable', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const meta = new ManagedMetaBootstrap({...options, allUsers: true}, {read: async () => readyRow, configure});
    meta.request(USER); meta.request('another-owner'); meta.request('');
    await meta.idle();
    expect(configure).not.toHaveBeenCalled();
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
  });

  it('keeps a rejected setup unavailable and backs off repeated requests', async () => {
    let now = 0;
    const configure = jest.fn(async () => ({result: 'invalid_key' as const}));
    const meta = new ManagedMetaBootstrap(options, {read: async () => readyRow, configure, now: () => now});
    meta.request(USER);
    await meta.idle();
    meta.request(USER);
    await meta.idle();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(meta.isReady(USER, {configured: true, provider: META_PROVIDER_ID, model: META_MODEL_ID})).toBe(false);
    now = 1001;
    meta.request(USER);
    await meta.idle();
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('does not configure or rewrite an assistant that is stopped', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const meta = new ManagedMetaBootstrap(options, {read: async () => ({...readyRow, status: 'stopped'}), configure});
    const stopped: AssistantStateV1 = {...state(), status: 'stopped'};
    const reader = new ManagedMetaStateReader({read: async () => stopped}, meta);
    expect(await reader.read(USER)).toEqual(stopped);
    expect(configure).not.toHaveBeenCalled();
  });

  it('leaves the legacy deployment unchanged when managed mode is disabled', async () => {
    const configure = jest.fn(async () => ({result: 'ok' as const}));
    const meta = new ManagedMetaBootstrap({...options, enabled: false}, {read: async () => readyRow, configure});
    const existing = state();
    expect(await new ManagedMetaStateReader({read: async () => existing}, meta).read(USER)).toEqual(existing);
    expect(configure).not.toHaveBeenCalled();
  });

  it('rejects browser provider/key configuration in managed mode', async () => {
    const configure = jest.fn();
    const controller = new AiController({configure} as unknown as AiConfigService, options);
    const request = {principal: {userId: USER, clientId: 'front'}} as AuthenticatedRequest;
    expect(controller.providers(request)).toEqual([{id: META_PROVIDER_ID, label: 'Meta Model API', needs_key: false}]);
    expect(controller.providers({principal: {userId: 'another-owner', clientId: 'front'}} as AuthenticatedRequest))
      .toContainEqual({id: 'openrouter', label: 'OpenRouter', needs_key: true});
    await expect(controller.configure(request, {provider: 'openrouter'})).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    expect(configure).not.toHaveBeenCalled();
  });
});
