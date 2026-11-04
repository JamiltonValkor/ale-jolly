import {randomUUID} from 'node:crypto';
import {
  guarded, invalid, isUuid, nowIso, ownedBusiness, text, toolError,
  type ToolDeps, type ToolHandler,
} from './common';
import {runAsync} from './operations';

/** Cuenta, negocios, perfil, ofertas, bootstrap y estado de Meta del negocio demo. */

const PAGE_SIZE = 50;
const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined) return 0;
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  return match ? Number(match[1]) : null;
}

export function businessHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const {store} = deps;
  return {
    saleads_get_account_overview: (_args, ctx) => guarded(async () => {
      const account = store.account(ctx.auth.userId);
      const businesses = store.businessesOf(ctx.auth.userId);
      const selected = businesses.find((b) => b.id === account.selected_business_id)?.id ?? null;
      const periodEnd = new Date(Date.now() + 20 * 86400_000).toISOString();
      return {
        subscription: {plan: 'business', status: 'active', campaigns_remaining: 8, businesses_remaining: Math.max(0, 3 - businesses.length)},
        businesses: businesses.map((b) => ({business_id: b.id, name: b.name, selected: b.id === selected})),
        selected_business_id: selected,
        credits: {balance: 1500, monthly_included: 2000, monthly_used: 500, purchased: 0, unlimited: false, period_end: periodEnd},
      };
    }),

    saleads_select_business: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      store.account(ctx.auth.userId).selected_business_id = business.id;
      store.save();
      return {business_id: business.id, selected: true};
    }),

    saleads_create_business: (args, ctx) => guarded(() => runAsync(deps, ctx, 'saleads_create_business', args, async () => {
      const name = text(args.name).trim();
      if (name.length < 2) throw invalid('name');
      if (store.businessesOf(ctx.auth.userId).length >= 3) {
        throw toolError('MCP-E-BUSINESS-QUOTA-EXCEEDED', 'La cuenta ya usó todos sus negocios.', 'Usa un negocio existente.');
      }
      const id = randomUUID();
      store.state.businesses[id] = {
        id, owner: ctx.auth.userId, name, offering_type: text(args.offering_type) || 'products',
        website_url: text(args.website_url) || null, country: 'CO', currency: 'COP', whatsapp_number: null,
        profile: {simulated: true, ...(args.category ? {industry: text(args.category)} : {})}, created_at: nowIso(),
      };
      store.account(ctx.auth.userId).selected_business_id ??= id;
      store.save();
      return {business_id: id, name, next_steps: ['Registra al menos una oferta con saleads_create_offering.']};
    }, {delayMs: 0})),

    saleads_get_business_profile: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const offerings = store.offeringsOf(business.id);
      const full = args.detail === 'full';
      const profile = full ? business.profile
        : Object.fromEntries(Object.entries(business.profile).filter(([key]) => ['simulated', 'industry', 'description', 'location'].includes(key)));
      return {
        business_id: business.id, name: business.name, offering_type: business.offering_type, website_url: business.website_url,
        profile, offerings_count: offerings.length, missing: offerings.length === 0 ? ['ofertas'] : [],
      };
    }),

    saleads_list_offerings: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const offset = decodeCursor(args.cursor);
      if (offset === null) throw invalid('cursor', 'El cursor no es válido.');
      const all = store.offeringsOf(business.id).map((o) => ({type: o.type, id: o.id, name: o.name, price: o.price, currency: o.currency}));
      const page = all.slice(offset, offset + PAGE_SIZE);
      return {offerings: page, next_cursor: offset + PAGE_SIZE < all.length ? encodeCursor(offset + PAGE_SIZE) : null};
    }),

    saleads_create_offering: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const work = async () => {
        const name = text(args.name).trim();
        if (name.length < 2) throw invalid('name');
        const id = randomUUID();
        const type = args.type === 'service' ? 'service' : 'product';
        store.state.offerings[id] = {
          id, business_id: business.id, type, name, description: text(args.description) || null,
          price: typeof args.price === 'number' ? args.price : null, currency: text(args.currency) || (typeof args.price === 'number' ? business.currency : null),
          url: text(args.url) || null, created_at: nowIso(),
        };
        store.save();
        return {type, id, name};
      };
      // Con client_request_id, una sola creación por (usuario, tool, id) como `runDeduped` del real.
      return args.client_request_id ? runAsync(deps, ctx, 'saleads_create_offering', args, work, {delayMs: 0}) : work();
    }),

    saleads_get_business_bootstrap: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const offerings = store.offeringsOf(business.id);
      const plan = Object.values(store.state.plans)
        .filter((p) => p.business_id === business.id && p.status !== 'cancelled')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return {
        schema_version: 'saleads-business-bootstrap/2',
        business_id: business.id,
        generated_at: nowIso(),
        context: {
          context_hash: null,
          readiness: 'ready',
          facts: {
            simulated: true, name: business.name, offering_type: business.offering_type, country: business.country,
            currency: business.currency, ...business.profile,
            offerings: offerings.map((o) => ({id: o.id, type: o.type, name: o.name, price: o.price, currency: o.currency})),
          },
          buyer_fit: null,
          evidence: [],
          unknowns: ['Resultados históricos de pauta (simulado: no hay campañas reales).'],
        },
        plan: plan
          ? {plan_id: plan.id, status: plan.status, currency: plan.currency, monthly_investment: plan.monthly_budget,
            communication_strategy_version_id: plan.version_id,
            campaigns: plan.campaigns.map((c) => ({item_id: c.item_id, name: c.name, status: c.status, hypothesis_id: c.hypothesis_id}))}
          : {plan_id: 'none', status: 'none', campaigns: []},
        campaigns: [],
        business_metrics: null,
        seasonal: [],
        warnings: ['Datos simulados de saleads-sim: no hay métricas reales de Meta.'],
      };
    }),

    saleads_get_meta_status: (args, ctx) => guarded(async () => {
      ownedBusiness(deps, ctx, args.business_id);
      const destination = args.destination === 'web' || args.destination === 'messages' ? args.destination : 'both';
      return {
        connected: true,
        ready: true,
        assets: {business_manager: 'Masquebella BM (simulado)', page: 'Masquebella (simulado)', ad_account: 'act_000000000000001 (simulado)',
          pixel: 'Píxel Masquebella (simulado)', instagram: '@masquebella.demo (simulado)', whatsapp: '+57 300 000 0000 (simulado)'},
        asset_ids: {page_id: '100000000000001', pixel_id: '200000000000001', instagram_user_id: '300000000000001', whatsapp_phone_number_id: '400000000000001'},
        blockers: [],
        action_url: null,
        destination_checked: destination,
        destination_source: args.destination ? 'input' : 'none',
        destinations: [{destination: 'messages', ready: true, reason_codes: []}, {destination: 'web', ready: true, reason_codes: []}],
        blocker_details: [],
        alternatives: [],
      };
    }),
  };
}

/** Comprobación de `business_id` para las tools sin núcleo propio (la propiedad se verifica en todas). */
export function checkBusinessArg(deps: ToolDeps, userId: string, args: Record<string, unknown>): void {
  if (args.business_id === undefined) return;
  if (!isUuid(args.business_id) || !deps.store.ownedBusiness(userId, args.business_id)) {
    throw toolError('MCP-E-BUSINESS-NOT-FOUND', 'El negocio no existe o no pertenece a esta cuenta.',
      'Lista los negocios con saleads_get_account_overview y usa uno de ellos.');
  }
}
