import type {AgentActivationDetailsV1, AgentBudgetEvaluationV1, AgentSpendProjectionV1, ApprovalItemV1, ApprovalParamsV1} from '../contracts/v1';
import {invalidRequest, notFound} from '../domain/errors';
import {
  type AgentBudgetRepository, budgetMinor, budgetPeriod, BudgetRevisionConflict, evaluateAgentBudget, toMajor, toMinor,
} from './agent-budget';
import type {ApprovalRow} from './approvals-repository';
import type {ApprovalExecutor} from './approvals.service';
import {downstreamCode, type SaleadsServicesClient, ServicesUnavailableError} from './saleads-services';
import {spendVersion} from './spend';

/**
 * Encender lo que el agente publicó en pausa (AAB-012, D13, D21, D23). El agente propone; el dueño aprueba con un
 * botón en la web (sin código). Este servicio lee la publicación en campaign-service (C-8), evalúa el presupuesto
 * mensual aprobado y, al aprobar, enciende por campaign-service (C-6), que a su vez llama a integration. Integration
 * vuelve a verificar la aprobación aquí (`…/verification`, C-5) antes de tocar Meta.
 */
export const AGENT_ACTIVATION_KIND = 'activate_agent_publication' as const;
/** Vigencia de la aprobación de encendido (approvals.service usa la misma). */
export const AGENT_ACTIVATION_TTL_MS = 24 * 3_600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Estados de CS desde los que se puede pedir el encendido (uno fallido o desconocido se puede reintentar). */
const ACTIVATABLE = new Set(['awaiting_owner_approval', 'failed', 'unknown']);

const str = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const minor = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value)
    : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 ? Math.round(Number(value)) : null;
const resourceOf = (version: string) => version.split('#')[0] ?? '';

/** Fallo del encendido: la aprobación queda `failed` con este `code` y la publicación sigue en pausa. */
export class AgentActivationFailed extends Error {
  constructor(readonly code: string) {
    super(`AGENT_ACTIVATION_FAILED:${code}`);
    this.name = 'AgentActivationFailed';
  }
}

interface Publication {
  publicationId: string;
  updatedAt: string;
  currency: string;
  campaign: Record<string, unknown>;
  adSets: Record<string, unknown>[];
  adsCount: number;
  betIds: string[];
  skillRef: {skill_id: string; skill_version: string | null} | null;
}

/** Cuota de campañas en subscription (C-15): `launch_attempt_id = publication_id`, reservada por la Agent API. */
type QuotaOutcome = 'committed' | 'released' | 'not_reserved' | 'error';

export interface AgentActivationOptions {
  /** C-31: apagada, `propose` de este tipo responde `invalidRequest` (front sin AAF-001 desplegado). */
  enabled: boolean;
  /** C-18: escribir `approval_decided` en la traza del agente (campaign-service, AAB-010) al rechazar. */
  traceWriter?: boolean;
  /**
   * La aprobación queda vieja si el gasto diario que encendería cambió desde que el agente la pidió (presupuesto movido
   * por el espejo o a mano en Meta): se compara con la proyección viva de integration (AAB-026). Sin integration, falla
   * cerrado al aprobar.
   */
  liveProjection?: boolean;
  now?: () => Date;
}

/** Días que quedan del mes en la zona horaria de la cuenta, hoy incluido (igual que integration). */
export function daysLeftInMonth(at: Date, timeZone: string): number {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
      .formatToParts(at).map(p => [p.type, p.value]));
  } catch {
    return daysLeftInMonth(at, 'America/Bogota');
  }
  const year = Number(parts['year']);
  const month = Number(parts['month']);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return lastDay - Number(parts['day']) + 1;
}

/** Gasto diario que agrega el encendido: el delta pedido entre los días que quedaban cuando se calculó. */
export function dailyRate(deltaMinor: number, at: Date, timeZone: string): number {
  return deltaMinor / Math.max(1, daysLeftInMonth(at, timeZone));
}

export class AgentActivationActions {
  private readonly now: () => Date;

  constructor(
    private readonly services: SaleadsServicesClient,
    private readonly budgets: AgentBudgetRepository,
    readonly options: AgentActivationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** C-8: la publicación del agente del negocio del dueño, o 404. */
  private async publication(userId: string, businessId: string, publicationId: string): Promise<Publication> {
    if (!UUID.test(publicationId)) throw notFound();
    const res = await this.services.call({
      service: 'campaign', method: 'GET', path: `/campaigns/internal/agent-v1/publications/${publicationId.toLowerCase()}`,
      userId, businessId, internal: true,
    });
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status >= 400) throw new ServicesUnavailableError(`campaign_${res.status}`);
    const data = record(record(res.body)['data']);
    if (str(data['business_id'], 64) !== businessId || data['user_id'] !== userId || data['origin'] !== 'agent') throw notFound();
    if (data['status'] !== 'paused' || !ACTIVATABLE.has(String(data['agent_activation_state']))) throw invalidRequest();
    const skill = record(data['skill_ref']);
    return {
      publicationId: publicationId.toLowerCase(),
      updatedAt: str(data['updated_at'], 40) ?? 'unknown',
      currency: str(data['currency'], 3) ?? '',
      campaign: record(data['campaign']),
      adSets: Array.isArray(data['ad_sets']) ? data['ad_sets'].map(record) : [],
      adsCount: Number.isInteger(data['ads_count']) ? Number(data['ads_count']) : 0,
      betIds: Array.isArray(data['bet_ids']) ? data['bet_ids'].filter((id): id is string => typeof id === 'string' && UUID.test(id)) : [],
      skillRef: str(skill['skill_id'], 128) ? {skill_id: str(skill['skill_id'], 128)!, skill_version: str(skill['skill_version'], 64)} : null,
    };
  }

  private async evaluate(userId: string, businessId: string, projection: AgentSpendProjectionV1): Promise<AgentBudgetEvaluationV1> {
    const row = await this.budgets.current(businessId);
    const budget = row && row.user_id === userId ? {amount_minor: budgetMinor(row), currency: row.currency, revision: row.revision} : null;
    return evaluateAgentBudget(budget, {
      currency: projection.currency, spent_to_date_minor: projection.spent_to_date_minor,
      projected_active_minor: projection.projected_active_minor, requested_delta_minor: projection.requested_delta_minor,
    });
  }

  /** Arma el ítem y los detalles solo desde lo leído y la evaluación; nada de texto libre del agente. */
  async resolve(input: {userId: string; businessId: string; itemId: string; params?: ApprovalParamsV1}):
  Promise<{item: ApprovalItemV1; details: AgentActivationDetailsV1}> {
    const projection = input.params?.projection;
    if (!projection) throw invalidRequest();
    const pub = await this.publication(input.userId, input.businessId, input.itemId);
    if (pub.currency && pub.currency !== projection.currency) throw invalidRequest();
    const evaluation = await this.evaluate(input.userId, input.businessId, projection);
    const currency = projection.currency;
    const money = (value: number | null) => value === null ? null : {amount: toMajor(value, currency), currency};
    const exceeds = evaluation.decision !== 'within';
    // Pasarse se resuelve en la misma aprobación subiendo el presupuesto al proyectado (D13); con otra moneda no.
    const proposed = exceeds && evaluation.code === null ? evaluation.projected_minor : null;
    const name = str(pub.campaign['name'], 120) ?? 'Campaña del agente';
    const summary = (`Encender la campaña «${name}» que preparó tu equipo autónomo: empieza a gastar en Meta.`
      + (proposed !== null && proposed > 0 ? ` Sube tu presupuesto mensual del agente a ${toMajor(proposed, currency).toLocaleString('es-CO')} ${currency}.` : '')
    ).slice(0, 300);
    const details: AgentActivationDetailsV1 = {
      action: AGENT_ACTIVATION_KIND,
      summary,
      publication_id: pub.publicationId,
      campaign: {
        campaign_id: String(pub.campaign['campaign_id']),
        name,
        objective: str(pub.campaign['objective'], 64),
        daily_budget: money(minor(pub.campaign['daily_budget'])),
        lifetime_budget: money(minor(pub.campaign['lifetime_budget'])),
      },
      ad_sets: pub.adSets.filter(set => UUID.test(String(set['ad_set_id']))).slice(0, 50).map(set => ({
        ad_set_id: String(set['ad_set_id']),
        name: str(set['name'], 120) ?? 'Conjunto',
        daily_budget: money(minor(set['daily_budget'])),
        // La segmentación se resume en el panel (AAF-003); aquí no se pasa texto del agente.
        audience_summary: null,
      })),
      ads_count: pub.adsCount,
      pieces: [],
      // Etiquetas e hipótesis salen de strategy (AAB-014); mientras tanto solo el id.
      bets: pub.betIds.slice(0, 20).map(betId => ({bet_id: betId, label: null, hypothesis: null})),
      skill_ref: pub.skillRef,
      budget: {
        monthly: money(evaluation.monthly_minor),
        spent_to_date: {amount: toMajor(projection.spent_to_date_minor, currency), currency},
        projected_with_activation: {amount: toMajor(evaluation.projected_minor, currency), currency},
        exceeds,
        proposed_monthly: proposed !== null && proposed > 0 ? money(proposed) : null,
      },
      code_required: false,
      result: null,
    };
    // Una sola aprobación por publicación y versión: la proyección cambia con el gasto y no abre otra
    // (el ejecutor vuelve a evaluar el presupuesto al aprobar).
    return {item: {id: pub.publicationId, name, version: spendVersion(pub.updatedAt, undefined), summary}, details};
  }

  /**
   * La publicación cambió (u otro estado) desde la propuesta, o el gasto diario que encendería ya no es el que vio el
   * dueño: la aprobación queda `stale`.
   */
  async changed(row: ApprovalRow): Promise<boolean> {
    try {
      const pub = await this.publication(row.user_id, row.business_id, row.item_id);
      if (pub.updatedAt !== resourceOf(row.item_version)) return true;
    } catch (error) {
      if (error instanceof ServicesUnavailableError) throw error;
      return true;
    }
    return this.options.liveProjection ? this.projectionChanged(row) : false;
  }

  /** C-10 vivo: misma moneda y mismo gasto diario (tolerancia de medio punto por redondeo de Meta). */
  private async projectionChanged(row: ApprovalRow): Promise<boolean> {
    const stored = ((row.params ?? {}) as ApprovalParamsV1).projection;
    if (!stored) return true;
    const res = await this.services.call({
      service: 'integration', method: 'GET', internal: true, userId: row.user_id, businessId: row.business_id,
      path: `/api/integration/internal/agentic/v1/meta/businesses/${row.business_id}/agent-spend-projection`,
      query: {publication_id: row.item_id.toLowerCase()},
    });
    if (res.status >= 400) throw new ServicesUnavailableError(`integration_${res.status}`);
    const live = record(record(res.body)['data']);
    const delta = typeof live['requested_delta_minor'] === 'number' ? live['requested_delta_minor'] : null;
    if (delta === null) throw new ServicesUnavailableError('integration_projection');
    if (str(live['currency'], 3) !== stored.currency) return true;
    const timeZone = str(live['account_timezone'], 64) ?? 'America/Bogota';
    // Cuándo se calculó lo guardado: el vencimiento (reloj del servicio) menos las 24 h del encendido.
    const requestedAt = new Date(new Date(row.expires_at).getTime() - AGENT_ACTIVATION_TTL_MS);
    const before = dailyRate(stored.requested_delta_minor, requestedAt, timeZone);
    const now = dailyRate(delta, this.now(), timeZone);
    return Math.abs(now - before) > Math.max(1, before * 0.005);
  }

  async execute(row: ApprovalRow): Promise<Record<string, unknown>> {
    const params = (row.params ?? {}) as ApprovalParamsV1;
    const details = row.details as unknown as AgentActivationDetailsV1 | null;
    const projection = params.projection;
    if (!projection || !details) throw new AgentActivationFailed('APPROVAL_INCOMPLETE');
    // 1-2. Volver a evaluar; si el dueño aprobó viendo «subir a X», se sube antes de encender (D13).
    let evaluation = await this.evaluate(row.user_id, row.business_id, projection);
    let budgetRaised = false;
    if (evaluation.decision !== 'within') {
      if (evaluation.code === 'CURRENCY_MISMATCH') throw new AgentActivationFailed('CURRENCY_MISMATCH');
      if (!details.budget.exceeds || !details.budget.proposed_monthly) throw new AgentActivationFailed('BUDGET_EXCEEDED');
      // Exactamente lo que el dueño vio y aprobó: nunca más. Si con eso no alcanza, no se enciende.
      const amountMinor = toMinor(details.budget.proposed_monthly.amount, projection.currency);
      if (amountMinor < evaluation.projected_minor) throw new AgentActivationFailed('BUDGET_EXCEEDED');
      try {
        await this.budgets.set({
          businessId: row.business_id, userId: row.user_id, amountMinor, currency: projection.currency,
          periodStart: budgetPeriod(this.now()).start, expectedRevision: evaluation.revision, now: this.now(),
        });
      } catch (error) {
        if (error instanceof BudgetRevisionConflict) throw new AgentActivationFailed('BUDGET_REVISION_CONFLICT');
        throw error;
      }
      budgetRaised = true;
      evaluation = await this.evaluate(row.user_id, row.business_id, projection);
    }
    // 3. Encender por campaign-service; integration verifica esta aprobación (status `executing`) antes de Meta.
    const res = await this.services.call({
      service: 'campaign', method: 'POST', path: `/campaigns/internal/agent-v1/publications/${row.item_id}/activation`,
      userId: row.user_id, businessId: row.business_id, internal: true, idempotencyKey: `approval:${row.id}`,
      body: {
        approval_id: row.id,
        ...(evaluation.campaign_spend_cap_minor !== null ? {campaign_spend_cap_minor: evaluation.campaign_spend_cap_minor} : {}),
        ...(params.agent_action_id ? {agent_action_id: params.agent_action_id} : {}),
      },
    });
    const state = str(record(record(res.body)['data'])['state'], 40);
    if (res.status === 202 || state === 'unknown') throw new AgentActivationFailed('ACTIVATION_OUTCOME_UNKNOWN');
    if (res.status !== 200 || state !== 'activated') throw new AgentActivationFailed(downstreamCode(res.body) ?? `ACTIVATION_${res.status}`);
    // 4. Confirmar la cuota; un fallo aquí no revierte el encendido.
    const quota = await this.quota(row, 'commit');
    return {
      activated: true,
      budget_raised: budgetRaised,
      // Aprobar la versión autorada de la apuesta llega con AAB-014.
      strategy_approved: null,
      quota,
      spend_cap_below_meta_minimum: evaluation.spend_cap_below_meta_minimum,
      code: null,
    };
  }

  /** Rechazar: la publicación sigue en pausa y se libera la cuota reservada (C-15). */
  async onRejected(row: ApprovalRow): Promise<void> {
    await this.quota(row, 'release');
    await this.traceRejection(row);
  }

  /**
   * C-18: el rechazo del dueño queda en la traza de la acción `activation_requested`. Al aprobar, el paso lo escribe
   * campaign-service dentro de la activación (no se duplica aquí). Un fallo de traza nunca cambia el rechazo.
   */
  private async traceRejection(row: ApprovalRow): Promise<void> {
    const actionId = ((row.params ?? {}) as ApprovalParamsV1).agent_action_id;
    if (!this.options.traceWriter || !actionId) return;
    try {
      await this.services.call({
        service: 'campaign', method: 'POST', path: `/campaigns/internal/agent-trace/v1/actions/${actionId}/steps`,
        userId: row.user_id, businessId: row.business_id, internal: true,
        body: { step_kind: 'approval_decided', writer: 'assistant', approval_id: row.id, after_value: { decision: 'rejected' },
          action_state: 'rejected', outcome_summary: 'El dueño no aprobó el encendido; la campaña sigue en pausa.' },
      });
    } catch {
      // La traza es un registro: no bloquea ni deshace la decisión del dueño.
    }
  }

  /**
   * Consulta antes de confirmar o liberar (V-L9: un `commit` después de `release` reincrementa sin chequear el
   * límite). Sin reserva (la Agent API aún no reserva) no hace nada.
   */
  private async quota(row: ApprovalRow, action: 'commit' | 'release'): Promise<QuotaOutcome> {
    const body = {user_id: row.user_id, quota_type: 'campaigns', launch_attempt_id: row.item_id};
    try {
      const status = await this.services.call({
        service: 'subscription', method: 'POST', path: '/api/subscription/internal/quota-reservation-status',
        userId: row.user_id, internal: true, body,
      });
      if (status.status >= 400) return 'error';
      const current = str(record(status.body)['reservation_status'], 20);
      if (current !== 'reserved') return current === 'committed' ? 'committed' : current === 'released' ? 'released' : 'not_reserved';
      const done = await this.services.call({
        service: 'subscription', method: 'POST', path: `/api/subscription/internal/${action}-quota-reservation`,
        userId: row.user_id, internal: true, body,
      });
      if (done.status >= 400) return 'error';
      return action === 'commit' ? 'committed' : 'released';
    } catch {
      return 'error';
    }
  }
}

export function agentActivationExecutor(actions: AgentActivationActions): ApprovalExecutor {
  return {kind: AGENT_ACTIVATION_KIND, isStale: row => actions.changed(row), execute: row => actions.execute(row)};
}
