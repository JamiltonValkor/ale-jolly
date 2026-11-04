import {createHash, randomUUID} from 'node:crypto';
import type {Plan, Strategy} from '../store';
import {
  argsHash, guarded, invalid, isUuid, notFound, nowIso, ownedBusiness, text, toolError,
  type ToolCallContext, type ToolDeps, type ToolHandler,
} from './common';
import {idempotent, runAsync} from './operations';

/**
 * Estrategia de comunicación, versiones y plan (web path de SaleADS). El
 * contenido es de demo (marcado «simulado») y se deriva de la oferta elegida;
 * no hay LLM detrás. La ejecución (lanzar) sigue siendo de la web.
 */

const uuidFrom = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const ROLES = [
  {role: 'principal', share: 0.5, angle: 'Resultado visible en 30 días', summary: 'Quien ya probó productos de supermercado responde a una promesa concreta de recuperación en 30 días.'},
  {role: 'contraste', share: 0.3, angle: 'Ingredientes naturales', summary: 'La preocupación por químicos agresivos se resuelve mostrando la fórmula natural.'},
  {role: 'prueba', share: 0.2, angle: 'Asesoría por WhatsApp', summary: 'La duda sobre qué producto usar se resuelve con asesoría personal por WhatsApp.'},
];

function hypotheses(versionId: string, offeringName: string) {
  return ROLES.map((r, i) => ({
    hypothesis_id: uuidFrom(`${versionId}:h${i}`),
    role: r.role,
    angle: r.angle,
    summary: `${r.summary} (simulado)`,
    promise: `${offeringName}: ${r.angle.toLowerCase()}.`,
    changed_variable: 'angle',
    held_constants: ['audience', 'offer', 'destination'],
    claim_status: 'hypothesis',
  }));
}

function strategyOf(deps: ToolDeps, ctx: ToolCallContext, strategyId: unknown, versionId: unknown): {strategy: Strategy; version: Strategy['versions'][number]} {
  if (!isUuid(strategyId)) throw invalid('communication_strategy_id');
  if (!isUuid(versionId)) throw invalid('communication_strategy_version_id');
  const strategy = deps.store.state.strategies[String(strategyId).toLowerCase()];
  if (!strategy || strategy.owner !== ctx.auth.userId) throw notFound('la estrategia');
  const version = strategy.versions.find((v) => v.version_id === String(versionId).toLowerCase());
  if (!version) throw notFound('la versión de la estrategia');
  return {strategy, version};
}

function planOf(deps: ToolDeps, ctx: ToolCallContext, planId: unknown): Plan {
  if (!isUuid(planId)) throw invalid('strategy_plan_id');
  const plan = deps.store.state.plans[String(planId).toLowerCase()];
  if (!plan || plan.owner !== ctx.auth.userId) throw notFound('el plan');
  return plan;
}

const offeringName = (deps: ToolDeps, id: string) => deps.store.state.offerings[id]?.name ?? 'La oferta';

export function strategyHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const {store} = deps;
  return {
    saleads_start_strategy: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const offering = args.offering as {type?: string; id?: string} | undefined;
      if (!offering || !isUuid(offering.id) || store.state.offerings[offering.id]?.business_id !== business.id) {
        throw toolError('MCP-E-OFFERING-REQUIRED', 'La oferta no existe en este negocio.', 'Lista las ofertas con saleads_list_offerings y usa una de ellas.', false, {fields: ['offering.id']});
      }
      if (typeof args.monthly_budget !== 'number' || args.monthly_budget <= 0) throw invalid('monthly_budget');
      return runAsync(deps, ctx, 'saleads_start_strategy', args, async () => {
        const existing = Object.values(store.state.plans).find((p) => p.business_id === business.id && p.status !== 'cancelled'
          && store.state.strategies[p.strategy_id]?.offering.id === offering.id);
        if (existing) {
          const mismatch = existing.monthly_budget !== args.monthly_budget || existing.currency !== args.currency;
          return {
            outcome: 'existing_plan', strategy_plan_id: existing.id, communication_strategy_id: existing.strategy_id,
            communication_strategy_version_id: existing.version_id,
            ...(mismatch ? {budget_mismatch: {plan_monthly_budget: existing.monthly_budget, plan_currency: existing.currency,
              requested_monthly_budget: args.monthly_budget as number, requested_currency: text(args.currency)}} : {}),
            next_step: 'Ya hay un plan para esta oferta: léelo con saleads_get_plan.',
          };
        }
        const id = randomUUID();
        const versionId = randomUUID();
        store.state.strategies[id] = {
          id, business_id: business.id, owner: ctx.auth.userId, offering: {type: offering.type === 'service' ? 'service' : 'product', id: offering.id!},
          destination: args.destination === 'web' ? 'web' : 'messages', locale: text(args.locale) || 'es',
          monthly_budget: args.monthly_budget as number, currency: text(args.currency) || business.currency,
          versions: [{version_id: versionId, revision: 1, status: 'generated', source_version_id: null, created_at: nowIso()}],
          plan_id: null, created_at: nowIso(),
        };
        store.save();
        return {
          outcome: 'created', communication_strategy_id: id, communication_strategy_version_id: versionId, strategy_plan_id: null,
          next_step: 'Revisa la estrategia con saleads_get_strategy y apruébala con saleads_approve_strategy.',
        };
      });
    }),

    saleads_get_strategy: (args, ctx) => guarded(async () => {
      const {strategy, version} = strategyOf(deps, ctx, args.communication_strategy_id, args.communication_strategy_version_id);
      const name = offeringName(deps, strategy.offering.id);
      const full = args.detail === 'full';
      return {
        communication_strategy_id: strategy.id,
        communication_strategy_version_id: version.version_id,
        status: version.status,
        revision: version.revision,
        diagnosis: `${name}: la clienta ideal ya gastó en soluciones que no funcionaron y desconfía de promesas genéricas. (simulado)`,
        positioning: {promise: `${name} recupera el cabello en casa con una rutina simple.`, proof: 'Sin pruebas verificadas aún: no se citan testimonios ni cifras.', simulated: true},
        priority_audience: {description: 'Mujeres de 25 a 45 años en Colombia con cabello seco o con caída.', tension: 'Ya probó de todo y no ve resultados.', simulated: true},
        hypotheses: hypotheses(version.version_id, name).map((h) => (full ? h : {hypothesis_id: h.hypothesis_id, role: h.role, angle: h.angle, summary: h.summary})),
        quality_summary: {passed: true, simulated: true},
        unknowns: ['Testimonios con permiso confirmado', 'Resultados de campañas anteriores'],
        conflicts: [],
      };
    }),

    saleads_regenerate_strategy: (args, ctx) => guarded(async () => {
      const {strategy, version} = strategyOf(deps, ctx, args.communication_strategy_id, args.communication_strategy_version_id);
      return runAsync(deps, ctx, 'saleads_regenerate_strategy', args, async () => {
        const versionId = randomUUID();
        version.status = version.status === 'approved' ? version.status : 'superseded';
        strategy.versions.push({version_id: versionId, revision: strategy.versions.length + 1, status: 'generated', source_version_id: version.version_id, created_at: nowIso()});
        store.save();
        return {communication_strategy_id: strategy.id, communication_strategy_version_id: versionId, source_version_id: version.version_id};
      });
    }),

    saleads_approve_strategy: (args, ctx) => guarded(async () => {
      const {strategy, version} = strategyOf(deps, ctx, args.communication_strategy_id, args.communication_strategy_version_id);
      return idempotent(deps, ctx, 'saleads_approve_strategy', args, async () => {
        const existing = strategy.plan_id ? store.state.plans[strategy.plan_id] : undefined;
        if (existing && existing.version_id === version.version_id) {
          return {strategy_plan_id: existing.id, campaign_count: existing.campaigns.length, content_hash: argsHash(existing.campaigns), resumed_existing_plan: true};
        }
        version.status = 'approved';
        const name = offeringName(deps, strategy.offering.id);
        const planId = randomUUID();
        const campaigns = hypotheses(version.version_id, name).map((h, i) => ({
          item_id: uuidFrom(`${planId}:c${i}`), name: `${name} · ${h.angle}`, status: 'draft', role: h.role,
          hypothesis_id: h.hypothesis_id, hypothesis_summary: h.summary,
          monthly_investment: Math.round(strategy.monthly_budget * ROLES[i].share), daily_budget: Math.round((strategy.monthly_budget * ROLES[i].share) / 30),
        }));
        if (existing) {
          existing.status = 'cancelled';
          existing.replaced_by_plan_id = planId;
        }
        store.state.plans[planId] = {
          id: planId, business_id: strategy.business_id, owner: ctx.auth.userId, strategy_id: strategy.id, version_id: version.version_id,
          status: 'draft', replaced_by_plan_id: null, monthly_budget: strategy.monthly_budget, currency: strategy.currency,
          language: text(args.language) || strategy.locale,
          locations: [{key: 'CO', name: 'Colombia', type: 'country', country_code: 'CO'}], campaigns, created_at: nowIso(), updated_at: nowIso(),
        };
        strategy.plan_id = planId;
        store.save();
        return {strategy_plan_id: planId, campaign_count: campaigns.length, content_hash: argsHash(campaigns), resumed_existing_plan: false};
      });
    }),

    saleads_get_plan: (args, ctx) => guarded(async () => {
      const plan = planOf(deps, ctx, args.strategy_plan_id);
      return {
        strategy_plan_id: plan.id, business_id: plan.business_id, status: plan.status, replaced_by_plan_id: plan.replaced_by_plan_id,
        monthly_budget: plan.monthly_budget, currency: plan.currency, locations: plan.locations, language: plan.language,
        campaigns: plan.campaigns.map((c) => ({...c, creatives: {type: 'image', count: 2, ratios: ['1:1', '9:16']}, draft_id: null, images_ready: false})),
        ready_to_launch: false,
        next_step: 'El lanzamiento lo confirma la dueña en la web de SaleADS (simulado: no se crea nada en Meta).',
      };
    }),

    saleads_list_plans: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const all = Object.values(store.state.plans)
        .filter((p) => p.business_id === business.id && (args.include_cancelled === true || p.status !== 'cancelled'))
        .filter(() => args.kind === undefined || args.kind === 'all' || args.kind === 'strategic_plan')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return {
        business_id: business.id,
        plans: all.slice(offset, offset + limit).map((p) => ({
          strategy_plan_id: p.id, title: `Plan ${offeringName(deps, store.state.strategies[p.strategy_id]?.offering.id ?? '')} (simulado)`,
          kind: 'strategic_plan', status: p.status, launch_state: 'draft', monthly_budget: p.monthly_budget, currency: p.currency,
          campaigns: {total: p.campaigns.length, launched: 0, launching: 0, with_issues: 0}, platforms: ['meta'],
          created_at: p.created_at, updated_at: p.updated_at, last_activity_at: p.updated_at,
        })),
        total: all.length, limit, offset, has_more: offset + limit < all.length,
      };
    }),

    saleads_update_plan: (args, ctx) => guarded(async () => {
      const plan = planOf(deps, ctx, args.strategy_plan_id);
      if (args.monthly_budget !== undefined && (typeof args.monthly_budget !== 'number' || args.monthly_budget <= 0)) throw invalid('monthly_budget');
      if (typeof args.monthly_budget === 'number') {
        const factor = args.monthly_budget / plan.monthly_budget;
        plan.monthly_budget = args.monthly_budget;
        for (const c of plan.campaigns) {
          c.monthly_investment = Math.round(c.monthly_investment * factor);
          c.daily_budget = Math.round(c.monthly_investment / 30);
        }
      }
      if (typeof args.currency === 'string') plan.currency = args.currency;
      if (Array.isArray(args.locations)) plan.locations = args.locations as Plan['locations'];
      if (typeof args.creatives_language === 'string') plan.language = args.creatives_language;
      plan.updated_at = nowIso();
      store.save();
      return {strategy_plan_id: plan.id, updated: true, replaced_plan_id: null, monthly_budget: plan.monthly_budget, currency: plan.currency,
        next_step: 'Revisa el plan con saleads_get_plan.'};
    }),
  };
}
