import {randomUUID} from 'node:crypto';
import type {
  AdminLesson, CatalogItem, CatalogView, LessonShareRequest, LessonShareResponse, OwnerLesson, PublishRequest, PublishResponse, SharingPreference,
} from './contracts';
import {LessonStatus} from './contracts';
import {forbidden, invalid, notFound, rejected} from './errors';
import {findPii} from './pii';
import type {BrainHubRepository, LessonRow} from './repository';

const SHAREABLE = new Set(['owner_said', 'owner_decided']);

export interface BrainHubDeps {
  repository: BrainHubRepository;
  /** User ids (sub de Keycloak) con acceso a la API admin: el owner y Juan. */
  admins: ReadonlySet<string>;
  now?: () => Date;
}

const ownerLesson = (row: LessonRow): OwnerLesson => ({
  id: row.id, industry_slug: row.industry_slug, text: row.text, status: row.status, created_at: row.created_at.toISOString(),
});

/**
 * Buzón del Cerebro SaleADS (ORQA cliente, OSB-015, ADR0020).
 *
 * - Solo entran lecciones de lo que el dueño dice o decide; procedencia de
 *   plataforma o datos personales → 422 sin escribir.
 * - Compartir viene activado por defecto; quien sale no envía, pero sigue
 *   recibiendo habilidades.
 * - Un admin de la lista blanca valida, rechaza, publica y retira.
 */
export class BrainHubService {
  private readonly now: () => Date;

  constructor(private readonly deps: BrainHubDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async shareLesson(userId: string, input: LessonShareRequest): Promise<LessonShareResponse> {
    if (!SHAREABLE.has(input.provenance)) throw rejected();
    if (findPii(input.text)) throw rejected();
    if (!(await this.sharing(userId)).enabled) return {accepted: false, lesson_id: null, reason: 'sharing_off'};
    const id = randomUUID();
    await this.deps.repository.insertLesson({
      id, user_id: userId, business_id: input.business_id, industry_slug: input.industry_slug, text: input.text,
      provenance: input.provenance as LessonRow['provenance'],
    });
    return {accepted: true, lesson_id: id, reason: 'received'};
  }

  async ownerLessons(userId: string): Promise<OwnerLesson[]> {
    return (await this.deps.repository.lessonsOfUser(userId, 100)).map(ownerLesson);
  }

  async sharing(userId: string): Promise<SharingPreference> {
    const row = await this.deps.repository.sharing(userId);
    return {enabled: !row?.opted_out_at, notice_pending: !row?.notice_ack_at};
  }

  /** Compartir no se apaga (D46/D47): el consentimiento va en los términos. Solo se puede (re)activar. */
  async setSharing(userId: string, enabled: boolean): Promise<SharingPreference> {
    if (!enabled) throw invalid();
    await this.deps.repository.setOptOut(userId, null);
    return this.sharing(userId);
  }

  async ackNotice(userId: string): Promise<SharingPreference> {
    await this.deps.repository.ackNotice(userId, this.now());
    return this.sharing(userId);
  }

  // ---- Admin ---------------------------------------------------------------

  async adminLessons(adminId: string, filter: {industry?: string; status?: string}): Promise<AdminLesson[]> {
    this.assertAdmin(adminId);
    const status = filter.status === undefined ? undefined : LessonStatus.safeParse(filter.status);
    if (status && !status.success) throw invalid();
    const rows = await this.deps.repository.lessons({industry: filter.industry, status: status?.data}, 200);
    return rows.map(row => ({...ownerLesson(row), provenance: row.provenance, catalog_item_id: row.catalog_item_id}));
  }

  async validate(adminId: string, lessonId: string): Promise<void> {
    this.assertAdmin(adminId);
    if (!(await this.deps.repository.reviewLesson(lessonId, ['received'], 'validated', adminId, this.now()))) await this.missingOrConflict(lessonId);
  }

  async reject(adminId: string, lessonId: string): Promise<void> {
    this.assertAdmin(adminId);
    if (!(await this.deps.repository.reviewLesson(lessonId, ['received', 'validated'], 'rejected', adminId, this.now()))) await this.missingOrConflict(lessonId);
  }

  /** Publica una lección validada como habilidad del catálogo, con versión y procedencia. */
  async publish(adminId: string, lessonId: string, input: PublishRequest): Promise<PublishResponse> {
    this.assertAdmin(adminId);
    const lesson = await this.deps.repository.lesson(lessonId);
    if (!lesson) throw notFound();
    if (lesson.status !== 'validated') throw invalid();
    const versions = await this.deps.repository.itemVersions(input.item_id);
    const version = `1.${versions.length}.0`;
    await this.deps.repository.supersedeActive(input.item_id);
    await this.deps.repository.insertItem({
      id: input.item_id, version, kind: 'skill', source: 'validated_lesson', industry_slug: lesson.industry_slug,
      name: input.name, summary: input.summary, status: 'active',
      files: {'SKILL.md': skillMarkdown(input, lesson)},
      provenance: {lesson_id: lesson.id, reviewer_id: adminId, origin: lesson.provenance},
    });
    await this.deps.repository.reviewLesson(lessonId, ['validated'], 'published', adminId, this.now(), input.item_id);
    return {catalog_item_id: input.item_id, version};
  }

  /** Catálogo publicado (activo) para el buzón admin, con la acción retirar (OSF-005). */
  async adminCatalog(adminId: string): Promise<CatalogItem[]> {
    this.assertAdmin(adminId);
    return this.deps.repository.allActive();
  }

  /** Retira un ítem: deja de ofrecerse; quien lo tiene recibe la propuesta de desinstalar (OSB-016). */
  async retire(adminId: string, itemId: string): Promise<void> {
    this.assertAdmin(adminId);
    if (!(await this.deps.repository.retireActive(itemId))) throw notFound();
  }

  async setIndustry(businessId: string, industry: string): Promise<void> {
    await this.deps.repository.setIndustry(businessId, industry, this.now());
  }

  /** Catálogo para un negocio (OSB-016). `industry` la manda el MCP; sin ella se usa la guardada. */
  async catalogFor(userId: string, businessId: string, industry?: string): Promise<CatalogView> {
    if (industry) await this.setIndustry(businessId, industry);
    const slug = industry ?? (await this.deps.repository.industry(businessId));
    const [items, installs] = await Promise.all([this.deps.repository.activeCatalog(slug), this.deps.repository.installs(userId)]);
    const byItem = new Map(installs.map(row => [row.item_id, row]));
    const installed: CatalogItem[] = [];
    const retired: CatalogItem[] = [];
    for (const row of installs.filter(install => install.status === 'installed')) {
      const item = await this.deps.repository.itemVersion(row.item_id, row.version);
      if (!item) continue;
      const active = await this.deps.repository.activeItem(row.item_id);
      (active ? installed : retired).push(item);
    }
    const available = items.filter(item => {
      const install = byItem.get(item.id);
      return !install || (install.status === 'uninstalled') || (install.status === 'installed' && install.version !== item.version);
    });
    return {industry_slug: slug, available, installed, retired_installed: retired};
  }

  async recordInstall(userId: string, itemId: string, version: string, status: 'proposed' | 'installed' | 'rejected' | 'uninstalled'): Promise<void> {
    await this.deps.repository.setInstall(userId, itemId, version, status, this.now());
  }

  async installedFiles(userId: string): Promise<Array<{item_id: string; files: Record<string, unknown>}>> {
    return this.deps.repository.installedFiles(userId);
  }

  async installedVersion(userId: string, itemId: string): Promise<string | null> {
    const row = (await this.deps.repository.installs(userId)).find(install => install.item_id === itemId && install.status === 'installed');
    return row?.version ?? null;
  }

  async itemVersion(itemId: string, version: string): Promise<CatalogItem | null> {
    return this.deps.repository.itemVersion(itemId, version);
  }

  async activeItem(itemId: string): Promise<CatalogItem | null> {
    return this.deps.repository.activeItem(itemId);
  }

  async catalog(industry: string | null): Promise<CatalogItem[]> {
    return this.deps.repository.activeCatalog(industry);
  }

  private assertAdmin(userId: string): void {
    if (!this.deps.admins.has(userId)) throw forbidden();
  }

  private async missingOrConflict(lessonId: string): Promise<never> {
    if (!(await this.deps.repository.lesson(lessonId))) throw notFound();
    throw invalid();
  }
}

/** Skill mínima de Hermes a partir de la lección validada (el admin escribe nombre y resumen). */
function skillMarkdown(input: PublishRequest, lesson: LessonRow): string {
  const slug = input.item_id.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(input.summary ?? input.name)}`,
    'version: 1.0.0',
    'metadata:',
    '  hermes:',
    '    category: saleads-collective',
    `    tags: [saleads, ${lesson.industry_slug}]`,
    '---',
    '',
    `# ${input.name}`,
    '',
    'Lección validada del Cerebro SaleADS (sin datos de otros negocios). Úsala como criterio, no como regla fija:',
    '',
    lesson.text,
    '',
  ].join('\n');
}
