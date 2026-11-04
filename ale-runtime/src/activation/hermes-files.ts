import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {basename, dirname, join, posix, relative, sep} from 'node:path';
import type {HermesMetadata} from '../compute/metadata';
import type {AssistantTokenSet} from '../oauth/token-client';
import {composeSkills, encodeSkillsMetadata, type SkillsMetadataEncoding} from '../skills/skills-writer';
import {managedMetaConfigLines, META_API_BASE_URL, META_PROVIDER_ID} from '../ai/meta-model';

/**
 * Archivos que el servicio entrega a la VM por metadata (watcher de OCB-005,
 * vm/README.md). Ningún valor de aquí se registra en logs ni en eventos.
 */

export interface McpConfig {
  mcpUrl: string;
  clientId: string;
  scope: string;
  /**
   * ORQA cliente (OSB-009): MCP del cerebro del negocio en la red interna de la
   * VM. Con valor, `hermes-config` lo registra y pide aprobación para las skills
   * que escriba el agente; null = ORQA apagado (sin imagen del cerebro).
   */
  brainMcpUrl?: string | null;
  /** Herramientas de SaleADS que Ale no debe ver, por usuario. Sin valor, `hermes-config` no cambia. */
  saleadsExclude?: (userId: string) => readonly string[];
}

/** El contenedor del cerebro escucha en `hermes-net` con este nombre y puerto (brain/saleads_brain/settings.py). */
export const BRAIN_MCP_URL = 'http://saleads-brain:8765/mcp';
/** Modelo de la IA configurada (OCB-010). */
export interface ModelConfig { provider: string; model: string; baseUrl?: string }

/** Zona de Hermes cuando el dueño aún no envió la de su navegador (OCB-016). */
export const DEFAULT_TIMEZONE = 'America/Bogota';

const quote = (value: string) => JSON.stringify(value);

/**
 * ÚNICO constructor de `hermes-config` (OCB-016): lo usan la creación de la VM,
 * `PUT /ai`, `PUT /timezone` y el start. Lleva solo las claves de las que
 * SaleADS es dueña en config.yaml (el watcher fusiona y conserva lo demás):
 * - `model` si hay IA (sin modelo hasta OCB-010);
 * - `mcp_servers.saleads` en `auth: oauth` con los tokens de mcp-tokens/;
 * - `timezone` IANA (Hermes la lee: hermes_time.py, cron/jobs.py), con
 *   fallback America/Bogota;
 * - `approvals.mode: "off"` (que un approval.request no cuelgue el turno,
 *   OCB-011). "off" va entre comillas: en YAML 1.1 un off suelto es false.
 * - con ORQA (OSB-009): `mcp_servers.saleads-brain`.
 * - `skills.write_approval: true`: Ale no reescribe su manual. Decisión del owner del 24-oct (D4, cierre del MVP):
 *   en la corrida completa 1 Ale editó las skills del bundle en ejecución. Lo que aprende va a su memoria y al cerebro.
 * - `cron.wrap_response: false` y `display.file_mutation_verifier: false`: el aviso al dueño sale sin el encabezado
 *   de Hermes en inglés («Cronjob Response…») ni el pie «Run git status» (corrida completa 1).
 *   `auxiliary.background_review` ya viene activo por defecto en Hermes y no se gestiona.
 * Sin `fallback_providers`. El API server se enciende por `.env` (API_SERVER_*).
 */
export function hermesConfig(input: {mcp: McpConfig; model?: ModelConfig | null; timezone?: string | null; userId?: string}): string {
  const {mcp, model} = input;
  const lines: string[] = [];
  if (model) {
    const managed = model.provider === META_PROVIDER_ID
      ? `, base_url: ${quote(model.baseUrl ?? META_API_BASE_URL)}, api_key: "", api_mode: "codex_responses"` : '';
    lines.push(`model: { provider: ${quote(model.provider)}, default: ${quote(model.model)}${managed} }`);
  }
  if (model) lines.push(...managedMetaConfigLines(model.provider, model.baseUrl));
  lines.push(
    'mcp_servers:',
    '  saleads:',
    `    url: ${quote(mcp.mcpUrl)}`,
    '    auth: oauth',
    '    oauth:',
    `      client_id: ${quote(mcp.clientId)}`,
    `      scope: ${quote(mcp.scope)}`,
  );
  const excluded = input.userId ? mcp.saleadsExclude?.(input.userId) ?? [] : [];
  if (excluded.length) lines.push('    tools:', `      exclude: [${excluded.map(quote).join(', ')}]`);
  // Ale no investiga internet: web_buscar y web_leer son del investigador (MLB-005b).
  if (mcp.brainMcpUrl) lines.push('  saleads-brain:', `    url: ${quote(mcp.brainMcpUrl)}`, '    tools:', '      exclude: ["web_*"]');
  lines.push(
    `timezone: ${quote(input.timezone || DEFAULT_TIMEZONE)}`,
    'approvals:',
    '  mode: "off"',
    'skills:',
    '  write_approval: true',
    'cron:',
    '  wrap_response: false',
    'display:',
    '  file_mutation_verifier: false',
  );
  // Con ORQA hay ~70 herramientas y Hermes las difiere tras tool_search/tool_describe/tool_call;
  // DeepSeek describe la herramienta y cierra el turno vacío (dev 2026-11-03: share-lessons falló
  // 3 de 3 y respondió a la primera con todas las herramientas a la vista).
  if (mcp.brainMcpUrl) lines.push('tools:', '  tool_search:', '    enabled: "off"');
  // Tablero de los especialistas (MLB-005a, compuerta MLB-001): 2 workers caben en la e2-medium; sin
  // descomponer ni revisar solas (gastan IA); Ale queda suscrito a lo que crea.
  if (mcp.brainMcpUrl) {
    lines.push('kanban:', '  max_in_progress: 2', '  auto_decompose: false', '  review_dispatch: false', '  auto_subscribe_on_create: true');
  }
  return `${lines.join('\n')}\n`;
}

/** Modelo guardado en la fila (null si la IA no está configurada). */
export function modelOfRow(row: {ai_provider: string | null; ai_model: string | null}): ModelConfig | null {
  return row.ai_provider && row.ai_model ? {provider: row.ai_provider, model: row.ai_model} : null;
}

/**
 * `hermes-mcp-tokens`: JSON {"tokens.json": {...}} que el watcher escribe en
 * /opt/data/mcp-tokens/saleads.json (forma de prueba-real-dev.md). `expires_at`
 * es epoch absoluto en segundos. `hermes_issuer` es el issuer PÚBLICO.
 */
export function hermesMcpTokens(tokens: AssistantTokenSet, issuer: string, nowMs: number): string {
  return JSON.stringify({
    'tokens.json': {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
      expires_at: Math.floor(nowMs / 1000) + tokens.expiresIn,
      hermes_issuer: issuer,
    },
  });
}

/** Trabajo con agente de `jobs.json` (`saleads-jobs/1`, OSB-008/009). */
export interface BundleJob { name: string; schedule: string; prompt: string; skills: string[] }

/** SOUL + skills de distribution/<bundle>/<versión>/ (OCB-004) y sus trabajos programados (OSB-009). */
export interface AgentBundle {
  version: string;
  soul: string;
  skills: string;
  jobs: BundleJob[];
  /** SOUL de cada especialista (`profiles/<n>/SOUL.md`, bundle 1.3.0+); vacío = sin equipo. */
  profiles: Record<string, string>;
  /** Profile-local references travel compressed in hermes-profiles, never in root skills metadata. */
  profileSkills?: Record<string, Record<string, string>>;
  /** Existing watcher skill formats; omitted preserves historical JSON metadata. */
  skillsEncoding?: SkillsMetadataEncoding;
  /**
   * MCB-003 (D21): por nombre de trabajo, los `jobTextHash` de todas las versiones del bundle que trae la imagen
   * (`distribution/<bundle>/*`). Un trabajo vivo cuyo texto no está aquí lo editó alguien (D24): no se toca.
   */
  knownJobHashes: Record<string, string[]>;
  /** MCB-003 (D24): nombres de trabajos de cada versión (`<bundle>@<versión>`), para saber cuáles ya se crearon. */
  jobNamesByVersion: Record<string, string[]>;
}

/** Huella del texto de un trabajo: `prompt` y `skills` en su orden (Hermes antepone las skills en ese orden). */
export function jobTextHash(prompt: string, skills: ReadonlyArray<string>): string {
  return createHash('sha256').update(JSON.stringify([prompt, skills])).digest('hex');
}

/**
 * Catálogo de los `jobs.json` hermanos de `dir` (solo al arrancar). Una versión vieja ilegible se ignora: el
 * catálogo solo sirve para reconocer textos de SaleADS, nunca para crear trabajos.
 */
function loadJobCatalog(dir: string, version: string): Pick<AgentBundle, 'knownJobHashes' | 'jobNamesByVersion'> {
  const root = dirname(dir);
  const at = version.indexOf('@');
  const prefix = at > 0 ? version.slice(0, at) : basename(root);
  const hashes = new Map<string, Set<string>>();
  const jobNamesByVersion: Record<string, string[]> = {};
  const add = (key: string, jobs: BundleJob[]) => {
    jobNamesByVersion[key] = jobs.map(job => job.name);
    for (const job of jobs) {
      const known = hashes.get(job.name) ?? new Set<string>();
      known.add(jobTextHash(job.prompt, job.skills));
      hashes.set(job.name, known);
    }
  };
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    const sibling = join(root, name);
    let jobs: BundleJob[];
    try {
      if (sibling === join(dir) || !statSync(sibling).isDirectory()) continue;
      jobs = loadJobs(sibling);
    } catch {continue;}
    add(`${prefix}@${name}`, jobs);
  }
  add(version, loadJobs(dir));
  return {
    knownJobHashes: Object.fromEntries([...hashes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, set]) => [name, [...set].sort()])),
    jobNamesByVersion,
  };
}

const JOB_NAME = /^saleads:[a-z0-9-]{1,64}$/;

/** `jobs.json` opcional: sin archivo no hay trabajos (bundle 1.1.0). Un archivo inválido detiene el arranque. */
function loadJobs(dir: string): BundleJob[] {
  const path = join(dir, 'jobs.json');
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {parsed = JSON.parse(readFileSync(path, 'utf8'));} catch {throw new Error('BUNDLE_INVALID_JOBS');}
  const body = parsed as {schema?: unknown; jobs?: unknown} | null;
  if (body?.schema !== 'saleads-jobs/1' || !Array.isArray(body.jobs)) throw new Error('BUNDLE_INVALID_JOBS');
  const jobs = body.jobs.map(raw => {
    const job = raw as Partial<BundleJob> | null;
    const valid = job && typeof job.name === 'string' && JOB_NAME.test(job.name)
      && typeof job.schedule === 'string' && job.schedule.trim().split(/\s+/).length === 5
      && typeof job.prompt === 'string' && job.prompt.length > 0 && job.prompt.length <= 5000
      && Array.isArray(job.skills) && job.skills.every(skill => typeof skill === 'string');
    if (!valid) throw new Error('BUNDLE_INVALID_JOBS');
    return {name: job.name!, schedule: job.schedule!, prompt: job.prompt!, skills: [...job.skills!]};
  });
  if (new Set(jobs.map(job => job.name)).size !== jobs.length) throw new Error('BUNDLE_INVALID_JOBS');
  return jobs;
}

const SKILL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Lee el bundle una vez al arrancar. `hermes-skills` es JSON {ruta: contenido}
 * con rutas relativas a skills/ y claves ordenadas (valor estable, ack estable).
 * El README del bundle no viaja a la VM.
 */
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `profiles/<n>/SOUL.md` del bundle (equipo de especialistas, MLB-005b). Opcional. */
function loadProfileSouls(dir: string): Record<string, string> {
  const root = join(dir, 'profiles');
  if (!existsSync(root)) return {};
  const souls: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    if (!statSync(join(root, name)).isDirectory()) continue;
    if (!PROFILE_NAME.test(name) || name === 'default') throw new Error('BUNDLE_INVALID_PROFILE');
    const soul = readFileSync(join(root, name, 'SOUL.md'), 'utf8');
    if (!soul.trim()) throw new Error('BUNDLE_INVALID_PROFILE');
    souls[name] = soul;
  }
  return souls;
}

function loadSkillFiles(skillsDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {walk(path); continue;}
      const rel = relative(skillsDir, path).split(sep).join(posix.sep);
      if (!SKILL_PATH.test(rel) || rel.split('/').some(part => part === '..' || part === '.')) throw new Error('BUNDLE_INVALID_PATH');
      files[rel] = readFileSync(path, 'utf8');
    }
  };
  walk(skillsDir);
  return Object.fromEntries(Object.keys(files).sort().map(key => [key, files[key]!]));
}

export function loadAgentBundle(dir: string, version: string): AgentBundle {
  const soul = readFileSync(join(dir, 'SOUL.md'), 'utf8');
  const files = loadSkillFiles(join(dir, 'skills'));
  if (!soul.trim() || !Object.keys(files).length) throw new Error('BUNDLE_EMPTY');
  const profiles = loadProfileSouls(dir);
  const manifestPath = join(dir, 'manifest.json');
  const encoding: unknown = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {skills_metadata_encoding?: unknown}).skills_metadata_encoding : undefined;
  if (encoding !== undefined && encoding !== 'json' && encoding !== 'tar.gz/base64') throw new Error('BUNDLE_INVALID_SKILLS_ENCODING');
  const profileSkills: Record<string, Record<string, string>> = {};
  for (const name of Object.keys(profiles)) {
    const path = join(dir, 'profiles', name, 'skills');
    if (existsSync(path)) profileSkills[name] = loadSkillFiles(path);
  }
  const jobs = loadJobs(dir);
  if (jobs.some(job => job.skills.some(skill => !(`${skill}/SKILL.md` in files)))) throw new Error('BUNDLE_INVALID_JOBS');
  return {version, soul, skills: JSON.stringify(files), jobs, profiles,
    ...(encoding ? {skillsEncoding: encoding} : {}),
    ...(Object.keys(profileSkills).length ? {profileSkills} : {}), ...loadJobCatalog(dir, version)};
}

/** Config del CLI de SaleADS (AAB-005) dentro del bundle: la skill la lee de skills/saleads-cli/config.json. */
export const CLI_CONFIG_PATH = 'saleads-cli/config.json';

/**
 * Suma al bundle la config del CLI (origen de la Agent API y client_id del asistente), solo si el bundle trae la
 * skill `saleads-cli`. Viaja con las demás skills (el watcher las instala 0600): el host lo fija SaleADS, no el agente.
 */
export function withCliConfig(bundle: AgentBundle, cli: {url: string; clientId: string; webUrl?: string}): AgentBundle {
  const files = JSON.parse(bundle.skills) as Record<string, string>;
  if (!('saleads-cli/SKILL.md' in files) || !cli.url) return bundle;
  const web = cli.webUrl ? {web_url: new URL(cli.webUrl).origin} : {};
  files[CLI_CONFIG_PATH] = `${JSON.stringify({url: new URL(cli.url).origin, client_id: cli.clientId, ...web})}\n`;
  const sorted = Object.fromEntries(Object.keys(files).sort().map(key => [key, files[key]]));
  return {...bundle, skills: JSON.stringify(sorted)};
}

/** Claves hermes-* de una VM nueva (sin hermes-env ni modelo hasta OCB-010). */
export function initialHermesMetadata(input: {
  apiServerKey: string;
  bundle: AgentBundle;
  mcp: McpConfig;
  mcpTokens: string;
  timezone?: string | null;
  /** ORQA cliente (OSB-009): imagen privada del cerebro; sin valor, la VM no lo arranca. */
  brainImage?: string | null;
}): HermesMetadata {
  return {
    ...(input.brainImage ? {'hermes-brain-image': input.brainImage} : {}),
    'hermes-api-key': input.apiServerKey,
    'hermes-bundle-version': input.bundle.version,
    'hermes-config': hermesConfig({mcp: input.mcp, timezone: input.timezone}),
    'hermes-mcp-tokens': input.mcpTokens,
    // Sin tipos confirmados todavía: el bundle base; OrqaSync suma los tipos al quedar lista (MLB-003).
    'hermes-skills': encodeSkillsMetadata(composeSkills(input.bundle.skills, [], []), input.bundle.skillsEncoding),
    'hermes-soul': input.bundle.soul,
  };
}
