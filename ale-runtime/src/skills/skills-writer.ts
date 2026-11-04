import {ComputeError} from '../compute/compute-client';
import {gzipSync} from 'node:zlib';
import {metadataTar} from '../activation/metadata-archive';
import type {InstanceApi} from '../compute/instance-client';
import {withMetadataValues} from '../compute/metadata';
import type {BusinessTypeV1} from '../contracts/v1';
import type {AssistantRepository} from '../persistence/assistant-repository';

/** GCE limita cada valor de metadata a 256 KB; se deja margen. Superarlo es un error, nunca un truncado. */
export const MAX_SKILLS_METADATA_BYTES = 240_000;
export type SkillsMetadataEncoding = 'json' | 'tar.gz/base64';
/** The watcher already supports both formats; the bundle chooses only the wire representation. */
export function encodeSkillsMetadata(value: string, encoding: SkillsMetadataEncoding = 'json'): string {
  if (encoding === 'json') return value;
  const encoded = gzipSync(metadataTar(JSON.parse(value) as Record<string, string>), {level: 9}).toString('base64');
  if (Buffer.byteLength(encoded) > MAX_SKILLS_METADATA_BYTES) throw new SkillsTooLargeError(Buffer.byteLength(encoded));
  return encoded;
}
/** Carpeta de las skills instaladas desde el catálogo del Cerebro SaleADS (gestionadas por SaleADS). */
export const COLLECTIVE_DIR = 'saleads-collective';

export class SkillsTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super('SKILLS_METADATA_TOO_LARGE');
    this.name = 'SkillsTooLargeError';
  }
}

const PATH_PART = /^[A-Za-z0-9._-]+$/;
/** Skills de la estrategia de cada tipo de negocio (MLB-003): `types/<business_type>/<skill>/...`. */
const TYPE_PATH = /^types\/([^/]+)\//;

export type InstalledSkill = {item_id: string; files: Record<string, unknown>};

/**
 * Un solo constructor de `hermes-skills` (MLB-003): el bundle sin las carpetas
 * de tipo, más `types/<t>/` de cada tipo confirmado en los negocios del dueño
 * (la unión), más las skills instaladas del catálogo.
 */
export function composeSkills(bundleSkills: string, installed: ReadonlyArray<InstalledSkill>, types: ReadonlyArray<BusinessTypeV1>,
  extra?: Readonly<Record<string, string>>): string {
  const wanted = new Set<string>(types);
  const files = Object.fromEntries(Object.entries(JSON.parse(bundleSkills) as Record<string, string>).filter(([path]) => {
    const type = TYPE_PATH.exec(path)?.[1];
    return type === undefined || wanted.has(type);
  }));
  Object.assign(files, extra);
  for (const item of installed) {
    for (const [file, content] of Object.entries(item.files)) {
      const path = collectivePath(item.item_id, file);
      if (path && typeof content === 'string') files[path] = content;
    }
  }
  const value = JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(key => [key, files[key]])));
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SKILLS_METADATA_BYTES) throw new SkillsTooLargeError(bytes);
  return value;
}

/** Ruta segura dentro de skills/: saleads-collective/<item>/<archivo>. */
function collectivePath(itemId: string, file: string): string | null {
  const item = itemId.replace(/[^A-Za-z0-9._-]/g, '-');
  const parts = file.split('/');
  if (!PATH_PART.test(item) || !parts.every(part => PATH_PART.test(part) && part !== '..' && part !== '.')) return null;
  return [COLLECTIVE_DIR, item, ...parts].join('/');
}

/**
 * `hermes-skills` = bundle (con los tipos del dueño, MLB-003) + skills instaladas del catálogo (OSB-016). Se
 * reescribe completo, con claves ordenadas (ack estable), por setMetadata con
 * fingerprint (un 412 relee y reintenta una vez). El watcher borra solo las
 * skills que gestiona SaleADS (OSB-005), nunca las que crea el agente.
 */
export class SkillsWriter {
  constructor(
    private readonly bundleSkills: string,
    private readonly repository: Pick<AssistantRepository, 'findActive'>,
    private readonly instances: InstanceApi,
    /** Tipos confirmados en los negocios del dueño (MLB-002). */
    private readonly businessTypes: (userId: string) => Promise<ReadonlyArray<BusinessTypeV1>>,
    private readonly encoding: SkillsMetadataEncoding = 'json',
    /** Skills que este usuario suma al bundle. `apply` usa las mismas que `OrqaSync.desired`, o instalar una las borraría. */
    private readonly extraFor?: (userId: string) => Readonly<Record<string, string>> | undefined,
  ) {}

  compose(installed: ReadonlyArray<InstalledSkill>, types: ReadonlyArray<BusinessTypeV1>, extra?: Readonly<Record<string, string>>): string {
    return encodeSkillsMetadata(composeSkills(this.bundleSkills, installed, types, extra), this.encoding);
  }

  /** `deferred` sin VM o con la VM apagada: se aplica al crearla o en el próximo start. */
  async apply(userId: string, installed: ReadonlyArray<InstalledSkill>): Promise<'applied' | 'unchanged' | 'deferred'> {
    const value = this.compose(installed, await this.businessTypes(userId), this.extraFor?.(userId));
    const row = await this.repository.findActive(userId);
    if (!row?.instance_name) return 'deferred';
    for (let attempt = 1; ; attempt++) {
      const view = await this.instances.getInstance(row.instance_name);
      if (!view || view.status !== 'RUNNING') return 'deferred';
      if (view.items.find(item => item.key === 'hermes-skills')?.value === value) return 'unchanged';
      try {
        await this.instances.setMetadata(row.instance_name, view.fingerprint, withMetadataValues(view.items, {'hermes-skills': value}));
        return 'applied';
      } catch (error) {
        if (error instanceof ComputeError && error.status === 412 && attempt === 1) continue;
        throw error;
      }
    }
  }
}
