import {createHash} from 'node:crypto';
import {Logger} from '@nestjs/common';
import type {BrainFactV3, BrainNodeV2} from '../contracts/v1';
import type {OutboundFetch} from '../outbound/http-client';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';
import {DIFF_KEYS, diffGraphs, type GraphV2} from './brain-snapshots';

/**
 * Empuje del conocimiento del cerebro a BI (AAB-013, D10, D27, ADR0020).
 *
 * Tras guardar una versión nueva de la foto de un negocio, manda a BI solo lo que cambió respecto de la última
 * versión que BI ya recibió (`knowledge-sync.v1`): nodos agregados o modificados (nunca los quitados: que un nodo
 * falte en la foto no es un borrado), sin la semilla, y los hechos con revisión nueva. Uno por negocio, idempotente
 * (`Idempotency-Key: brain:<user>:<business>:<version>`) y con cursor para reintentar sin perder versiones.
 * Nunca bloquea ni hace fallar la ingesta. Logs y eventos llevan solo conteos.
 */

export interface KnowledgeItemV1 {
  node_id: string;
  type: string;
  label: string;
  summary: string;
  provenance: string;
  stage: string | null;
  outcome: string | null;
  confidence: string | null;
  valid_from: string | null;
  superseded_by: string | null;
  winner: boolean | null;
  bet_node_id: string | null;
  anchor_node_id: string | null;
  revision: string;
}

export interface KnowledgeSyncBodyV1 {
  source: 'brain';
  snapshot_version: number;
  generated_at: string;
  facts: BrainFactV3[];
  items: KnowledgeItemV1[];
}

export interface KnowledgeCursor {
  lastSyncedVersion: number;
  status: 'ok' | 'pending' | 'failed';
  attempts: number;
}

export interface KnowledgeSyncSource {
  latestVersions(userId: string): Promise<Array<{businessId: string; version: number}>>;
  syncSource(userId: string, businessId: string, version: number): Promise<{graph: GraphV2; facts: BrainFactV3[]} | null>;
}

export interface KnowledgeSyncDeps {
  source: KnowledgeSyncSource;
  cursors: Pick<KnowledgeSyncStore, 'get' | 'ok' | 'failed'>;
  fetcher: OutboundFetch;
  repository: Pick<AssistantRepository, 'appendEvent'>;
  now?: () => Date;
}

export interface KnowledgeSyncOptions {
  enabled: boolean;
  biUrl: string;
  internalToken: string;
}

export type PushOutcome = 'synced' | 'empty' | 'failed' | 'skipped';

const SEED = 'saleads_seed';
const MAX_ITEMS = 500;

// Mismas expresiones que brain/saleads_brain/privacy.py (PATTERNS): correos, teléfonos y direcciones.
const REDACTED = '[dato personal]';
const PII: readonly RegExp[] = [
  /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g,
  /(?<![\w-])(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{2,4}(?![\w-])/g,
  /\b(?:calle|cl|carrera|cra|kr|avenida|av|diagonal|dg|transversal|tv)\.?\s*\d+[a-z]?\s*(?:#|no\.?|n°)\s*\d+[a-z]?\s*-\s*\d+\b/gi,
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln)\b\.?/g,
];

/** Segunda pasada de privacidad (la primera es la del cerebro). Devuelve el texto y cuántos datos tapó. */
export function redactPii(text: string): {text: string; count: number} {
  let count = 0;
  let out = text;
  for (const pattern of PII) {
    out = out.replace(pattern, () => {count++; return REDACTED;});
  }
  return {text: out, count};
}

/** sha256 de los campos que cuentan como cambio (los mismos del diff de la web). */
export function nodeRevision(node: BrainNodeV2): string {
  return createHash('sha256').update(JSON.stringify(DIFF_KEYS.map(key => node[key] ?? null))).digest('hex');
}

/** Ligas del loop: Verdict -ABOUT-> Bet; Learning <-TEACHES- Verdict o Learning -DERIVED_FROM-> Decision. */
function links(graph: GraphV2) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const isType = (id: string | undefined, type: string) => !!id && byId.get(id)?.type === type;
  const betOf = (id: string): string | null =>
    graph.edges.find(e => e.type === 'ABOUT' && e.source === id && isType(e.target, 'Bet'))?.target ?? null;
  const anchorOf = (learningId: string): string | null =>
    graph.edges.find(e => e.type === 'TEACHES' && e.target === learningId)?.source
    ?? graph.edges.find(e => e.type === 'DERIVED_FROM' && e.source === learningId && !isType(e.target, 'Result'))?.target
    ?? null;
  /** Avatar ganador en esta prueba: alguna apuesta que le habla ganó; null sin veredictos. */
  const winnerOf = (avatarId: string): boolean | null => {
    const bets = graph.edges.filter(e => e.type === 'TARGETS' && e.target === avatarId).map(e => byId.get(e.source)).filter(Boolean);
    if (bets.some(b => b!.outcome === 'gana' || b!.stage === 'ganadora')) return true;
    return bets.some(b => b!.outcome) ? false : null;
  };
  return {betOf, anchorOf, winnerOf};
}

/** Cuerpo `knowledge-sync.v1` de la versión `to` contra la ya sincronizada `from` (null = BI no tiene nada). */
export function buildKnowledgeSync(
  version: number,
  generatedAt: string,
  to: {graph: GraphV2; facts: BrainFactV3[]},
  from: {graph: GraphV2; facts: BrainFactV3[]} | null,
): {body: KnowledgeSyncBodyV1; redacted: number} {
  const empty: GraphV2 = {...to.graph, nodes: [], edges: [], stats: {nodes: 0, edges: 0}};
  const diff = diffGraphs(from?.graph ?? empty, to.graph);
  const nodes = [...diff.added, ...diff.modified.map(m => m.after)].filter(n => n.provenance !== SEED).slice(0, MAX_ITEMS);
  const {betOf, anchorOf, winnerOf} = links(to.graph);
  let redacted = 0;
  const clean = (text: string) => {
    const result = redactPii(text);
    redacted += result.count;
    return result.text;
  };
  const items = nodes.map((node): KnowledgeItemV1 => {
    const anchor = node.type === 'Learning' ? anchorOf(node.id) : null;
    const bet = node.type === 'Verdict' ? betOf(node.id) : anchor ? betOf(anchor) : null;
    return {
      node_id: node.id, type: node.type, label: clean(node.label).slice(0, 200), summary: clean(node.summary).slice(0, 500),
      provenance: node.provenance, stage: node.stage, outcome: node.outcome, confidence: node.confidence,
      valid_from: node.valid_from, superseded_by: node.superseded_by,
      winner: node.type === 'Avatar' ? winnerOf(node.id) : null,
      bet_node_id: bet, anchor_node_id: anchor, revision: nodeRevision(node),
    };
  });
  const known = new Set((from?.facts ?? []).map(f => f.revision_id));
  const facts = to.facts.filter(f => !known.has(f.revision_id)).map(f => ({
    ...f, value: Array.isArray(f.value) ? f.value.map(v => clean(v).slice(0, 200)) : clean(f.value).slice(0, 1000),
  }));
  return {body: {source: 'brain', snapshot_version: version, generated_at: generatedAt, facts, items}, redacted};
}

export class KnowledgeSyncService {
  private readonly logger = new Logger('orqa-knowledge-sync');
  private readonly running = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(private readonly options: KnowledgeSyncOptions, private readonly deps: KnowledgeSyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.options.enabled && !!this.options.internalToken;
  }

  /** Desde la ingesta: en segundo plano, nunca la hace esperar ni fallar. */
  onStored(userId: string, businessIds: readonly string[]): void {
    void this.syncUser(userId, businessIds).catch(() => undefined);
  }

  /** Empuja a BI cada negocio del dueño con versiones pendientes (todas, o solo `only`). Uno por usuario a la vez. */
  syncUser(userId: string, only?: readonly string[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const inFlight = this.running.get(userId);
    if (inFlight) return inFlight.then(() => this.syncUser(userId, only));
    const run = (async () => {
      const latest = await this.deps.source.latestVersions(userId);
      for (const {businessId, version} of latest) {
        if (only && !only.includes(businessId)) continue;
        await this.push(userId, businessId, version).catch(() => 'failed');
      }
    })().finally(() => this.running.delete(userId));
    this.running.set(userId, run);
    return run;
  }

  async push(userId: string, businessId: string, version: number): Promise<PushOutcome> {
    const cursor = await this.deps.cursors.get(userId, businessId);
    const from = cursor?.lastSyncedVersion ?? 0;
    if (version <= from) return 'skipped';
    const to = await this.deps.source.syncSource(userId, businessId, version);
    if (!to) return this.fail(userId, businessId, 'snapshot_unreadable');
    const previous = from > 0 ? await this.deps.source.syncSource(userId, businessId, from) : null;
    const {body, redacted} = buildKnowledgeSync(version, this.now().toISOString(), to, previous);
    if (!body.items.length && !body.facts.length) {
      await this.deps.cursors.ok(userId, businessId, version);
      return 'empty';
    }
    let response: Response;
    try {
      response = await this.deps.fetcher(
        `${this.options.biUrl.replace(/\/$/, '')}/api/business-intelligence/internal/businesses/${businessId}/knowledge-sync`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json', accept: 'application/json', 'x-internal-token': this.options.internalToken,
            'x-user-id': userId, 'idempotency-key': `brain:${userId}:${businessId}:${version}`,
          },
          body: JSON.stringify(body),
        });
    } catch {
      return this.fail(userId, businessId, 'network');
    }
    if (!response.ok) return this.fail(userId, businessId, `http_${response.status}`);
    const summary = await response.json().then(json => (json as {data?: {summary?: Record<string, number>}})?.data?.summary ?? {})
      .catch(() => ({} as Record<string, number>));
    await this.deps.cursors.ok(userId, businessId, version);
    const counts = ['applied', 'kept_owner', 'duplicate', 'rejected'].map(key => `${key}=${Number(summary[key] ?? 0)}`).join(' ');
    await this.deps.repository.appendEvent({
      userId, kind: 'orqa.knowledge_synced', phase: 'orqa',
      detail: `version=${version} items=${body.items.length} facts=${body.facts.length} redacted=${redacted} ${counts}`,
    }).catch(() => undefined);
    this.logger.log(`orqa knowledge synced items=${body.items.length} facts=${body.facts.length} ${counts}`);
    return 'synced';
  }

  private async fail(userId: string, businessId: string, code: string): Promise<PushOutcome> {
    await this.deps.cursors.failed(userId, businessId, code).catch(() => undefined);
    this.logger.warn(`orqa knowledge sync failed code=${code}`);
    return 'failed';
  }
}

export class KnowledgeSyncStore {
  constructor(private readonly database: Database) {}

  async get(userId: string, businessId: string): Promise<KnowledgeCursor | null> {
    const result = await this.database.pool.query(
      'SELECT last_synced_version, status, attempts FROM assistant.brain_knowledge_sync WHERE user_id = $1 AND business_id = $2',
      [userId, businessId]);
    const row = result.rows[0] as {last_synced_version: unknown; status: unknown; attempts: unknown} | undefined;
    return row ? {lastSyncedVersion: Number(row.last_synced_version), status: row.status as KnowledgeCursor['status'], attempts: Number(row.attempts)} : null;
  }

  async ok(userId: string, businessId: string, version: number): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO assistant.brain_knowledge_sync (user_id, business_id, last_synced_version, status, attempts, last_error_code, updated_at)
       VALUES ($1, $2, $3, 'ok', 0, NULL, NOW())
       ON CONFLICT (user_id, business_id) DO UPDATE SET last_synced_version = GREATEST(assistant.brain_knowledge_sync.last_synced_version, EXCLUDED.last_synced_version),
         status = 'ok', attempts = 0, last_error_code = NULL, updated_at = NOW()`,
      [userId, businessId, version]);
  }

  async failed(userId: string, businessId: string, code: string): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO assistant.brain_knowledge_sync (user_id, business_id, status, attempts, last_error_code, updated_at)
       VALUES ($1, $2, 'failed', 1, $3, NOW())
       ON CONFLICT (user_id, business_id) DO UPDATE SET status = 'failed', attempts = assistant.brain_knowledge_sync.attempts + 1,
         last_error_code = EXCLUDED.last_error_code, updated_at = NOW()`,
      [userId, businessId, code.slice(0, 40)]);
  }
}
