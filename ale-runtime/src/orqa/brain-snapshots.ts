import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {Logger} from '@nestjs/common';
import {ComputeError} from '../compute/compute-client';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import {
  BrainBusinessGraphV1, BrainBusinessGraphV2, BrainBusinessGraphV3, type BrainBusinessGraphV3 as BrainBusinessGraphV3Type, type BrainFactV3, BrainExplorerSnapshotAny,
  type BrainNodeV2, type BrainSnapshotDiffV1, type BrainSnapshotResponseV1, type BrainSnapshotResponseV2, type BrainSnapshotsResponseV1,
} from '../contracts/v1';
import {ServiceError} from '../domain/errors';
import type {AssistantRepository} from '../persistence/assistant-repository';
import type {Database} from '../persistence/database';

/**
 * Fotos del cerebro del negocio (ORQA OSB-010).
 *
 * - Rotación: `hermes-snapshot-url` es un PUT firmado V4 (application/gzip, 7
 *   días) a `brain-uploads/<user>/snapshot.json.gz`; se renueva a los 6 días.
 * - Ingesta: cuando `hermes/graph-snapshot` (sha256 que publica el watcher)
 *   cambia, baja el objeto, lo valida contra `saleads-explorer-snapshot/1`,
 *   descarta los negocios que no son del dueño y guarda una versión por negocio
 *   (`brain-snapshots/<user>/<business>/<version>.json`) solo si cambió.
 * - Lectura: línea de tiempo y versión por negocio, también con la VM apagada.
 *   Un negocio sin fotos del dueño (o ajeno) responde 404 NOT_FOUND.
 *
 * Ni la URL firmada ni el contenido de la foto van a logs o eventos.
 */

const SNAPSHOT_CONTENT_TYPE = 'application/json';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;

export interface SnapshotStorage {
  signedPutUrl(object: string, now: Date, ttlSeconds: number): Promise<string>;
  download(object: string, maxBytes: number): Promise<Buffer | null>;
  upload(object: string, body: Buffer, contentType: string): Promise<void>;
}

export interface BrainSnapshotOptions {
  /** Vigencia de la URL de subida (≤ 7 días, límite de V4). */
  uploadTtlSeconds: number;
  /** Se firma una URL nueva cuando la vigente tiene más de esto. */
  rotateAfterMs: number;
  debounceMs: number;
}

export interface BrainSnapshotDeps {
  repository: Pick<AssistantRepository, 'findActive' | 'appendEvent'>;
  instances: InstanceApi;
  storage: SnapshotStorage;
  store: BrainSnapshotStore;
  /** Negocios del dueño según el MCP con su token; null = no se pudo saber (no se guarda nada). */
  ownedBusinesses: (userId: string) => Promise<ReadonlySet<string> | null>;
  /** AAB-013: negocios del dueño con una versión nueva guardada (empuje a BI). Nunca bloquea ni hace fallar la ingesta. */
  onStored?: (userId: string, businessIds: readonly string[]) => void;
  now?: () => Date;
}

export type IngestResult = 'unchanged' | 'stored' | 'invalid' | 'no_owned_business' | 'no_snapshot' | 'skipped';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const uploadObjectName = (userId: string) => `brain-uploads/${userId}/snapshot.json.gz`;
const versionObjectName = (userId: string, businessId: string, version: number) => `brain-snapshots/${userId}/${businessId}/${version}.json`;

type GraphV1 = ReturnType<typeof BrainBusinessGraphV1.parse>;
export type GraphV2 = ReturnType<typeof BrainBusinessGraphV2.parse>;
/** Familias que el front v1 no conoce (MLB-014): se muestran como estrategia y aprendizaje. */
const FAMILY_TO_V1: Record<string, GraphV1['nodes'][number]['family']> = {bet: 'strategy', verdict: 'learning'};
const EMPTY_SECTIONS: GraphV2['sections'] = {
  my_business: [], active_bets: [], learned: [], did_not_work: [], your_corrections: [], to_confirm: [], history: [],
};

/** v2 → v1 para el front publicado: familias nuevas mapeadas y sin atributos extra. */
export function toGraphV1(graph: GraphV2): GraphV1 {
  return {
    business_id: graph.business_id,
    nodes: graph.nodes.map(n => ({
      id: n.id, type: n.type, family: FAMILY_TO_V1[n.family] ?? (n.family as GraphV1['nodes'][number]['family']), label: n.label,
      summary: n.summary, state: n.state, provenance: n.provenance, mentions: n.mentions, created_at: n.created_at,
    })),
    edges: graph.edges,
    stats: graph.stats,
  };
}

/** v1 → v2 para comparar versiones (atributos del loop vacíos). */
export function toGraphV2(graph: GraphV1): GraphV2 {
  return {
    ...graph,
    nodes: graph.nodes.map(n => ({
      ...n, type_label: n.type, stage: null, confidence: null, verification: '', valid_from: null, learned_at: null,
      superseded_by: null, scope: null, evidence_count: null, outcome: null,
    })),
    sections: EMPTY_SECTIONS,
  };
}

export const DIFF_KEYS: ReadonlyArray<keyof BrainNodeV2> = ['label', 'summary', 'state', 'stage', 'confidence', 'superseded_by', 'evidence_count', 'outcome', 'type'];

export function diffGraphs(from: GraphV2, to: GraphV2): Omit<BrainSnapshotDiffV1, 'from' | 'to'> {
  const before = new Map(from.nodes.map(n => [n.id, n]));
  const after = new Map(to.nodes.map(n => [n.id, n]));
  const added = to.nodes.filter(n => !before.has(n.id));
  const removed = from.nodes.filter(n => !after.has(n.id));
  const modified = to.nodes.flatMap(n => {
    const old = before.get(n.id);
    return old && DIFF_KEYS.some(key => old[key] !== n[key]) ? [{id: n.id, before: old, after: n}] : [];
  });
  return {added, removed, modified, counts: {added: added.length, removed: removed.length, modified: modified.length}};
}

/** `X-Goog-Date` de una URL firmada (YYYYMMDDTHHMMSSZ) → ms; null si no se puede leer. */
function signedAt(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const value = new URL(url).searchParams.get('X-Goog-Date') ?? '';
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    return match ? Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!) : null;
  } catch {
    return null;
  }
}

class SnapshotFailed extends Error {
  constructor(readonly reason: string) {super(reason);}
}

export class BrainSnapshotService {
  private readonly logger = new Logger('orqa-snapshots');
  private readonly running = new Map<string, Promise<IngestResult>>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly options: BrainSnapshotOptions, private readonly deps: BrainSnapshotDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Desde la readiness: con debounce por usuario. */
  onReady(userId: string): Promise<IngestResult | null> {
    const last = this.lastAttempt.get(userId);
    if (last !== undefined && this.now().getTime() - last < this.options.debounceMs) return Promise.resolve(null);
    return this.sync(userId);
  }

  /** Rota la URL si hace falta e ingiere la foto nueva. Una vez por usuario a la vez. */
  sync(userId: string): Promise<IngestResult> {
    const inFlight = this.running.get(userId);
    if (inFlight) return inFlight;
    this.lastAttempt.set(userId, this.now().getTime());
    const run = this.syncNow(userId)
      .catch(async error => {
        const reason = error instanceof SnapshotFailed ? error.reason : 'unexpected';
        this.logger.warn(`orqa snapshot sync failed reason=${reason}`);
        await this.deps.repository.appendEvent({userId, kind: 'orqa.snapshot_failed', phase: 'orqa', cause: 'unknown', detail: `reason=${reason}`})
          .catch(() => undefined);
        return 'skipped' as IngestResult;
      })
      .finally(() => this.running.delete(userId));
    this.running.set(userId, run);
    return run;
  }

  async timeline(userId: string, businessId: string, limit: number): Promise<BrainSnapshotsResponseV1> {
    const rows = await this.deps.store.timeline(userId, businessId, limit);
    if (!rows.length) throw new ServiceError('NOT_FOUND', 404);
    return {business_id: businessId, items: rows.map(summary)};
  }

  async version(userId: string, businessId: string, version: number): Promise<BrainSnapshotResponseV1> {
    const {row, graph} = await this.graph(userId, businessId, version);
    return {...summary(row), graph: toGraphV1(graph)};
  }

  /** Nodo de la última versión del negocio (para validar el feedback del dueño), o null. */
  async latestNode(userId: string, businessId: string, nodeId: string): Promise<BrainNodeV2 | null> {
    const last = await this.deps.store.latest(userId, businessId);
    if (!last) return null;
    try {
      const {graph} = await this.graph(userId, businessId, last.version);
      return graph.nodes.find(n => n.id === nodeId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * AAB-019/AAB-013: hechos tipados vigentes de una versión (o de la última). Una versión v1/v2 no tiene hechos: [].
   * Uso interno (empuje a BI); la web no los lee en esta ola.
   */
  async factsOf(userId: string, businessId: string, version?: number): Promise<{version: number; facts: BrainFactV3[]} | null> {
    const row = version === undefined ? await this.deps.store.latest(userId, businessId) : await this.deps.store.find(userId, businessId, version);
    if (!row) return null;
    if (row.schema_version !== 3) return {version: row.version, facts: []};
    const bytes = await this.deps.storage.download(row.object_path, MAX_JSON_BYTES).catch(() => null);
    if (!bytes) return null;
    try {
      const parsed = BrainBusinessGraphV3.safeParse(JSON.parse(bytes.toString('utf8')));
      return parsed.success && parsed.data.business_id === businessId ? {version: row.version, facts: parsed.data.facts} : null;
    } catch {
      return null;
    }
  }

  /** AAB-013: grafo (forma v2) y hechos de una versión, o null si no se puede leer. Uso interno (empuje a BI). */
  async syncSource(userId: string, businessId: string, version: number): Promise<{graph: GraphV2; facts: BrainFactV3[]} | null> {
    try {
      const {graph} = await this.graph(userId, businessId, version);
      const facts = await this.factsOf(userId, businessId, version);
      return facts ? {graph, facts: facts.facts} : null;
    } catch {
      return null;
    }
  }

  /** AAB-013: última versión guardada de cada negocio del dueño. */
  latestVersions(userId: string): Promise<Array<{businessId: string; version: number}>> {
    return this.deps.store.latestVersions(userId);
  }

  /** `?schema=2`: la forma v2 (una v1 guardada se eleva). */
  async versionV2(userId: string, businessId: string, version: number): Promise<BrainSnapshotResponseV2> {
    const {row, graph} = await this.graph(userId, businessId, version);
    return {...summary(row), graph};
  }

  async diff(userId: string, businessId: string, to: number, from: number): Promise<BrainSnapshotDiffV1> {
    const [a, b] = await Promise.all([this.graph(userId, businessId, from), this.graph(userId, businessId, to)]);
    return {from, to, ...diffGraphs(a.graph, b.graph)};
  }

  /** Versión guardada en forma v2. Ilegible, corrupta o de otro negocio → 404, nunca 500. */
  private async graph(userId: string, businessId: string, version: number): Promise<{row: SnapshotRow; graph: GraphV2}> {
    const row = await this.deps.store.find(userId, businessId, version);
    if (!row) throw new ServiceError('NOT_FOUND', 404);
    const bytes = await this.deps.storage.download(row.object_path, MAX_JSON_BYTES).catch(() => null);
    if (!bytes) throw new ServiceError('NOT_FOUND', 404);
    let graph: GraphV2 | null = null;
    try {
      const json: unknown = JSON.parse(bytes.toString('utf8'));
      if (row.schema_version === 3) {
        // v3 (AAB-019): se sirve en forma v2, sin `facts` (los lee `factsOf`).
        const parsed = BrainBusinessGraphV3.safeParse(json);
        graph = parsed.success ? withoutFacts(parsed.data) : null;
      } else if (row.schema_version === 2) {
        const parsed = BrainBusinessGraphV2.safeParse(json);
        graph = parsed.success ? parsed.data : null;
      } else {
        const parsed = BrainBusinessGraphV1.safeParse(json);
        graph = parsed.success ? toGraphV2(parsed.data) : null;
      }
    } catch {
      graph = null;
    }
    if (!graph || graph.business_id !== businessId) throw new ServiceError('NOT_FOUND', 404);
    return {row, graph};
  }

  private async syncNow(userId: string): Promise<IngestResult> {
    const row = await this.deps.repository.findActive(userId);
    if (!row?.instance_name) return 'skipped';
    const instance = row.instance_name;
    const view = await this.deps.instances.getInstance(instance);
    if (!view) return 'skipped';
    if (view.status === 'RUNNING') await this.rotate(userId, instance, view.items.find(item => item.key === 'hermes-snapshot-url')?.value);
    const sha = await this.deps.instances.guestAttribute(instance, 'hermes/graph-snapshot').catch(() => null);
    if (!sha || !SHA.test(sha)) return 'no_snapshot';
    if ((await this.deps.store.lastUpload(userId)) === sha) return 'unchanged';
    return this.ingest(userId, sha);
  }

  private async rotate(userId: string, instance: string, currentUrl: string | undefined): Promise<void> {
    const at = signedAt(currentUrl);
    if (at !== null && this.now().getTime() - at < this.options.rotateAfterMs) return;
    const url = await this.deps.storage.signedPutUrl(uploadObjectName(userId), this.now(), this.options.uploadTtlSeconds)
      .catch(() => {throw new SnapshotFailed('sign_failed');});
    for (let attempt = 1; ; attempt++) {
      const view = await this.deps.instances.getInstance(instance);
      if (!view || view.status !== 'RUNNING') return;
      try {
        await this.deps.instances.setMetadata(instance, view.fingerprint, withMetadataValues(view.items, {'hermes-snapshot-url': url}));
        return;
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) continue;
        throw new SnapshotFailed(error instanceof ComputeError ? `set_metadata status=${error.status}` : 'set_metadata');
      }
    }
  }

  private async ingest(userId: string, sha: string): Promise<IngestResult> {
    const gz = await this.deps.storage.download(uploadObjectName(userId), MAX_UPLOAD_BYTES).catch(() => {throw new SnapshotFailed('download_failed');});
    if (!gz) return 'no_snapshot';
    let parsed: ReturnType<typeof BrainExplorerSnapshotAny.parse> | null = null;
    try {
      const json = gunzipSync(gz, {maxOutputLength: MAX_JSON_BYTES});
      // v1 (imagen vieja del cerebro) o v2 (MLB-014), por el campo `schema`.
      const result = BrainExplorerSnapshotAny.safeParse(JSON.parse(json.toString('utf8')));
      if (result.success) parsed = result.data;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await this.deps.store.recordUpload(userId, sha, 'invalid', this.now());
      await this.deps.repository.appendEvent({userId, kind: 'orqa.snapshot_invalid', phase: 'orqa', cause: 'unknown', detail: 'reason=schema'});
      this.logger.warn('orqa snapshot invalid reason=schema');
      return 'invalid';
    }
    const owned = await this.deps.ownedBusinesses(userId);
    if (!owned) throw new SnapshotFailed('ownership_unknown');
    const generatedAt = Number.isNaN(Date.parse(parsed.generated_at)) ? null : new Date(parsed.generated_at);
    let stored = 0;
    let foreign = 0;
    const storedBusinesses: string[] = [];
    const schemaVersion = parsed.schema === 'saleads-explorer-snapshot/3' ? 3 : parsed.schema === 'saleads-explorer-snapshot/2' ? 2 : 1;
    for (const graph of parsed.businesses) {
      if (!owned.has(graph.business_id)) {foreign++; continue;}
      const body = Buffer.from(JSON.stringify(graph), 'utf8');
      const graphSha = sha256(body);
      const last = await this.deps.store.latest(userId, graph.business_id);
      if (last?.sha256 === graphSha) continue;
      const version = (last?.version ?? 0) + 1;
      const object = versionObjectName(userId, graph.business_id, version);
      await this.deps.storage.upload(object, body, SNAPSHOT_CONTENT_TYPE).catch(() => {throw new SnapshotFailed('upload_failed');});
      await this.deps.store.insert({
        user_id: userId, business_id: graph.business_id, version, object_path: object, sha256: graphSha,
        node_count: graph.nodes.length, edge_count: graph.edges.length, generated_at: generatedAt, created_at: this.now(),
        schema_version: schemaVersion,
      });
      stored++;
      storedBusinesses.push(graph.business_id);
    }
    const outcome = parsed.businesses.length > foreign ? 'stored' : 'no_owned_business';
    await this.deps.store.recordUpload(userId, sha, outcome, this.now());
    await this.deps.repository.appendEvent({
      userId, kind: 'orqa.snapshot_ingested', phase: 'orqa', detail: `outcome=${outcome} versions=${stored} foreign=${foreign}`,
    });
    this.logger.log(`orqa snapshot ingested outcome=${outcome} versions=${stored} foreign=${foreign}`);
    if (storedBusinesses.length) {
      try {this.deps.onStored?.(userId, storedBusinesses);} catch {/* el empuje nunca afecta la ingesta */}
    }
    return outcome;
  }
}

export interface SnapshotRow {
  user_id: string;
  business_id: string;
  version: number;
  object_path: string;
  sha256: string;
  node_count: number;
  edge_count: number;
  generated_at: Date | null;
  created_at: Date;
  /** V8/V10: esquema de la foto guardada (1, 2 o 3). */
  schema_version: 1 | 2 | 3;
}

const summary = (row: SnapshotRow) => ({
  version: row.version,
  created_at: row.created_at.toISOString(),
  generated_at: row.generated_at ? row.generated_at.toISOString() : null,
  node_count: row.node_count,
  edge_count: row.edge_count,
});

const COLUMNS = 'user_id, business_id::text AS business_id, version, object_path, sha256, node_count, edge_count, generated_at, created_at, schema_version';

export class BrainSnapshotStore {
  constructor(private readonly database: Database) {}

  private async query(sql: string, params: unknown[]): Promise<SnapshotRow[]> {
    const result = await this.database.pool.query(sql, params);
    return result.rows.map(raw => {
      const row = raw as Record<string, unknown>;
      return {
        user_id: String(row.user_id), business_id: String(row.business_id), version: Number(row.version),
        object_path: String(row.object_path), sha256: String(row.sha256), node_count: Number(row.node_count),
        edge_count: Number(row.edge_count), generated_at: row.generated_at ? new Date(row.generated_at as string) : null,
        created_at: new Date(row.created_at as string),
        schema_version: Number(row.schema_version) === 3 ? 3 : Number(row.schema_version) === 2 ? 2 : 1,
      };
    });
  }

  async timeline(userId: string, businessId: string, limit: number): Promise<SnapshotRow[]> {
    return this.query(`SELECT ${COLUMNS} FROM assistant.brain_snapshots WHERE user_id = $1 AND business_id = $2 ORDER BY version DESC LIMIT $3`,
      [userId, businessId, limit]);
  }

  async find(userId: string, businessId: string, version: number): Promise<SnapshotRow | null> {
    const [row] = await this.query(`SELECT ${COLUMNS} FROM assistant.brain_snapshots WHERE user_id = $1 AND business_id = $2 AND version = $3`,
      [userId, businessId, version]);
    return row ?? null;
  }

  async latest(userId: string, businessId: string): Promise<SnapshotRow | null> {
    return (await this.timeline(userId, businessId, 1))[0] ?? null;
  }

  async latestVersions(userId: string): Promise<Array<{businessId: string; version: number}>> {
    const result = await this.database.pool.query(
      'SELECT business_id::text AS business_id, MAX(version) AS version FROM assistant.brain_snapshots WHERE user_id = $1 GROUP BY business_id ORDER BY business_id',
      [userId]);
    return result.rows.map(raw => {
      const row = raw as {business_id: unknown; version: unknown};
      return {businessId: String(row.business_id), version: Number(row.version)};
    });
  }

  async insert(row: SnapshotRow): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO assistant.brain_snapshots (user_id, business_id, version, object_path, sha256, node_count, edge_count, generated_at, created_at,
         schema_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.user_id, row.business_id, row.version, row.object_path, row.sha256, row.node_count, row.edge_count, row.generated_at, row.created_at,
        row.schema_version]);
  }

  async lastUpload(userId: string): Promise<string | null> {
    // Una subida marcada inválida se vuelve a intentar (p. ej. una v2 antes de que el servicio la entendiera).
    const result = await this.database.pool.query(
      "SELECT sha256 FROM assistant.brain_snapshot_uploads WHERE user_id = $1 AND outcome <> 'invalid'", [userId]);
    const row = result.rows[0] as {sha256?: unknown} | undefined;
    return typeof row?.sha256 === 'string' ? row.sha256 : null;
  }

  async recordUpload(userId: string, sha: string, outcome: 'stored' | 'invalid' | 'no_owned_business', now: Date): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO assistant.brain_snapshot_uploads (user_id, sha256, outcome, processed_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET sha256 = EXCLUDED.sha256, outcome = EXCLUDED.outcome, processed_at = EXCLUDED.processed_at`,
      [userId, sha, outcome, now]);
  }
}

/** v3 → forma v2: el front y el diff no ven `facts`. */
function withoutFacts(graph: BrainBusinessGraphV3Type): GraphV2 {
  return {business_id: graph.business_id, nodes: graph.nodes, edges: graph.edges, stats: graph.stats, sections: graph.sections};
}
