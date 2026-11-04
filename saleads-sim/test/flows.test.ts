import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';
import {loadContracts} from '../src/tools/registry';
import {Sampler} from '../src/tools/sample';
import {agent, assistantTokens, b64file, callTool, DEMO_BUSINESS, start, validator, type Harness} from './helpers';

const MASCARILLA = '0b1c6a3e-8f52-4c51-9a3d-1f0e5b7c2a01';
const contracts = loadContracts();
/** Salida válida de `saleads_stock_get_overview` con un carácter invisible en el primer texto libre. */
const overviewCheck = validator().compile(contracts.saleads_stock_get_overview.outputSchema!);
const overview = new Sampler(contracts.saleads_stock_get_overview.outputSchema!, 'https://saleads.local').sampleValid((v) => overviewCheck(v) as boolean) as Record<string, unknown>;
function poison(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && !['url', 'enlace'].includes(key) && !/^[0-9a-f-]{36}$/.test(child) && !/^\d{4}-/.test(child)) {
      (value as Record<string, unknown>)[key] = `${child}\u200B`;
      return child;
    }
    const found = poison(child);
    if (found !== null) return found;
  }
  return null;
}
const clean = poison(overview);

describe('flujos con estado', () => {
  let h: Harness;
  let token: string;
  const stockCalls: Array<{url: string; init: RequestInit}> = [];
  before(async () => {
    h = await start({}, (async (url: URL, init: RequestInit) => {
      stockCalls.push({url: String(url), init});
      if (String(url).includes('/items/')) return new Response(JSON.stringify({code: 'STOCK_OTHER_RUN'}), {status: 400});
      return new Response(JSON.stringify(overview), {status: 200});
    }) as unknown as typeof fetch);
    token = (await assistantTokens(h)).body.access_token;
  });
  after(() => h.close());

  it('cuenta, perfil y ofertas del negocio demo', async () => {
    const overview = (await callTool(h, token, 'saleads_get_account_overview', {})).structuredContent;
    assert.equal(overview.selected_business_id, DEMO_BUSINESS);
    assert.deepEqual(overview.businesses, [{business_id: DEMO_BUSINESS, name: 'Masquebella (demo)', selected: true}]);
    const profile = (await callTool(h, token, 'saleads_get_business_profile', {business_id: DEMO_BUSINESS})).structuredContent;
    assert.equal(profile.offering_type, 'products');
    const offerings = (await callTool(h, token, 'saleads_list_offerings', {business_id: DEMO_BUSINESS})).structuredContent;
    assert.ok(offerings.offerings.some((o: {name: string}) => /^Bio Mascarilla/.test(o.name)));
    assert.equal(offerings.next_cursor, null);
    const created = await callTool(h, token, 'saleads_create_offering', {business_id: DEMO_BUSINESS, type: 'product', name: 'Gel de Peinado', price: 25000, currency: 'COP', client_request_id: 'offer-0001'});
    const again = await callTool(h, token, 'saleads_create_offering', {business_id: DEMO_BUSINESS, type: 'product', name: 'Gel de Peinado', price: 25000, currency: 'COP', client_request_id: 'offer-0001'});
    assert.equal(created.structuredContent.id, again.structuredContent.id, 'misma creación con el mismo client_request_id');
    const foreign = await callTool(h, token, 'saleads_get_business_profile', {business_id: '11111111-1111-4111-8111-111111111111'});
    assert.equal(foreign.isError, true);
    assert.equal(foreign.structuredContent.error.code, 'MCP-E-BUSINESS-NOT-FOUND');
  });

  it('estrategia → aprobación → plan, con operaciones deduplicadas', async () => {
    const args = {business_id: DEMO_BUSINESS, offering: {type: 'product', id: MASCARILLA}, destination: 'messages', locale: 'es-CO', monthly_budget: 1_050_000, currency: 'COP', client_request_id: 'strategy-0001'};
    const started = (await callTool(h, token, 'saleads_start_strategy', args)).structuredContent;
    assert.equal(started.outcome, 'created');
    const replay = (await callTool(h, token, 'saleads_start_strategy', args)).structuredContent;
    assert.equal(replay.communication_strategy_version_id, started.communication_strategy_version_id);
    const reused = await callTool(h, token, 'saleads_start_strategy', {...args, monthly_budget: 2});
    assert.equal(reused.structuredContent.error.code, 'MCP-E-CONFLICT');
    const strategy = (await callTool(h, token, 'saleads_get_strategy', {communication_strategy_id: started.communication_strategy_id, communication_strategy_version_id: started.communication_strategy_version_id})).structuredContent;
    assert.equal(strategy.hypotheses.length, 3);
    const approved = (await callTool(h, token, 'saleads_approve_strategy', {communication_strategy_id: started.communication_strategy_id, communication_strategy_version_id: started.communication_strategy_version_id, destination: 'messages', language: 'es-CO'})).structuredContent;
    assert.equal(approved.campaign_count, 3);
    const plan = (await callTool(h, token, 'saleads_get_plan', {strategy_plan_id: approved.strategy_plan_id})).structuredContent;
    assert.equal(plan.campaigns.reduce((sum: number, c: {monthly_investment: number}) => sum + c.monthly_investment, 0), 1_050_000);
    assert.equal(plan.ready_to_launch, false);
    const updated = (await callTool(h, token, 'saleads_update_plan', {strategy_plan_id: approved.strategy_plan_id, monthly_budget: 2_100_000})).structuredContent;
    assert.equal(updated.monthly_budget, 2_100_000);
    const plans = (await callTool(h, token, 'saleads_list_plans', {business_id: DEMO_BUSINESS})).structuredContent;
    assert.equal(plans.total, 1);
    const existing = (await callTool(h, token, 'saleads_start_strategy', {...args, client_request_id: 'strategy-0002'})).structuredContent;
    assert.equal(existing.outcome, 'existing_plan', JSON.stringify(existing));
    assert.equal(existing.outcome, 'existing_plan');
  });

  it('operación pendiente y saleads_get_operation (solo del dueño)', async () => {
    h.app.config.syncWaitMs = 0;
    h.app.config.asyncDelayMs = 300;
    try {
      const pending = (await callTool(h, token, 'saleads_analyze_website', {business_id: DEMO_BUSINESS, website_url: 'https://masquebella.example', client_request_id: 'analyze-0001'})).structuredContent;
      assert.equal(pending.status, 'running');
      assert.ok(pending.poll_after_s >= 1);
      await new Promise((r) => setTimeout(r, 350));
      const done = (await callTool(h, token, 'saleads_get_operation', {operation_id: pending.operation_id})).structuredContent;
      assert.equal(done.status, 'succeeded');
      assert.equal(typeof done.result, 'object');
    } finally {
      h.app.config.syncWaitMs = 2000;
      h.app.config.asyncDelayMs = 50;
    }
  });

  it('apuestas → landing → versión en el navegador → publicar → destino', async () => {
    const round = await agent(h, token, 'POST', 'saleads_agent_register_bets', {
      business_id: DEMO_BUSINESS, client_request_id: 'bets-round-0001', offering_scope: {type: 'product', ids: [MASCARILLA]},
      bets: [{bet_key: 'resultado-30-dias', avatar: 'Mujer 30-45 con cabello seco', angle: 'Resultado en 30 días', promise: 'Cabello recuperado en 30 días',
        test: 'angle', format: 'image', attribution_unit: 'campaign', copies: [{headline: 'Recupera tu cabello', body: 'Rutina simple en casa'}], confidence: 'medium'}],
    });
    assert.equal(round.status, 200, JSON.stringify(round.body));
    const bet = round.body.data.bets[0];
    assert.equal(bet.bet_id, bet.communication_hypothesis_id);
    const replay = await agent(h, token, 'POST', 'saleads_agent_register_bets', {
      business_id: DEMO_BUSINESS, client_request_id: 'bets-round-0001', offering_scope: {type: 'product', ids: [MASCARILLA]},
      bets: [{bet_key: 'resultado-30-dias', avatar: 'Mujer 30-45 con cabello seco', angle: 'Resultado en 30 días', promise: 'Cabello recuperado en 30 días',
        test: 'angle', format: 'image', attribution_unit: 'campaign', copies: [{headline: 'Recupera tu cabello', body: 'Rutina simple en casa'}], confidence: 'medium'}],
    });
    assert.equal(replay.body.data.replayed, true);
    const active = await agent(h, token, 'POST', 'saleads_agent_bet_state', {business_id: DEMO_BUSINESS, client_request_id: 'bet-state-0001', bet_id: bet.bet_id, state: 'active'});
    assert.equal(active.body.data.state, 'active');

    // Sin bet canónico, la landing no se crea.
    const orphan = await agent(h, token, 'POST', 'saleads_landing_create', landingArgs('11111111-1111-4111-8111-111111111111', 'landing-orphan-01'));
    assert.equal(orphan.body.ok, false);
    assert.equal(orphan.body.code, 'MCP-E-INVALID-INPUT');

    const created = await agent(h, token, 'POST', 'saleads_landing_create', landingArgs(bet.bet_id, 'landing-0001'));
    assert.equal(created.body.ok, true, JSON.stringify(created.body));
    const landing = created.body.data;
    assert.equal(landing.lineage.hypothesisId, bet.bet_id);
    assert.equal(landing.lineage.strategyVersionId, round.body.data.communication_strategy_version_id);
    assert.match(landing.review_url, new RegExp(`/es/dashboard/agent-landings/${landing.id}$`));

    const html = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Recupera tu cabello en 30 días</h1></body></html>';
    const css = 'h1{color:#1F6F50}';
    const artifact = {business_id: DEMO_BUSINESS, landing_id: landing.id, client_request_id: 'landing-v1-0001', expected_latest_n: 0,
      files: {'index.html': b64file(html), 'styles.css': b64file(css)}, metadata: {lineage: {betId: bet.bet_id}}};
    const validated = await agent(h, token, 'POST', 'saleads_landing_validate', artifact);
    assert.equal(validated.body.data.publishable, true);
    const preview = await agent(h, token, 'POST', 'saleads_landing_preview', artifact);
    assert.ok(Buffer.from(preview.body.data.shots[0].base64, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'JPEG');
    const tampered = await agent(h, token, 'POST', 'saleads_landing_submit_version', {...artifact, files: {...artifact.files, 'styles.css': {...b64file(css), sha256: '0'.repeat(64)}}});
    assert.equal(tampered.body.code, 'MCP-E-INVALID-INPUT');
    const submitted = await agent(h, token, 'POST', 'saleads_landing_submit_version', artifact);
    assert.equal(submitted.body.data.n, 1);
    assert.equal(submitted.body.data.origin, 'hermes');
    const stale = await agent(h, token, 'POST', 'saleads_landing_submit_version', {...artifact, client_request_id: 'landing-v1-0002'});
    assert.equal(stale.body.code, 'MCP-E-CONFLICT');
    const version = await agent(h, token, 'POST', 'saleads_landing_get_version', {business_id: DEMO_BUSINESS, landing_id: landing.id, n: 1});
    assert.equal(Buffer.from(version.body.data.files['index.html'].content, 'base64').toString('utf8'), html);

    // La landing se ve en el navegador.
    const page = await fetch(`${h.base}/l/${landing.id}/v/1/`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /Recupera tu cabello en 30 días/);
    assert.match(body, /Landing simulada/);
    assert.equal(await (await fetch(`${h.base}/l/${landing.id}/v/1/styles.css`)).text(), css);
    const review = await fetch(`${h.base}/es/dashboard/agent-landings/${landing.id}`);
    assert.match(await review.text(), /Publicar versión 1/);
    assert.equal((await fetch(`${h.base}/l/${landing.id}/`)).status, 404, 'sin publicar no hay URL pública');

    // Sin publicar no hay destino.
    const early = await agent(h, token, 'POST', 'saleads_agent_prepare_landing_destination', {business_id: DEMO_BUSINESS, bet_id: bet.bet_id, landing_id: landing.id, published_n: 1, expected_revision: 0, client_request_id: 'dest-0001'});
    assert.equal(early.body.code, 'MCP-E-CONFLICT');

    const published = await (await fetch(`${h.base}/sim/landings/${landing.id}/publish`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"n":1}'})).json() as any;
    assert.equal(published.data.status, 'published');
    assert.equal(published.data.url, `https://saleads.local/l/${landing.id}/`);
    assert.match(await (await fetch(`${h.base}/l/${landing.id}/`)).text(), /Recupera tu cabello/);
    const got = await agent(h, token, 'POST', 'saleads_landing_get', {business_id: DEMO_BUSINESS, landing_id: landing.id});
    assert.equal(got.body.data.publishedN, 1);

    const destination = await agent(h, token, 'POST', 'saleads_agent_prepare_landing_destination', {business_id: DEMO_BUSINESS, bet_id: bet.bet_id, landing_id: landing.id, published_n: 1, expected_revision: 0, client_request_id: 'dest-0002'});
    assert.equal(destination.body.ok, true, JSON.stringify(destination.body));
    assert.equal(destination.body.data.publication.url, `https://saleads.local/l/${landing.id}/`);
    const read = await agent(h, token, 'POST', 'saleads_agent_get_landing_destination', {business_id: DEMO_BUSINESS, bet_id: bet.bet_id});
    assert.equal(read.body.data.current_publication.matches_binding, true);
  });

  it('Stock se reenvía a ale-runtime con las cabeceras internas', async () => {
    const ok = await callTool(h, token, 'saleads_stock_get_overview', {business_id: DEMO_BUSINESS, tarjeta: 'conteo'});
    const call = stockCalls.at(-1)!;
    assert.equal(call.url, `http://ale-runtime:8060/internal/stock/businesses/${DEMO_BUSINESS}/overview?tarjeta=conteo`);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['x-internal-api-token'], 'x'.repeat(40));
    assert.equal(headers['x-user-id'], '00000000-0000-4000-a000-000000000001');
    assert.equal(headers['x-business-id'], DEMO_BUSINESS);
    assert.equal(ok.isError, undefined, JSON.stringify(ok).slice(0, 300));
    assert.ok(clean !== null, 'la muestra tiene un texto libre');
    assert.ok(!JSON.stringify(ok.structuredContent).includes('\u200B'), 'texto de terceros sin invisibles');
    assert.ok(JSON.stringify(ok.structuredContent).includes(JSON.stringify(clean)));
    const failed = await callTool(h, token, 'saleads_stock_get_item', {business_id: DEMO_BUSINESS, variante_id: MASCARILLA});
    assert.equal(failed.structuredContent.error.code, 'MCP-E-INVALID-INPUT');
    assert.equal(failed.structuredContent.error.details.reason, 'other_run');
    const proposal = await callTool(h, token, 'saleads_stock_propose', {business_id: DEMO_BUSINESS, tipo: 'conteo', variante_id: MASCARILLA, cantidad: 3, motivo: 'conteo'}).catch(() => null);
    if (proposal && !proposal.isError) {
      const body = JSON.parse(String(stockCalls.at(-1)!.init.body));
      assert.equal(body.business_id, undefined, 'business_id va en la ruta, nunca en el cuerpo');
    }
  });

  it('Agent API: catálogo, esquema, scopes y cliente', async () => {
    const list = await agent(h, token, 'GET');
    const names = list.body.data.commands.map((c: {name: string}) => c.name);
    assert.ok(names.includes('saleads_landing_create'));
    assert.ok(names.includes('saleads_get_account_overview'));
    assert.ok(!names.includes('saleads_start_strategy'), 'solo lecturas listadas y el dominio agent');
    const schema = await agent(h, token, 'GET', 'saleads_landing_submit_version');
    assert.equal(schema.body.data.input_schema.type, 'object');
    assert.equal((await agent(h, token, 'GET', 'saleads_nope')).status, 404);
    const invalid = await agent(h, token, 'POST', 'saleads_landing_get', {business_id: DEMO_BUSINESS});
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.details.fields, ['/landing_id']);
    const readOnly = await assistantTokens(h, 'openid offline_access saleads:read');
    const denied = await agent(h, readOnly.body.access_token, 'POST', 'saleads_agent_bet_state', {business_id: DEMO_BUSINESS, client_request_id: 'x-00000001', bet_id: MASCARILLA, state: 'paused'});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'MCP-E-INSUFFICIENT-SCOPE');
    const noToken = await fetch(`${h.base}/agent/v1/commands`);
    assert.equal(noToken.status, 401);
  });

  it('gateway clásico y PostHog', async () => {
    const session = await (await fetch(`${h.base}/sim/session`)).json() as any;
    const auth = {authorization: `Bearer ${session.access_token}`, origin: 'http://localhost:3000'};
    const language = await fetch(`${h.base}/api/subscription/language`, {headers: auth});
    assert.equal(language.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const lang = await language.json() as any;
    assert.equal(lang.success, true);
    assert.equal(lang.data.user_id, session.user.id);
    const put = await (await fetch(`${h.base}/api/subscription/language`, {method: 'PUT', headers: {...auth, 'content-type': 'application/json'}, body: '{"language_code":"en"}'})).json() as any;
    assert.equal(put.data.language_code, 'en');
    const cap = await (await fetch(`${h.base}/api/subscription/credits/agent-cap`, {headers: auth})).json() as any;
    assert.equal(typeof cap.data.used_this_period, 'number');
    const actions = await (await fetch(`${h.base}/api/campaigns/agentic/v1/businesses/${DEMO_BUSINESS}/agent-actions?limit=20`, {headers: auth})).json() as any;
    assert.ok(actions.data.items.length >= 1);
    const detail = await (await fetch(`${h.base}/api/campaigns/agentic/v1/agent-actions/${actions.data.items[0].agent_action_id}`, {headers: auth})).json() as any;
    assert.ok(Array.isArray(detail.data.steps));
    const meta = await (await fetch(`${h.base}/api/integration/meta/configuration?businessId=${DEMO_BUSINESS}`, {headers: auth})).json() as any;
    assert.equal(meta.oauthData.verifiedAdAccountCurrency.currency, 'COP');
    assert.equal((await fetch(`${h.base}/api/subscription/language`)).status, 401);
    // El token del asistente no sirve en el gateway web.
    assert.equal((await fetch(`${h.base}/api/subscription/language`, {headers: {authorization: `Bearer ${token}`}})).status, 401);
    const preflight = await fetch(`${h.base}/api/subscription/language`, {method: 'OPTIONS', headers: {origin: 'http://localhost:3000'}});
    assert.equal(preflight.status, 204);

    const flags = await (await fetch(`${h.base}/flags/?v=2`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({token: 'phc_x', distinct_id: session.user.id, flag_keys_to_evaluate: ['otra-bandera']})})).json() as any;
    assert.equal(flags.flags['sales-assistant-enabled'].enabled, true);
    assert.equal(flags.flags['otra-bandera'].enabled, true);
    assert.equal(flags.featureFlags['meta-assistant-enabled'], true);
    const capture = await fetch(`${h.base}/batch/`, {method: 'POST', body: '{"batch":[]}'});
    assert.deepEqual(await capture.json(), {status: 1});
  });
});

function landingArgs(betId: string, requestId: string) {
  return {
    business_id: DEMO_BUSINESS, client_request_id: requestId, name: 'Mascarilla 30 días', format: 'product_page',
    closing: {type: 'whatsapp', whatsappNumber: '+573000000000'},
    context: {version: 'landing-context.v1', negocio: {nombre: 'Masquebella (demo)'}, oferta: {nombre: 'Bio Mascarilla Capilar 500 g', precio: 45000, moneda: 'COP'},
      businessType: 'physical', apuesta: 'Resultado en 30 días', promesa: 'Cabello recuperado en 30 días', avatar: 'Mujer 30-45', cta: 'Escríbenos por WhatsApp'},
    lineage: {betId},
  };
}
