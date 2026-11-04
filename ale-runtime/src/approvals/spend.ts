import {createHash} from 'node:crypto';
import type {ApprovalDetailsV1, ApprovalItemV1, ApprovalKindV1, ApprovalParamsV1} from '../contracts/v1';
import {invalidRequest, notFound} from '../domain/errors';
import type {ApprovalRow} from './approvals-repository';
import type {ApprovalExecutor} from './approvals.service';
import {downstreamCode, type SaleadsServicesClient, ServicesUnavailableError} from './saleads-services';

/**
 * Aprobaciones de gasto (MLB-013): resolver el recurso (plan o campaña), saber
 * si cambió desde la propuesta y ejecutar con los endpoints que usa la web.
 */
export type SpendKind = Extract<ApprovalKindV1, 'launch_plan' | 'pause_campaign' | 'change_budget' | 'resume_campaign'>;
export const SPEND: readonly SpendKind[] = ['launch_plan', 'pause_campaign', 'change_budget', 'resume_campaign'];
export const isSpendKind = (kind: ApprovalKindV1): kind is SpendKind => (SPEND as readonly string[]).includes(kind);

const PLAN_KINDS: readonly SpendKind[] = ['launch_plan', 'change_budget'];
/** Estados de un plan que ya gastó o se lanzó: su presupuesto no cambia desde aquí (D50). */
const LAUNCHED_PLAN = new Set(['launched', 'active', 'running', 'paused', 'completed']);

export interface SpendResource {
  item: ApprovalItemV1;
  details: ApprovalDetailsV1;
}

const str = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** `item_version` = versión del recurso + sha256(params) truncado: dos montos distintos son dos aprobaciones. */
export function spendVersion(resourceVersion: string, params: ApprovalParamsV1 | undefined): string {
  const hash = createHash('sha256').update(JSON.stringify(params ?? {})).digest('hex').slice(0, 16);
  return `${resourceVersion.slice(0, 47)}#${hash}`;
}

const resourceOf = (version: string) => version.split('#')[0] ?? '';

function money(value: {amount: number; currency: string}): string {
  return `${value.amount.toLocaleString('es-CO')} ${value.currency}`;
}

export class SpendActions {
  constructor(private readonly services: SaleadsServicesClient) {}

  private async plan(userId: string, planId: string): Promise<{plan: Record<string, unknown>; etag: string | null}> {
    const res = await this.services.call({service: 'strategy', method: 'GET', path: `/api/strategy/plan/${planId}`, userId});
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status >= 400) throw new ServicesUnavailableError(`strategy_${res.status}`);
    const plan = record(record(res.body)['plan']);
    if (str(plan['plan_id'], 64) !== planId) throw notFound();
    return {plan, etag: res.etag};
  }

  private async campaign(userId: string, campaignId: string): Promise<Record<string, unknown>> {
    const res = await this.services.call({service: 'campaign', method: 'GET', path: `/campaigns/${campaignId}`, userId});
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status >= 400) throw new ServicesUnavailableError(`campaign_${res.status}`);
    const data = record(record(res.body)['data']);
    const campaign = {...data, ...record(data['campaign'])};
    if ((str(campaign['campaign_id'], 64) ?? str(campaign['id'], 64)) !== campaignId) throw notFound();
    if (campaign['user_id'] !== undefined && campaign['user_id'] !== userId) throw notFound();
    return campaign;
  }

  /** Recurso del negocio del dueño, o 404. Arma el ítem y los detalles que verá el dueño. */
  async resolve(input: {userId: string; businessId: string; kind: SpendKind; itemId: string; params?: ApprovalParamsV1}): Promise<SpendResource> {
    const {userId, businessId, kind, itemId, params} = input;
    if (PLAN_KINDS.includes(kind)) {
      const {plan} = await this.plan(userId, itemId);
      if (str(plan['business_id'], 64) !== businessId) throw notFound();
      const status = str(plan['status'], 30) ?? 'unknown';
      if (kind === 'change_budget' && LAUNCHED_PLAN.has(status)) throw invalidRequest();
      const name = str(plan['name'], 120) ?? str(plan['plan_name'], 120) ?? 'Plan estratégico';
      const updated = str(plan['updated_at'], 40) ?? status;
      const summary = kind === 'launch_plan'
        ? `Lanzar el plan «${name}»${params?.campaign_ids ? ` (${params.campaign_ids.length} campañas)` : ''}: empieza a gastar en Meta.`
        : `Cambiar el presupuesto mensual del plan «${name}» a ${money(params!.monthly_budget!)}.`;
      return {
        item: {id: itemId, name, version: spendVersion(updated, params), summary: summary.slice(0, 500)},
        details: {action: kind, summary: summary.slice(0, 300), monthly_budget: params?.monthly_budget ?? null,
          campaign_ids: params?.campaign_ids ?? null, reason: null, code_required: true, result: null},
      };
    }
    const campaign = await this.campaign(userId, itemId);
    if (str(campaign['business_id'], 64) !== businessId) throw notFound();
    const name = str(campaign['campaign_name'], 120) ?? str(campaign['name'], 120) ?? 'Campaña';
    const updated = str(campaign['updated_at'], 40) ?? str(campaign['status'], 30) ?? 'unknown';
    const summary = kind === 'pause_campaign'
      ? `Pausar la campaña «${name}»: deja de gastar. Motivo: ${params?.reason ?? ''}`
      : `Reanudar la campaña «${name}»: vuelve a gastar en Meta.`;
    // Pausar o reanudar es una sola acción por campaña: otro motivo no es otra aprobación (E2E simulado:
    // Ale pedía la misma pausa con palabras distintas y el dueño veía varias solicitudes).
    return {
      item: {id: itemId, name, version: spendVersion(updated, undefined), summary: summary.slice(0, 500)},
      details: {action: kind, summary: summary.slice(0, 300), monthly_budget: null, campaign_ids: null,
        reason: params?.reason ?? null, code_required: true, result: null},
    };
  }

  /** El plan o la campaña cambió desde la propuesta: la aprobación queda `stale`. */
  async changed(row: ApprovalRow): Promise<boolean> {
    try {
      if (PLAN_KINDS.includes(row.kind as SpendKind)) {
        const {plan} = await this.plan(row.user_id, row.item_id);
        return (str(plan['updated_at'], 40) ?? str(plan['status'], 30) ?? 'unknown') !== resourceOf(row.item_version);
      }
      const campaign = await this.campaign(row.user_id, row.item_id);
      return (str(campaign['updated_at'], 40) ?? str(campaign['status'], 30) ?? 'unknown') !== resourceOf(row.item_version);
    } catch (error) {
      if (error instanceof ServicesUnavailableError) throw error;
      return true; // el recurso ya no existe o no es del dueño
    }
  }

  async execute(row: ApprovalRow): Promise<Record<string, unknown>> {
    const params = (row.params ?? {}) as ApprovalParamsV1;
    switch (row.kind as SpendKind) {
      case 'launch_plan': {
        const res = await this.services.call({
          service: 'strategy', method: 'POST', path: `/api/strategy/plan/${row.item_id}/launch`, userId: row.user_id,
          businessId: row.business_id, idempotencyKey: `approval:${row.id}`, body: params.campaign_ids ? {campaign_ids: params.campaign_ids} : {},
        });
        if (res.status >= 400) throw new SpendFailed(`launch_${res.status}`, downstreamCode(res.body));
        return {action: 'launch_plan', plan_id: row.item_id, status: str(record(res.body)['status'], 40) ?? 'launching'};
      }
      case 'pause_campaign': {
        const res = await this.services.call({
          service: 'campaign', method: 'POST', path: `/campaigns/${row.item_id}/pause`, userId: row.user_id,
          body: {pause_reason: 'manual_user', ...(params.reason ? {reason_note: params.reason.slice(0, 500)} : {})},
        });
        if (res.status === 409 && downstreamCode(res.body) === 'CAMPAIGN_ALREADY_PAUSED') return {action: 'pause_campaign', already: true};
        if (res.status >= 400) throw new SpendFailed(`pause_${res.status}`, downstreamCode(res.body));
        return {action: 'pause_campaign', already: false};
      }
      case 'resume_campaign': {
        const res = await this.services.call({
          service: 'campaign', method: 'POST', path: `/campaigns/${row.item_id}/resume`, userId: row.user_id, body: {},
        });
        if (res.status === 409 && downstreamCode(res.body) === 'CAMPAIGN_ALREADY_ACTIVE') return {action: 'resume_campaign', already: true};
        if (res.status >= 400) throw new SpendFailed(`resume_${res.status}`, downstreamCode(res.body));
        return {action: 'resume_campaign', already: false};
      }
      case 'change_budget': {
        const {etag, plan} = await this.plan(row.user_id, row.item_id);
        const ifMatch = etag ?? (str(plan['updated_at'], 40) ? `"${str(plan['updated_at'], 40)}"` : null);
        if (!ifMatch) throw new SpendFailed('budget_no_version', null);
        const res = await this.services.call({
          service: 'strategy', method: 'PATCH', path: `/api/strategy/plan/${row.item_id}`, userId: row.user_id,
          businessId: row.business_id, ifMatch, body: {monthly_budget: params.monthly_budget?.amount},
        });
        if (res.status >= 400) throw new SpendFailed(`budget_${res.status}`, downstreamCode(res.body));
        // Un presupuesto nuevo puede recompilar el plan: strategy crea uno nuevo y cancela este.
        const replaced = str(record(record(res.body)['plan'])['plan_id'], 64);
        return {action: 'change_budget', plan_id: row.item_id, replaced_plan_id: replaced && replaced !== row.item_id ? replaced : null};
      }
    }
  }
}

export class SpendFailed extends Error {
  constructor(readonly reason: string, readonly code: string | null) {
    super(`SPEND_FAILED:${reason}`);
    this.name = 'SpendFailed';
  }
}

/** Un ejecutor por tipo, todos sobre las mismas acciones. */
export function spendExecutors(actions: SpendActions): ApprovalExecutor[] {
  return SPEND.map(kind => ({
    kind,
    isStale: row => actions.changed(row),
    execute: row => actions.execute(row),
  }));
}
