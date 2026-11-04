import {randomUUID} from 'node:crypto';
import type {Operation} from '../store';
import {
  argsHash, conflict, isUuid, invalid, nowIso, structuredResult, text, ToolError, toolError, toolErrorResult,
  type ToolCallContext, type ToolDeps, type ToolResult,
} from './common';

/**
 * Operaciones asíncronas (contracts/async-operations.md): la tool crea u
 * obtiene la operación por `(usuario, tool, client_request_id | hash de args)`,
 * espera hasta `syncWaitMs` y devuelve el resultado final o
 * `{operation_id, status, poll_after_s}`. El trabajo se hace al crearla y su
 * estado pasa a terminal tras `asyncDelayMs` (duración simulada).
 */

const POLL_AFTER: Record<string, number> = {saleads_set_campaign_images: 5, saleads_prepare_campaign: 10};
const pollAfter = (tool: string) => POLL_AFTER[tool] ?? 15;

function visibleStatus(op: Operation): Operation['status'] {
  if (op.status === 'succeeded' || op.status === 'failed') return Date.now() >= op.ready_at ? op.status : 'running';
  return op.status;
}

export function envelope(op: Operation): Record<string, unknown> {
  const status = visibleStatus(op);
  const out: Record<string, unknown> = {operation_id: op.id, status};
  if (status === 'queued' || status === 'running') out.poll_after_s = op.poll_after_s;
  else if (status === 'succeeded') out.result = op.result ?? {};
  else out.error = op.error;
  return out;
}

function terminal(op: Operation): ToolResult {
  if (op.status === 'succeeded') return structuredResult(op.result ?? {});
  return toolErrorResult(op.error as never);
}

export interface AsyncOptions {
  /** Duración simulada; 0 = termina enseguida (escrituras deduplicadas no async). */
  delayMs?: number;
}

export async function runAsync(
  deps: ToolDeps, ctx: ToolCallContext, tool: string, args: Record<string, unknown>,
  work: () => Promise<Record<string, unknown>>, options: AsyncOptions = {},
): Promise<ToolResult> {
  const user = ctx.auth.userId;
  const crid = text(args.client_request_id);
  const hash = argsHash(args);
  const key = `${user}|${tool}|${crid || hash}`;
  const {state} = deps.store;
  let op = Object.values(state.operations).find((candidate) => candidate.key === key);
  if (op && op.args_hash !== hash) {
    throw conflict('Ese client_request_id ya se usó con otros argumentos.',
      'Usa un client_request_id nuevo para una acción distinta, o repite los mismos argumentos.', {reason: 'idempotency_key_reused'});
  }
  if (!op) {
    op = {
      id: randomUUID(), owner: user, tool, key, args_hash: hash, status: 'running', result: null, error: null,
      ready_at: Date.now() + (options.delayMs ?? deps.config.asyncDelayMs), poll_after_s: pollAfter(tool), created_at: nowIso(),
    };
    try {
      op.result = await work();
      op.status = 'succeeded';
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      op.error = error.payload as unknown as Record<string, unknown>;
      op.status = 'failed';
    }
    state.operations[op.id] = op;
    deps.store.save();
  }
  const remaining = op.ready_at - Date.now();
  if (remaining > deps.config.syncWaitMs) return structuredResult(envelope(op));
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return terminal(op);
}

/** `saleads_get_operation`: solo el dueño la ve; ajena o inexistente = MCP-E-OPERATION-NOT-FOUND. */
export async function getOperation(deps: ToolDeps, ctx: ToolCallContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isUuid(args.operation_id)) throw invalid('operation_id');
  const op = deps.store.state.operations[String(args.operation_id).toLowerCase()];
  if (!op || op.owner !== ctx.auth.userId) {
    throw toolError('MCP-E-OPERATION-NOT-FOUND', 'La operación no existe, expiró o no pertenece a este usuario.',
      'Vuelve a iniciar la acción con la tool original.');
  }
  return envelope(op);
}

/**
 * Escritura síncrona idempotente por `client_request_id`: la repetición con los
 * mismos argumentos devuelve la respuesta guardada; con otros, conflicto.
 */
export async function idempotent(
  deps: ToolDeps, ctx: ToolCallContext, tool: string, args: Record<string, unknown>,
  work: () => Promise<Record<string, unknown>>, replay: (stored: Record<string, unknown>) => Record<string, unknown> = (s) => s,
): Promise<Record<string, unknown>> {
  const crid = text(args.client_request_id);
  if (!crid) return work();
  const key = `${ctx.auth.userId}|${tool}|${crid}`;
  const hash = argsHash(args);
  const stored = deps.store.state.idempotent[key];
  if (stored) {
    if (stored.args_hash !== hash) {
      throw conflict('Ese client_request_id ya se usó con otros argumentos.',
        'Usa un client_request_id nuevo para una acción distinta.', {reason: 'idempotency_key_reused'});
    }
    return replay(stored.result);
  }
  const result = await work();
  deps.store.state.idempotent[key] = {args_hash: hash, result};
  deps.store.save();
  return result;
}
