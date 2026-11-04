import {z} from 'zod';

/**
 * Contratos del buzón del Cerebro SaleADS (ORQA cliente, OSB-015, ADR0020).
 * Viven en el módulo para que pueda extraerse a un microservicio propio.
 */

const UserId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const IndustrySlug = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const ItemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/** Solo lo que el dueño dice o decide puede volverse lección (ADR0020). */
export const LessonShareRequest = z.object({
  business_id: z.uuid(),
  industry_slug: IndustrySlug,
  text: z.string().trim().min(20).max(1000),
  provenance: z.string().min(1).max(40),
}).strict();

export const LessonShareResponse = z.object({
  accepted: z.boolean(),
  lesson_id: z.uuid().nullable(),
  reason: z.enum(['received', 'sharing_off']).nullable(),
}).strict();

export const LessonStatus = z.enum(['received', 'validated', 'rejected', 'published']);

export const OwnerLesson = z.object({
  id: z.uuid(),
  industry_slug: IndustrySlug,
  text: z.string(),
  status: LessonStatus,
  created_at: z.iso.datetime({offset: true}),
}).strict();
export const OwnerLessonsResponse = z.object({lessons: z.array(OwnerLesson)}).strict();

export const AdminLesson = OwnerLesson.extend({
  provenance: z.enum(['owner_said', 'owner_decided']),
  catalog_item_id: z.string().nullable(),
}).strict();
export const AdminLessonsResponse = z.object({lessons: z.array(AdminLesson)}).strict();

export const SharingPreference = z.object({enabled: z.boolean(), notice_pending: z.boolean()}).strict();
/** Solo `true` (D46/D47): la API ya no permite apagar el compartir. */
export const SharingUpdateRequest = z.object({enabled: z.literal(true)}).strict();

export const PublishRequest = z.object({
  item_id: ItemId,
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).nullable(),
}).strict();
export const PublishResponse = z.object({catalog_item_id: ItemId, version: z.string()}).strict();

export const CatalogItem = z.object({
  id: ItemId,
  version: z.string(),
  kind: z.enum(['skill', 'mcp']),
  source: z.enum(['saleads_capability', 'industry_playbook', 'validated_lesson']),
  industry_slug: IndustrySlug.nullable(),
  name: z.string(),
  summary: z.string().nullable(),
  status: z.enum(['active', 'superseded', 'retired']),
}).strict();

export type LessonShareRequest = z.infer<typeof LessonShareRequest>;
export type LessonShareResponse = z.infer<typeof LessonShareResponse>;
export type OwnerLesson = z.infer<typeof OwnerLesson>;
export type AdminLesson = z.infer<typeof AdminLesson>;
export type SharingPreference = z.infer<typeof SharingPreference>;
export type PublishRequest = z.infer<typeof PublishRequest>;
export type PublishResponse = z.infer<typeof PublishResponse>;
export type CatalogItem = z.infer<typeof CatalogItem>;

/** `GET /assistants/admin/brain-hub/catalog`: lo publicado y activo. */
export const AdminCatalogResponse = z.object({items: z.array(CatalogItem)}).strict();
export type AdminCatalogResponse = z.infer<typeof AdminCatalogResponse>;

/** Catálogo de un negocio: lo disponible (sin lo instalado, propuesto ni rechazado) y lo instalado. */
export const CatalogView = z.object({
  industry_slug: IndustrySlug.nullable(),
  available: z.array(CatalogItem),
  installed: z.array(CatalogItem),
  /** Instalados que el admin retiró: se propone desinstalarlos una sola vez. */
  retired_installed: z.array(CatalogItem),
}).strict();
export type CatalogView = z.infer<typeof CatalogView>;
export type LessonStatus = z.infer<typeof LessonStatus>;
export type OwnerLessonsResponse = z.infer<typeof OwnerLessonsResponse>;
export type AdminLessonsResponse = z.infer<typeof AdminLessonsResponse>;
export {UserId};
