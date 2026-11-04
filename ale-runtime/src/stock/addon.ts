import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, posix, relative, sep} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import type {AgentBundle, BundleJob} from '../activation/hermes-files';
import type {StockSettings} from './config';

/**
 * Complemento por usuario sobre un bundle inmutable. Solo el usuario habilitado recibe el `AgentBundle` efectivo: sin
 * habilitar, `OrqaSync` usa la referencia original y cada llave `hermes-*` queda byte a byte igual.
 */
export interface StockAddon {
  readonly variant: string;
  /** Skills raíz con ruta relativa a `skills/`. También viajan cuando `SkillsWriter` reescribe la metadata. */
  readonly skills: Readonly<Record<string, string>>;
  readonly jobs: readonly BundleJob[];
  /** O-7: imagen de Brain que conoce el rol `stock`. Solo para habilitados. */
  readonly brainImage: string;
  enabledFor(userId: string): boolean;
  /** `hermes-extensions` con el catálogo ampliado. Mismos nombres de archivo: el watcher no cambia. */
  extensions(base: string): string;
  merge(bundle: AgentBundle): AgentBundle;
  /** O-10: lo que Ale no debe ver aunque el MCP se lo ofrezca. Vacío para quien no está habilitado. */
  saleadsExclude(userId: string): readonly string[];
}

/** O-10, posible por S-41: Ale lee texto de terceros, así que estas cuatro quedan solo en el perfil Stock. */
export const ALE_EXCLUDED_TOOLS = Object.freeze([
  'saleads_stock_supplier_send', 'saleads_stock_take_photo', 'saleads_stock_supplier_wait', 'saleads_stock_document_extract',
]);

const INVALID = 'BUNDLE_INVALID_STOCK_ADDON';
const MARKERS = /^<!-- stock:start -->\n[\s\S]+\n<!-- stock:end -->\n?$/;
const SKILL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const JOB_NAME = /^saleads:[a-z0-9-]{1,64}$/;
/** No viajan a la VM ni entran al manifiesto. */
const NOT_SHIPPED = new Set(['manifest.json', 'validate.py']);
/** Solo cambia contenido de archivos que la lista cerrada del watcher ya admite. */
const ROLE_OVERLAY = {
  'plugins/saleads-continuity/role-catalog.json': 'rol/role-catalog.json',
  'plugins/saleads-memory/contracts/knowledge-candidate.schema.json': 'rol/knowledge-candidate.schema.json',
  'plugins/saleads-memory/contracts/specialist-experience.schema.json': 'rol/specialist-experience.schema.json',
  // F-R6a: copia de memory.py que no deja entrar al turno las inferencias sin confirmar. Solo para usuarios de Stock, para
  // no cambiar `hermes-extensions` de nadie más; se lleva a la base cuando el filtro pase a ser general.
  'plugins/saleads-memory/memory.py': 'rol/memory.py',
} as const;

interface Manifest {schema: string; variant: string; base_bundle: string; files: Record<string, string>}

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (name === '__pycache__') continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path);
      else found.push(relative(root, path).split(sep).join(posix.sep));
    }
  };
  visit(root);
  return found;
}

/** Un manifiesto que no coincide con los archivos es un paquete adulterado o incompleto: detiene el arranque. */
function verified(dir: string): {manifest: Manifest; files: Record<string, string>} {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(INVALID);
  let manifest: Manifest;
  try {manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;} catch {throw new Error(INVALID);}
  if (manifest.schema !== 'saleads-addon/1' || !manifest.variant || !manifest.files) throw new Error(INVALID);
  const names = walk(dir).filter(name => !NOT_SHIPPED.has(name));
  if (names.join('\n') !== Object.keys(manifest.files).sort().join('\n')) throw new Error(INVALID);
  const files: Record<string, string> = {};
  for (const name of names) {
    const body = readFileSync(join(dir, name));
    if (createHash('sha256').update(body).digest('hex') !== manifest.files[name]) throw new Error(INVALID);
    files[name] = body.toString('utf8');
  }
  return {manifest, files};
}

function untar(value: string): Record<string, string> {
  const tar = gunzipSync(Buffer.from(value, 'base64'));
  const files: Record<string, string> = {};
  const text = (from: number, to: number) => tar.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '');
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const name = text(at, at + 100), prefix = text(at + 345, at + 500);
    const size = Number.parseInt(text(at + 124, at + 136), 8);
    files[prefix ? `${prefix}/${name}` : name] = tar.subarray(at + 512, at + 512 + size).toString('utf8');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const under = (files: Record<string, string>, prefix: string) => Object.fromEntries(Object.entries(files)
  .filter(([path]) => path.startsWith(prefix)).map(([path, content]) => [path.slice(prefix.length), content]));

function parseJobs(raw: string | undefined, skills: Record<string, string>): BundleJob[] {
  if (!raw) throw new Error(INVALID);
  let body: {schema?: unknown; jobs?: unknown};
  try {body = JSON.parse(raw) as typeof body;} catch {throw new Error(INVALID);}
  if (body.schema !== 'saleads-jobs/1' || !Array.isArray(body.jobs)) throw new Error(INVALID);
  const jobs = body.jobs as BundleJob[];
  for (const job of jobs) {
    if (!JOB_NAME.test(job.name) || job.schedule.trim().split(/\s+/).length !== 5 || !job.prompt || job.prompt.length > 5000
      || !job.skills.every(skill => `${skill}/SKILL.md` in skills)) throw new Error(INVALID);
  }
  return jobs;
}

/** Apagado no lee el disco. Encendido, un paquete inválido o de otra base falla al arrancar: `STOCK_ENABLED` es explícito. */
export function loadStockAddon(settings: Pick<StockSettings, 'enabled' | 'userIds'>, dir: string, baseVersion: string,
  role: {brainImage: string; tar: (files: Record<string, string>) => Buffer}): StockAddon | undefined {
  if (!settings.enabled) return undefined;
  // O-7: sin esta imagen el rol `stock` no existe en Brain y su token sería rechazado.
  if (settings.userIds.size && !role.brainImage) throw new Error('CONFIGURATION_INVALID: STOCK_BRAIN_IMAGE');
  const {manifest, files} = verified(dir);
  if (manifest.base_bundle !== baseVersion) throw new Error(INVALID);
  const addendum = files['SOUL.addendum.md'], soul = files['profiles/stock/SOUL.md'];
  if (!addendum || !MARKERS.test(addendum) || !soul?.trim()) throw new Error(INVALID);
  const skills = under(files, 'skills/');
  if (Object.keys(skills).some(path => !SKILL_PATH.test(path)) || !('saleads-stock-orchestration/SKILL.md' in skills)) throw new Error(INVALID);
  const jobs = parseJobs(files['jobs.json'], skills);
  const profileSkills = {stock: under(files, 'profiles/stock/skills/'), investigador: under(files, 'profiles/investigador/skills/')};
  if (Object.values(ROLE_OVERLAY).some(path => !files[path])) throw new Error(INVALID);
  const merged = new WeakMap<AgentBundle, AgentBundle>();
  const overlaid = new Map<string, string>();
  const enabledFor = (userId: string) => settings.userIds.has(userId);
  return {
    variant: manifest.variant, skills, jobs, enabledFor, brainImage: role.brainImage,
    extensions(base) {
      const known = overlaid.get(base);
      if (known) return known;
      const entries = untar(base);
      for (const [entry, path] of Object.entries(ROLE_OVERLAY)) {
        if (!(entry in entries)) throw new Error(INVALID);
        entries[entry] = files[path]!;
      }
      const value = gzipSync(role.tar(entries), {level: 9}).toString('base64');
      overlaid.set(base, value);
      return value;
    },
    saleadsExclude: userId => enabledFor(userId) ? ALE_EXCLUDED_TOOLS : [],
    merge(bundle) {
      const known = merged.get(bundle);
      if (known) return known;
      const all = {...JSON.parse(bundle.skills) as Record<string, string>, ...skills};
      const effective: AgentBundle = {
        ...bundle,
        version: `${bundle.version}+${manifest.variant}`,
        soul: `${bundle.soul.replace(/\n*$/, '\n')}\n${addendum}`,
        skills: JSON.stringify(Object.fromEntries(Object.keys(all).sort().map(key => [key, all[key]]))),
        profiles: {...bundle.profiles, stock: soul},
        profileSkills: {...bundle.profileSkills, ...profileSkills},
      };
      merged.set(bundle, effective);
      return effective;
    },
  };
}
