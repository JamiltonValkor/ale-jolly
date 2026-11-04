import {ComputeError, type ComputeApi, type InsertResult, type OperationStatus} from '../../src/compute/compute-client';
import type {MetadataItem} from '../../src/compute/metadata';
import {OAuthTokenError, type AssistantTokenSet, type OAuthTokenApi} from '../../src/oauth/token-client';

/** Metadata real de la plantilla de dev (claves; los valores son de prueba). */
export const TEMPLATE_ITEMS: MetadataItem[] = [
  {key: 'startup-script', value: '#!/bin/bash\necho hermes-vm\n'},
  {key: 'enable-guest-attributes', value: 'TRUE'},
  {key: 'enable-oslogin', value: 'TRUE'},
  {key: 'block-project-ssh-keys', value: 'TRUE'},
  {key: 'disable-legacy-endpoints', value: 'TRUE'},
  {key: 'serial-port-enable', value: 'FALSE'},
  {key: 'google-logging-enabled', value: 'true'},
  {key: 'google-monitoring-enabled', value: 'true'},
];

type Step = 'ok' | 'exists' | {status: number; reason: string} | {operationError: string} | 'pending';

/** Compute simulado: registra cada insert y responde según el guion. */
export class FakeCompute implements ComputeApi {
  readonly inserts: Array<{name: string; items: MetadataItem[]; requestId: string}> = [];
  templateCalls = 0;
  script: Step[] = [];
  template: MetadataItem[] = TEMPLATE_ITEMS;
  /** Pausa opcional dentro de insert para forzar carreras. */
  insertDelay?: () => Promise<void>;
  private readonly operations = new Map<string, OperationStatus>();

  async templateMetadata(): Promise<MetadataItem[]> {
    this.templateCalls++;
    return this.template.map(item => ({...item}));
  }

  async insertInstance(input: {name: string; items: MetadataItem[]; requestId: string}): Promise<InsertResult> {
    this.inserts.push(input);
    await this.insertDelay?.();
    const step = this.script.shift() ?? 'ok';
    if (step === 'exists') return {kind: 'exists'};
    if (typeof step === 'object' && 'status' in step) throw new ComputeError(step.status, step.reason);
    const operation = `operation-${this.inserts.length}`;
    this.operations.set(operation, step === 'pending' ? {done: false, errorReason: null}
      : typeof step === 'object' ? {done: true, errorReason: step.operationError} : {done: true, errorReason: null});
    return {kind: 'created', operation};
  }

  async operationStatus(operation: string): Promise<OperationStatus> {
    return this.operations.get(operation) ?? {done: true, errorReason: 'NOT_FOUND'};
  }
}

/** Token endpoint simulado. */
export class FakeTokens implements OAuthTokenApi {
  readonly exchanges: Array<{code: string; verifier: string}> = [];
  readonly refreshes: string[] = [];
  next: AssistantTokenSet | OAuthTokenError | null = null;
  refreshed: AssistantTokenSet | OAuthTokenError | null = null;

  async exchangeCode(input: {code: string; verifier: string}): Promise<AssistantTokenSet> {
    this.exchanges.push(input);
    if (!this.next) throw new OAuthTokenError('rejected', 'invalid_grant');
    if (this.next instanceof OAuthTokenError) throw this.next;
    return this.next;
  }

  async refresh(refreshToken: string): Promise<AssistantTokenSet> {
    this.refreshes.push(refreshToken);
    if (!this.refreshed) throw new OAuthTokenError('rejected', 'invalid_grant');
    if (this.refreshed instanceof OAuthTokenError) throw this.refreshed;
    return this.refreshed;
  }
}
