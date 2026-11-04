import {createHmac, timingSafeEqual} from 'node:crypto';
import type {AssistantFlag} from '../domain/ports';
import {assistantNotEnabled, invalidRequest, ServiceError, serviceUnavailable, unauthorized} from '../domain/errors';
import type {OutboundFetch} from '../outbound/http-client';
import type {AssistantRepository, AssistantRow} from '../persistence/assistant-repository';
import type {FieldCipher} from '../security/field-cipher';
import {isManagedMetaUser, MAX_META_RELAY_BODY_BYTES, META_API_BASE_URL, META_MODEL_ID, type ManagedMetaScope} from './meta-model';

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const AUTH = /^Bearer mr1\.([A-Za-z0-9_-]{1,214})\.([A-Za-z0-9_-]{43})$/;
const NAMESPACE = 'saleads-managed-meta-inference/1\0';
const hasAssistantCredential = (row: AssistantRow | null, owner: string): row is AssistantRow => !!row && row.user_id === owner &&
  !!row.instance_name && !!row.api_server_key_enc;
const canIssueCredential = (row: AssistantRow | null, owner: string): row is AssistantRow => hasAssistantCredential(row, owner) &&
  (row.status === 'ready' || row.status === 'activating' && row.step === 'configure_ai');
// AI configuration restarts Hermes: readiness may regress before the already-credentialed probe arrives.
const canUseCredential = (row: AssistantRow | null, owner: string): row is AssistantRow => hasAssistantCredential(row, owner) &&
  (row.status === 'ready' || row.status === 'activating' && (row.step === 'configure_ai' || row.step === 'installing_agent'));
const signature = (owner: string, secret: string): Buffer => createHmac('sha256', secret).update(NAMESPACE).update(owner).digest();
const credential = (owner: string, secret: string): string => `mr1.${Buffer.from(owner).toString('base64url')}.${signature(owner, secret).toString('base64url')}`;

export interface MetaRelayOptions {
  scope: ManagedMetaScope;
  /** Remains in this control service; it is never a VM or browser credential. */
  apiKey: string;
  timeoutMs: number;
}
export interface MetaRelayDeps {
  repository: Pick<AssistantRepository, 'findActive'>;
  cipher: FieldCipher;
  flag: AssistantFlag;
  fetcher: OutboundFetch;
}

/** Fixed, stateless Meta Responses transport. It grants no SaleADS business or VM-control operation. */
export class MetaInferenceRelay {
  constructor(private readonly options: MetaRelayOptions, private readonly deps: MetaRelayDeps) {}

  async credentialForUser(owner: string): Promise<string | null> {
    if (!SUBJECT.test(owner) || !isManagedMetaUser(this.options.scope, owner) || !this.options.apiKey) return null;
    const row = await this.deps.repository.findActive(owner);
    if (!canIssueCredential(row, owner) || !await this.deps.flag.isEnabled(owner)) return null;
    const secret = this.deps.cipher.open('assistants.api_server_key_enc', owner, row.api_server_key_enc!);
    return credential(owner, secret);
  }

  private async authorize(authorization: unknown): Promise<void> {
    const match = typeof authorization === 'string' ? AUTH.exec(authorization) : null;
    if (!match || !this.options.apiKey) throw unauthorized();
    const owner = Buffer.from(match[1]!, 'base64url').toString('utf8');
    if (!SUBJECT.test(owner) || Buffer.from(owner).toString('base64url') !== match[1] || !isManagedMetaUser(this.options.scope, owner)) throw unauthorized();
    const row = await this.deps.repository.findActive(owner);
    if (!canUseCredential(row, owner)) throw unauthorized();
    const secret = this.deps.cipher.open('assistants.api_server_key_enc', owner, row.api_server_key_enc!);
    const received = Buffer.from(match[2]!, 'base64url');
    const expected = signature(owner, secret);
    if (received.length !== expected.length || received.toString('base64url') !== match[2] || !timingSafeEqual(received, expected)) throw unauthorized();
    if (!await this.deps.flag.isEnabled(owner)) throw assistantNotEnabled();
  }

  async responses(authorization: unknown, raw: unknown, signal: AbortSignal): Promise<Response> {
    await this.authorize(authorization);
    const body = statelessRequest(raw);
    if (signal.aborted) throw serviceUnavailable();
    let response: Response;
    try {
      response = await this.deps.fetcher(`${META_API_BASE_URL}/responses`, {
        method: 'POST', redirect: 'error',
        headers: {authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json',
          accept: body.stream === true ? 'text/event-stream' : 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      });
    } catch {throw serviceUnavailable();}
    const expectedType = body.stream === true ? 'text/event-stream' : 'application/json';
    if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== expectedType) {
      await response.body?.cancel().catch(() => undefined);
      // Provider error bodies may contain request content or credentials. Never read, forward or log them.
      throw new ServiceError('SERVICE_UNAVAILABLE', response.status === 429 ? 429 : 502);
    }
    return response;
  }
}

function statelessRequest(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRequest();
  const body = raw as Record<string, unknown>;
  if (body.model !== META_MODEL_ID || (body.stream !== undefined && typeof body.stream !== 'boolean') ||
    body.previous_response_id != null || body.conversation != null || (body.background !== undefined && body.background !== false)) throw invalidRequest();
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => !tool || typeof tool !== 'object' ||
    !['function', 'web_search'].includes((tool as {type?: string}).type ?? '')))) throw invalidRequest();
  // Hermes sends its own full transcript. Stored provider item/file references could cross owners sharing the upstream key.
  const pending: unknown[] = [body.input];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {for (const child of value) pending.push(child);}
    else if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      if (item.type === 'item_reference' || item.file_id != null) throw invalidRequest();
      for (const child of Object.values(item)) pending.push(child);
    }
  }
  const result = {...body, store: false};
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_META_RELAY_BODY_BYTES) throw new ServiceError('INVALID_REQUEST', 413);
  return result;
}
