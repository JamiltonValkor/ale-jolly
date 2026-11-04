import {PostHogAssistantFlag, type FlagReader} from '../src/flags/assistant-flag';

const FLAG = 'sales-assistant-enabled';

function reader(...answers: Array<unknown | Error>): FlagReader & {calls: unknown[][]} {
  const calls: unknown[][] = [];
  return {
    calls,
    getFeatureFlag: async (...args: unknown[]) => {
      calls.push(args);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('PostHogAssistantFlag (bandera del lado servidor)', () => {
  it('consulta la bandera con el sub como distinct_id y sin emitir eventos', async () => {
    const source = reader(true);
    await expect(new PostHogAssistantFlag(source, FLAG, 30_000).isEnabled('user-1')).resolves.toBe(true);
    expect(source.calls).toEqual([[FLAG, 'user-1', {sendFeatureFlagEvents: false, disableGeoip: true}]]);
  });

  it('`false` no habilita y se reutiliza durante el TTL', async () => {
    let now = 0;
    const source = reader(false);
    const flag = new PostHogAssistantFlag(source, FLAG, 30_000, () => now);
    await expect(flag.isEnabled('user-1')).resolves.toBe(false);
    await expect(flag.isEnabled('user-1')).resolves.toBe(false);
    expect(source.calls).toHaveLength(1);
    now = 30_001;
    await flag.isEnabled('user-1');
    expect(source.calls).toHaveLength(2);
  });

  it('PostHog caído → 503 y no se guarda en caché', async () => {
    const source = reader(new Error('ECONNREFUSED'), true);
    const flag = new PostHogAssistantFlag(source, FLAG, 30_000);
    await expect(flag.isEnabled('user-1')).rejects.toMatchObject({code: 'FLAG_UNAVAILABLE', status: 503});
    await expect(flag.isEnabled('user-1')).resolves.toBe(true);
    expect(source.calls).toHaveLength(2);
  });

  it.each([undefined, null, 'control', 1, {}])('respuesta no booleana (%p) → 503 sin caché', async value => {
    const source = reader(value, true);
    const flag = new PostHogAssistantFlag(source, FLAG, 30_000);
    await expect(flag.isEnabled('user-1')).rejects.toMatchObject({code: 'FLAG_UNAVAILABLE', status: 503});
    await expect(flag.isEnabled('user-1')).resolves.toBe(true);
  });

  it('las consultas concurrentes del mismo usuario comparten una petición', async () => {
    const source = reader(true);
    const flag = new PostHogAssistantFlag(source, FLAG, 0);
    await Promise.all([flag.isEnabled('user-1'), flag.isEnabled('user-1')]);
    expect(source.calls).toHaveLength(1);
  });

  it('TTL 0 desactiva la caché', async () => {
    const source = reader(true);
    const flag = new PostHogAssistantFlag(source, FLAG, 0);
    await flag.isEnabled('user-1');
    await flag.isEnabled('user-1');
    expect(source.calls).toHaveLength(2);
  });
});
