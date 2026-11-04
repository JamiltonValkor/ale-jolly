import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CONTRACTS_V1_DIR, renderContractsV1} from '../src/contracts/json-schemas';
import {ActivationRequestV1, ActivationResponseV1, AiConfigRequestV1, AssistantStateV1, ErrorCodeV1, OAuthCallbackResponseV1, StreamEventV1, TimezoneRequestV1} from '../src/contracts/v1';

const dir = join(__dirname, '..', CONTRACTS_V1_DIR);

describe('contratos one-click v1', () => {
  it('contracts/one-click/v1 coincide con zod (sin deriva; regenerar con npm run contracts:generate)', () => {
    const expected = renderContractsV1();
    const onDisk = readdirSync(dir).filter(name => name.endsWith('.schema.json')).sort();
    expect(onDisk).toEqual(Object.keys(expected).sort());
    for (const [name, content] of Object.entries(expected)) expect(readFileSync(join(dir, name), 'utf8')).toBe(content);
  });

  it('el estado exige ready_since y los pasos del plan', () => {
    const state = {status: 'activating', step: 'installing_agent', slow: true, session_id: null,
      ai: {configured: false, provider: null, model: null}, ready_since: null, timezone: null};
    expect(AssistantStateV1.parse(state)).toEqual(state);
    expect(() => AssistantStateV1.parse({...state, ready_since: undefined})).toThrow();
    expect(() => AssistantStateV1.parse({...state, ready_at: null})).toThrow();
    expect(() => AssistantStateV1.parse({...state, step: 'booting'})).toThrow();
  });

  it('la activación devuelve authorize_url o el estado actual', () => {
    expect(ActivationResponseV1.parse({authorize_url: 'https://keycloak-dev.saleads.ai/realms/sale-ads/protocol/openid-connect/auth?x=1'})).toBeTruthy();
    expect(() => ActivationResponseV1.parse({authorize_url: 'javascript:alert(1)'})).toThrow();
    expect(OAuthCallbackResponseV1.parse({login_required: true})).toEqual({login_required: true});
  });

  it('la configuración de IA no admite campos extra y los eventos son el esquema v1', () => {
    expect(() => AiConfigRequestV1.parse({provider: 'openrouter', model: 'm', api_key: 'k', extra: 1})).toThrow();
    expect(StreamEventV1.parse({type: 'provider_error', reason: 'quota'})).toEqual({type: 'provider_error', reason: 'quota'});
    expect(() => StreamEventV1.parse({type: 'tool.failed'})).toThrow();
  });

  it('zona horaria (OCB-016): IANA válida por Intl y ≤ 64; evento y código de reinicio', () => {
    expect(TimezoneRequestV1.parse({timezone: 'America/Bogota'})).toEqual({timezone: 'America/Bogota'});
    expect(TimezoneRequestV1.parse({timezone: 'UTC'})).toEqual({timezone: 'UTC'});
    for (const timezone of ['Mars/Olympus', '', 'x'.repeat(65), '+05:00', 'America/Bogota\nmodel: x', '"; rm']) {
      expect(() => TimezoneRequestV1.parse({timezone})).toThrow();
    }
    expect(() => TimezoneRequestV1.parse({})).toThrow();
    expect(() => TimezoneRequestV1.parse({timezone: 'UTC', extra: 1})).toThrow();
    expect(ActivationRequestV1.parse({})).toEqual({});
    expect(ActivationRequestV1.parse({timezone: 'Europe/Madrid'})).toEqual({timezone: 'Europe/Madrid'});
    expect(() => ActivationRequestV1.parse({timezone: 'Nope/Nope'})).toThrow();
    expect(StreamEventV1.parse({type: 'assistant_restarting'})).toEqual({type: 'assistant_restarting'});
    expect(ErrorCodeV1.parse('ASSISTANT_RESTARTING')).toBe('ASSISTANT_RESTARTING');
  });
});
