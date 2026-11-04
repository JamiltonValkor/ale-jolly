import type {CatalogItem, LessonStatus} from './contracts';

/** Lo único que el módulo necesita de Postgres (lo cumple `pg.Pool`). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{rows: unknown[]; rowCount?: number | null}>;
}

export interface InstallRow {
  item_id: string;
  version: string;
  status: 'proposed' | 'installed' | 'rejected' | 'uninstalled';
}

export interface LessonRow {
  id: string;
  user_id: string;
  business_id: string;
  industry_slug: string;
  text: string;
  provenance: 'owner_said' | 'owner_decided';
  status: LessonStatus;
  catalog_item_id: string | null;
  created_at: Date;
}

const LESSON = 'id, user_id, business_id, industry_slug, text, provenance, status, catalog_item_id, created_at';
const ITEM = 'id, version, kind, source, industry_slug, name, summary, status';

/** Todo el SQL `brain_hub.` vive aquí (test de aislamiento). */
export class BrainHubRepository {
  constructor(private readonly db: Queryable) {}

  async insertLesson(row: Omit<LessonRow, 'status' | 'catalog_item_id' | 'created_at'>): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.lessons (id, user_id, business_id, industry_slug, text, provenance) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.user_id, row.business_id, row.industry_slug, row.text, row.provenance]);
  }

  async lessonsOfUser(userId: string, limit: number): Promise<LessonRow[]> {
    const {rows} = await this.db.query(`SELECT ${LESSON} FROM brain_hub.lessons WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return rows as LessonRow[];
  }

  async lessons(filter: {industry?: string; status?: LessonStatus}, limit: number): Promise<LessonRow[]> {
    const {rows} = await this.db.query(
      `SELECT ${LESSON} FROM brain_hub.lessons
        WHERE ($1::text IS NULL OR industry_slug=$1) AND ($2::text IS NULL OR status=$2)
        ORDER BY created_at DESC LIMIT $3`,
      [filter.industry ?? null, filter.status ?? null, limit]);
    return rows as LessonRow[];
  }

  async lesson(id: string): Promise<LessonRow | null> {
    const {rows} = await this.db.query(`SELECT ${LESSON} FROM brain_hub.lessons WHERE id=$1`, [id]);
    return (rows[0] as LessonRow | undefined) ?? null;
  }

  async reviewLesson(id: string, from: LessonStatus[], to: LessonStatus, reviewer: string, now: Date, catalogItemId?: string): Promise<boolean> {
    const {rows} = await this.db.query(
      `UPDATE brain_hub.lessons SET status=$3, reviewer_id=$4, reviewed_at=$5, catalog_item_id=COALESCE($6, catalog_item_id)
        WHERE id=$1 AND status = ANY($2::text[]) RETURNING id`,
      [id, from, to, reviewer, now, catalogItemId ?? null]);
    return rows.length === 1;
  }

  async sharing(userId: string): Promise<{opted_out_at: Date | null; notice_ack_at: Date | null} | null> {
    const {rows} = await this.db.query('SELECT opted_out_at, notice_ack_at FROM brain_hub.sharing_preferences WHERE user_id=$1', [userId]);
    return (rows[0] as {opted_out_at: Date | null; notice_ack_at: Date | null} | undefined) ?? null;
  }

  async setOptOut(userId: string, optedOutAt: Date | null): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.sharing_preferences (user_id, opted_out_at) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET opted_out_at=EXCLUDED.opted_out_at`, [userId, optedOutAt]);
  }

  async ackNotice(userId: string, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.sharing_preferences (user_id, notice_ack_at) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET notice_ack_at=COALESCE(brain_hub.sharing_preferences.notice_ack_at, EXCLUDED.notice_ack_at)`, [userId, now]);
  }

  async activeItem(id: string): Promise<CatalogItem | null> {
    const {rows} = await this.db.query(`SELECT ${ITEM} FROM brain_hub.catalog_items WHERE id=$1 AND status='active'`, [id]);
    return (rows[0] as CatalogItem | undefined) ?? null;
  }

  async itemVersions(id: string): Promise<string[]> {
    const {rows} = await this.db.query('SELECT version FROM brain_hub.catalog_items WHERE id=$1', [id]);
    return (rows as Array<{version: string}>).map(row => row.version);
  }

  async insertItem(item: CatalogItem & {files: Record<string, unknown>; provenance: Record<string, unknown>}): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.catalog_items (id, version, kind, source, industry_slug, name, summary, files, provenance, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [item.id, item.version, item.kind, item.source, item.industry_slug, item.name, item.summary,
        JSON.stringify(item.files), JSON.stringify(item.provenance), item.status]);
  }

  /** Una versión nueva reemplaza a la activa (no es un retiro: no propone desinstalar). */
  async supersedeActive(id: string): Promise<void> {
    await this.db.query(`UPDATE brain_hub.catalog_items SET status='superseded' WHERE id=$1 AND status='active'`, [id]);
  }

  async retireActive(id: string): Promise<boolean> {
    const {rows} = await this.db.query(`UPDATE brain_hub.catalog_items SET status='retired' WHERE id=$1 AND status='active' RETURNING id`, [id]);
    return rows.length === 1;
  }

  async setIndustry(businessId: string, industry: string, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.business_industries (business_id, industry_slug, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (business_id) DO UPDATE SET industry_slug=EXCLUDED.industry_slug, updated_at=EXCLUDED.updated_at`, [businessId, industry, now]);
  }

  async industry(businessId: string): Promise<string | null> {
    const {rows} = await this.db.query('SELECT industry_slug FROM brain_hub.business_industries WHERE business_id=$1', [businessId]);
    return (rows[0] as {industry_slug: string} | undefined)?.industry_slug ?? null;
  }

  async installs(userId: string): Promise<InstallRow[]> {
    const {rows} = await this.db.query('SELECT item_id, version, status FROM brain_hub.installs WHERE user_id=$1 ORDER BY item_id', [userId]);
    return rows as InstallRow[];
  }

  async setInstall(userId: string, itemId: string, version: string, status: InstallRow['status'], now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO brain_hub.installs (user_id, item_id, version, status, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, item_id) DO UPDATE SET version=EXCLUDED.version, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
      [userId, itemId, version, status, now]);
  }

  /** Archivos de las versiones instaladas (incluidas las retiradas: siguen instaladas hasta desinstalar). */
  async installedFiles(userId: string): Promise<Array<{item_id: string; files: Record<string, unknown>}>> {
    const {rows} = await this.db.query(
      `SELECT c.id AS item_id, c.files FROM brain_hub.installs i
         JOIN brain_hub.catalog_items c ON c.id=i.item_id AND c.version=i.version
        WHERE i.user_id=$1 AND i.status='installed' ORDER BY c.id`, [userId]);
    return rows as Array<{item_id: string; files: Record<string, unknown>}>;
  }

  async itemVersion(id: string, version: string): Promise<CatalogItem | null> {
    const {rows} = await this.db.query(`SELECT ${ITEM} FROM brain_hub.catalog_items WHERE id=$1 AND version=$2`, [id, version]);
    return (rows[0] as CatalogItem | undefined) ?? null;
  }

  /** Todos los ítems activos, de cualquier industria (buzón admin, OSF-005). */
  async allActive(): Promise<CatalogItem[]> {
    const {rows} = await this.db.query(`SELECT ${ITEM} FROM brain_hub.catalog_items WHERE status='active' ORDER BY industry_slug NULLS FIRST, source, name`, []);
    return rows as CatalogItem[];
  }

  async activeCatalog(industry: string | null): Promise<CatalogItem[]> {
    const {rows} = await this.db.query(
      `SELECT ${ITEM} FROM brain_hub.catalog_items WHERE status='active' AND (industry_slug IS NULL OR industry_slug=$1) ORDER BY source, name`,
      [industry]);
    return rows as CatalogItem[];
  }
}
