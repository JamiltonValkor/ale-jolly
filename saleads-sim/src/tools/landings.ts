import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Landing, LandingVersion} from '../store';
import {
  conflict, guarded, invalid, isUuid, nowIso, ownedBusiness, record, text, toolError,
  type ToolCallContext, type ToolDeps, type ToolHandler,
} from './common';
import {idempotent, runAsync} from './operations';

/**
 * Landings del agente (MAL, ADR0030): mismo comportamiento que
 * sa-mcp-server `landing-commands.ts` sobre sa-landing-service (`agent/v1`).
 * Las versiones se guardan con sus archivos y se sirven en `/l/{id}/v/{n}/`.
 * Publicar lo hace el dueño (aquí, el endpoint simulado de la vista de revisión).
 * `preview` devuelve un JPEG fijo marcado «Vista previa simulada».
 */

const FILENAMES = ['index.html', 'styles.css'] as const;
const PREVIEW_JPEG = readFileSync(fileURLToPath(new URL('../../assets/preview-simulada.jpg', import.meta.url))).toString('base64');

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])));
/** `artifactDigest` del servicio: digest del mapa nombre → sha256 del contenido. */
export const artifactDigest = (files: Record<string, string>) =>
  sha256(canonicalJson(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(Buffer.from(v, 'utf8'))]))));

export const encodeFiles = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, content]) => {
  const bytes = Buffer.from(content, 'utf8');
  return [name, {encoding: 'base64', content: bytes.toString('base64'), sha256: sha256(bytes), byteLength: bytes.length}];
}));

export function landingLinks(deps: ToolDeps, id: string, locale: unknown, origin = 'hermes') {
  const path = `/${locale === 'en' ? 'en' : 'es'}/dashboard/${origin === 'web' ? 'landings' : 'agent-landings'}/${id}`;
  return {review_url: `${deps.config.landingReviewBaseUrl}${path}`, review_path: path};
}

export const publishedUrl = (deps: ToolDeps, landing: Landing) => `${deps.config.landingPublicBaseUrl}/l/${landing.id}/`;

/** Proyección `toLanding` de sa-landing-service. */
export function toLanding(deps: ToolDeps, l: Landing) {
  return {
    id: l.id, origin: l.origin, businessId: l.business_id, lineage: l.lineage, name: l.name, format: l.format, status: l.status,
    ...(l.status === 'published' ? {url: publishedUrl(deps, l)} : {}),
    closing: l.closing, testimonials: [],
    ...(l.latestN !== null ? {latestN: l.latestN} : {}),
    ...(l.publishedN !== null ? {publishedN: l.publishedN} : {}),
    createdAt: l.created_at, updatedAt: l.updated_at, simulated: true,
  };
}

const versionSummary = (v: LandingVersion) => ({
  n: v.n, artifactDigest: v.artifactDigest, createdBy: v.createdBy, createdAt: v.createdAt, ...(v.review ? {review: v.review} : {}),
});

function ownedLanding(deps: ToolDeps, ctx: ToolCallContext, args: Record<string, unknown>): Landing {
  const business = ownedBusiness(deps, ctx, args.business_id);
  if (!isUuid(args.landing_id)) throw invalid('landing_id');
  const landing = deps.store.state.landings[String(args.landing_id).toLowerCase()];
  if (!landing || landing.owner !== ctx.auth.userId) throw toolError('MCP-E-NOT-FOUND', 'La landing no existe.', 'Lista las landings con saleads_landing_list.');
  if (landing.business_id !== business.id) {
    throw toolError('MCP-E-BUSINESS-NOT-FOUND', 'La landing no pertenece al negocio seleccionado.', 'Usa una landing del negocio seleccionado.');
  }
  return landing;
}

/** Linaje canónico resuelto por el servidor: `betId = hypothesisId` y la versión de la vuelta registrada. */
function canonicalLineage(deps: ToolDeps, businessId: string, supplied: Record<string, unknown>) {
  const raw = supplied.betId ?? supplied.hypothesisId;
  if (!isUuid(raw)) throw invalid('lineage.betId', 'La propuesta requiere el bet_id canónico registrado en Strategy para este negocio.');
  const betId = String(raw).toLowerCase();
  if (supplied.betId !== undefined && supplied.hypothesisId !== undefined && text(supplied.betId).toLowerCase() !== text(supplied.hypothesisId).toLowerCase()) {
    throw invalid('lineage.hypothesisId', 'betId e hypothesisId son el mismo id canónico de apuesta; no pueden diferir.');
  }
  const bet = deps.store.state.bets[betId];
  if (!bet || bet.business_id !== businessId) throw invalid('lineage.betId', 'La apuesta no existe en este negocio; usa el bet_id de Strategy, nunca el id del cerebro.');
  if (supplied.strategyVersionId !== undefined && text(supplied.strategyVersionId).toLowerCase() !== bet.communication_strategy_version_id) {
    throw invalid('lineage.strategyVersionId', 'La versión indicada no corresponde a la apuesta registrada.');
  }
  return {lineage: {...supplied, betId, hypothesisId: betId, strategyVersionId: bet.communication_strategy_version_id}, bet};
}

/** Decodifica y verifica los archivos (base64 exacto, `sha256` y `byteLength`). */
function decodeFiles(args: Record<string, unknown>): Record<string, string> {
  const files = record(args.files);
  const out: Record<string, string> = {};
  for (const name of FILENAMES) {
    const f = record(files[name]);
    const bytes = Buffer.from(text(f.content), 'base64');
    if (f.encoding !== 'base64' || bytes.toString('base64') !== f.content || bytes.length !== f.byteLength || sha256(bytes) !== f.sha256) {
      throw invalid(`files.${name}`, `El archivo ${name} no coincide con su sha256/byteLength o no es base64 válido.`);
    }
    out[name] = bytes.toString('utf8');
  }
  return out;
}

function check(files: Record<string, string>) {
  const blocks: Array<{rule: string; message: string}> = [];
  const warnings: Array<{rule: string; message: string}> = [];
  if (!/<html[\s>]/i.test(files['index.html'])) blocks.push({rule: 'html.document', message: 'index.html debe ser un documento HTML completo.'});
  if (!/styles\.css/.test(files['index.html'])) warnings.push({rule: 'css.link', message: 'index.html no enlaza styles.css.'});
  return {blocks, warnings, testimonials: [] as unknown[]};
}

/** Artefacto validado contra la landing (linaje intacto, versión esperada y archivos íntegros). */
function artifact(landing: Landing, args: Record<string, unknown>) {
  const lineage = record(record(args.metadata).lineage);
  for (const [field, value] of Object.entries(lineage)) {
    const norm = (v: unknown) => (['betId', 'hypothesisId', 'strategyVersionId', 'campaignId'].includes(field) ? text(v).toLowerCase() : v);
    if (norm(value) !== norm(landing.lineage[field])) throw invalid(`metadata.lineage.${field}`, 'La revisión debe conservar el linaje canónico de la propuesta.');
  }
  const files = decodeFiles(args);
  return {files, check: check(files), digest: artifactDigest(files)};
}

const expectedMatches = (landing: Landing, expected: unknown) => (expected === 0 ? landing.latestN === null : expected === landing.latestN);

export function landingHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const {store} = deps;
  return {
    saleads_landing_list: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      const origin = text(args.origin) || 'all';
      const landings = Object.values(store.state.landings)
        .filter((l) => l.business_id === business.id && (origin === 'all' || l.origin === origin))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return {landings: landings.map((l) => ({
        id: l.id, origin: l.origin, name: l.name, format: l.format, status: l.status,
        ...(l.status === 'published' ? {url: publishedUrl(deps, l)} : {}),
        eventCounts: {pageViews: 0, contacts: 0, schedules: 0}, ...landingLinks(deps, l.id, args.locale, l.origin),
      }))};
    }),

    saleads_landing_get: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      return {...toLanding(deps, landing), feedback: landing.feedback, ...landingLinks(deps, landing.id, args.locale, landing.origin)};
    }),

    saleads_landing_get_version: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      const version = landing.versions.find((v) => v.n === args.n);
      if (!version) throw toolError('MCP-E-NOT-FOUND', 'Esa versión no existe.', 'Lee latestN con saleads_landing_get.');
      return {...versionSummary(version), landingId: landing.id, origin: landing.origin, files: encodeFiles(version.files),
        ...(version.artifacts ? {artifacts: version.artifacts} : {})};
    }),

    saleads_landing_context: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      if (args.landing_id && args.bet_id) throw invalid('bet_id', 'Usa landing_id o bet_id, no ambos.');
      if (args.landing_id) {
        const landing = ownedLanding(deps, ctx, args);
        return {landingId: landing.id, businessId: landing.business_id, origin: landing.origin, lineage: landing.lineage,
          context: landing.context, closing: landing.closing, confirmedTestimonialIds: landing.confirmed_testimonial_ids};
      }
      const schema = (record(deps.contracts?.saleads_landing_create?.inputSchema).properties as Record<string, unknown> | undefined)?.context ?? {};
      const defaults = {...(business.whatsapp_number ? {whatsappNumber: business.whatsapp_number} : {}), pixelConfirmed: false};
      if (!args.bet_id) return {schema, defaults};
      const {lineage, bet} = canonicalLineage(deps, business.id, {betId: args.bet_id});
      const offering = bet.offering_id ? store.state.offerings[bet.offering_id] : undefined;
      return {
        schema, defaults, business_id: business.id, canonical_lineage: lineage,
        business: {name: business.name, colors: (business.profile.brand_colors as string[] | undefined) ?? [], country: business.country},
        offering: offering ? {id: offering.id, name: offering.name, description: offering.description, price: offering.price, currency: offering.currency} : null,
        strategy_sources: {promise: text(bet.bet.promise) || null, avatar: bet.bet.avatar ?? null, angle: bet.bet.angle ?? null},
        source_refs: [{kind: 'agent_bet', id: bet.bet_id}], warnings: ['Datos simulados de saleads-sim.'],
        provenance_note: 'Canonical references are records, not proof that every hypothesis is factual; preserve claim_status and evidence_refs.',
      };
    }),

    saleads_landing_create: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      return runAsync(deps, ctx, 'saleads_landing_create', args, async () => {
        const {lineage} = canonicalLineage(deps, business.id, record(args.lineage));
        const closingIn = record(args.closing);
        const closing = closingIn.type === 'agenda'
          ? {type: 'agenda', ...(closingIn.agendaUrl ? {agendaUrl: text(closingIn.agendaUrl)} : {}), ...(closingIn.whatsappNumber ? {whatsappNumber: text(closingIn.whatsappNumber)} : {})}
          : {type: 'whatsapp', whatsappNumber: text(closingIn.whatsappNumber) || business.whatsapp_number || '+573000000000'};
        const id = randomUUID();
        const now = nowIso();
        const landing: Landing = {
          id, business_id: business.id, owner: ctx.auth.userId, origin: 'hermes', name: text(args.name), format: text(args.format),
          closing, context: record(args.context), confirmed_testimonial_ids: Array.isArray(args.confirmed_testimonial_ids) ? args.confirmed_testimonial_ids.map(String) : [],
          lineage, status: 'draft', latestN: null, publishedN: null, versions: [], feedback: [], created_at: now, updated_at: now,
        };
        store.state.landings[id] = landing;
        store.save();
        return {...toLanding(deps, landing), ...landingLinks(deps, id, args.locale)};
      });
    }),

    saleads_landing_design_catalog: (args, ctx) => guarded(async () => {
      ownedBusiness(deps, ctx, args.business_id);
      return {
        design: {simulated: true, palettes: [{name: 'Verde botánico', colors: ['#1F6F50', '#F2C14E', '#F4F1EA', '#222222']}],
          layouts: ['hero-producto', 'beneficios-3-columnas', 'antes-despues', 'preguntas-frecuentes', 'cierre-whatsapp']},
        fonts: [{role: 'heading', family: 'Fraunces'}, {role: 'body', family: 'Inter'}, {role: 'accent', family: 'Caveat'}],
        iconNames: ['leaf', 'sparkles', 'droplet', 'shield-check', 'message-circle'],
        ...(text(args.icon) ? {icon: {name: text(args.icon), svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>'}} : {}),
      };
    }),

    saleads_landing_prepare_assets: (args, ctx) => guarded(async () => {
      ownedLanding(deps, ctx, args);
      return {photos: [], logo: null, fonts: [{role: 'heading', family: 'Fraunces'}, {role: 'body', family: 'Inter'}], references: [],
        note: 'saleads-sim no tiene fotos del negocio: usa formas, color y tipografía (simulado).'};
    }),

    saleads_landing_validate: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      const {files, check: result, digest} = artifact(landing, args);
      return {...result, artifactDigest: digest, files: encodeFiles(files), publishable: result.blocks.length === 0, ...landingLinks(deps, landing.id, args.locale)};
    }),

    saleads_landing_preview: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      const {check: result, digest} = artifact(landing, args);
      if (result.blocks.length) throw toolError('MCP-E-INVALID-INPUT', 'La landing tiene bloqueos de validación.', 'Corrige los bloqueos de saleads_landing_validate.', false, {blocks: result.blocks});
      return {artifactDigest: digest, simulated: true, shots: [
        {viewport: 'desktop', tile: 1, mediaType: 'image/jpeg', base64: PREVIEW_JPEG},
        {viewport: 'mobile', tile: 1, mediaType: 'image/jpeg', base64: PREVIEW_JPEG},
      ], ...landingLinks(deps, landing.id, args.locale)};
    }),

    saleads_landing_submit_version: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      return idempotent(deps, ctx, 'saleads_landing_submit_version', args, async () => {
        const {files, check: result, digest} = artifact(landing, args);
        if (result.blocks.length) throw toolError('MCP-E-INVALID-INPUT', 'La landing tiene bloqueos de validación.', 'Corrige los bloqueos de saleads_landing_validate.', false, {blocks: result.blocks});
        if (!expectedMatches(landing, args.expected_latest_n)) {
          throw conflict('La landing cambió desde tu última lectura.', 'Lee latestN con saleads_landing_get y vuelve a enviar con ese expected_latest_n.', {latestN: landing.latestN});
        }
        const metadata = record(args.metadata);
        const version: LandingVersion = {
          n: (landing.latestN ?? 0) + 1, files, artifactDigest: digest, createdBy: 'agent', createdAt: nowIso(),
          review: metadata.review ?? null, artifacts: metadata.artifacts ?? null, requestId: text(args.client_request_id),
        };
        landing.versions.push(version);
        landing.latestN = version.n;
        landing.updated_at = version.createdAt;
        store.save();
        return {landingId: landing.id, businessId: landing.business_id, origin: 'hermes', ...versionSummary(version),
          requestId: version.requestId, ...landingLinks(deps, landing.id, args.locale)};
      });
    }),

    saleads_landing_metrics: (args, ctx) => guarded(async () => {
      ownedLanding(deps, ctx, args);
      const days = args.period === '30d' ? 30 : 7;
      const byDay = Array.from({length: days}, (_, i) => ({date: new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10), pageViews: 0, contacts: 0, schedules: 0}));
      const base = args.by_ad === true ? {rows: []} : {pageViews: 0, contacts: 0, schedules: 0, byDay};
      return {...base, simulated: true, semantics: {
        contacts: 'WhatsApp CTA clicks, not messages, leads or sales.',
        schedules: 'Client intent signal, not independent booking or attendance confirmation.',
        attribution: 'Aggregates may mix published versions; do not infer causal improvement between revisions.',
      }};
    }),

    saleads_agent_prepare_landing_destination: (args, ctx) => guarded(async () => {
      const landing = ownedLanding(deps, ctx, args);
      if (!isUuid(args.bet_id) || text(landing.lineage.betId) !== String(args.bet_id).toLowerCase()) {
        throw invalid('bet_id', 'La landing no pertenece a esa apuesta.');
      }
      return runAsync(deps, ctx, 'saleads_agent_prepare_landing_destination', args, async () => {
        if (landing.status !== 'published' || landing.publishedN !== args.published_n) {
          throw conflict('La versión indicada no está publicada.', 'Pide al dueño publicar la landing en la vista de revisión y usa su publishedN.', {publishedN: landing.publishedN});
        }
        const bet = store.state.bets[String(args.bet_id).toLowerCase()];
        const key = String(args.bet_id).toLowerCase();
        const previous = store.state.destinations[key];
        const revision = previous ? Number(previous.binding.revision) : 0;
        if (args.expected_revision !== revision) {
          throw conflict('El destino de la apuesta cambió.', 'Lee el destino con saleads_agent_get_landing_destination y usa su revision.', {revision});
        }
        const version = landing.versions.find((v) => v.n === landing.publishedN)!;
        const now = nowIso();
        const binding = {
          schema_version: 'agent_landing_destination_receipt_v1', binding_id: randomUUID(), business_id: landing.business_id, bet_id: key,
          campaign_intent_id: bet.campaign_intent_id, communication_strategy_id: bet.communication_strategy_id,
          communication_strategy_version_id: bet.communication_strategy_version_id, revision: revision + 1,
          client_request_id: text(args.client_request_id),
          publication: {landing_id: landing.id, business_id: landing.business_id, origin: 'hermes', published_n: landing.publishedN!,
            url: publishedUrl(deps, landing), artifact_digest: version.artifactDigest, bet_id: key,
            strategy_version_id: bet.communication_strategy_version_id, observed_at: now},
          prepared_at: now,
        };
        store.state.destinations[key] = {binding, bet_id: key, business_id: landing.business_id};
        store.save();
        return binding;
      });
    }),

    saleads_agent_get_landing_destination: (args, ctx) => guarded(async () => {
      const business = ownedBusiness(deps, ctx, args.business_id);
      if (!isUuid(args.bet_id)) throw invalid('bet_id');
      const stored = store.state.destinations[String(args.bet_id).toLowerCase()];
      if (!stored || stored.business_id !== business.id) {
        throw toolError('MCP-E-NOT-FOUND', 'La apuesta no tiene destino de landing.', 'Prepáralo con saleads_agent_prepare_landing_destination.');
      }
      const publication = record(stored.binding.publication);
      const landing = store.state.landings[text(publication.landing_id)];
      const published = landing?.status === 'published' && landing.publishedN !== null;
      const digest = published ? landing.versions.find((v) => v.n === landing.publishedN)?.artifactDigest ?? null : null;
      return {binding: stored.binding, current_publication: {
        state: published ? 'published' : landing ? 'unpublished' : 'unavailable',
        published_n: published ? landing.publishedN : null, url: published ? publishedUrl(deps, landing) : null, artifact_digest: digest,
        matches_binding: published ? landing.publishedN === publication.published_n && digest === publication.artifact_digest : false,
        observed_at: nowIso(),
      }};
    }),
  };
}
