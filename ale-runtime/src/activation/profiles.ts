import {gzipSync} from 'node:zlib';
import {metadataTar} from './metadata-archive';
import type {BusinessTypeV1} from '../contracts/v1';
import {MAX_SKILLS_METADATA_BYTES, SkillsTooLargeError} from '../skills/skills-writer';
import type {AgentBundle} from './hermes-files';

/**
 * Equipo de especialistas persistentes (MLB-005b): cada uno es un profile de
 * Hermes con su SOUL, su capa de config (filtros de MCP y toolsets) y sus
 * skills. El watcher (MLB-005a) los crea y mantiene desde `hermes-profiles`.
 */
interface Specialist {
  /** Skills de `skills/functions/` que recibe. */
  functions: string[];
  /** Recibe las skills de los tipos de negocio del dueño (`skills/types/<t>/`). */
  types: boolean;
  /** Ve web_buscar y web_leer del cerebro. */
  web: boolean;
  /**
   * MCB-012: lecturas exactas del MCP de SaleADS que sirven al canal del agente (con `explicitReads`). Las
   * apuestas vienen en la tarjeta y en el cerebro; las estrategias, planes y planes especiales de la web no.
   */
  saleads: string[];
  /**
   * MCB-010: búsqueda real con el `web_search` nativo del backend Codex (suscripción ChatGPT del dueño, sin costo
   * para SaleADS, D17) cuando `nativeSearch` está encendido. Solo el investigador.
   */
  nativeSearch: boolean;
}

/** La cuenta del dueño: perfil, contexto inicial y ofertas. */
const ACCOUNT_READS = ['saleads_get_business_profile', 'saleads_get_business_bootstrap', 'saleads_list_offerings'];
/**
 * Lo que el analista necesita para el veredicto (MCN-011). Compuerta MCB-000 paso 28: en una campaña `[Ale]`,
 * `saleads_get_campaign_ads` trae anuncios y cajas pero hoy devuelve en null los textos y el linaje, y
 * `saleads_get_box_metrics` no responde si la campaña nunca entregó. No se recortan (el analista se quedaría sin
 * cajas ni anuncios): los textos de cada caja los trae la tarjeta de Ale y el arreglo de la proyección queda
 * pendiente fuera de este servicio.
 */
const ANALYST_READS = [
  ...ACCOUNT_READS, 'saleads_list_campaigns', 'saleads_get_campaign_ads', 'saleads_get_box_metrics',
  'saleads_get_campaign_health', 'saleads_get_results',
];

export const SPECIALISTS: Record<string, Specialist> = {
  investigador: {
    functions: ['saleads-market-research'], types: false, web: true, nativeSearch: true,
    saleads: ['saleads_get_business_profile', 'saleads_list_offerings'],
  },
  estratega: {functions: [], types: true, web: false, nativeSearch: false, saleads: ACCOUNT_READS},
  // AAB-023: criterios de Juan para estructurar y optimizar (en bundles viejos la skill no existe y no se copia).
  estructurador: {
    functions: ['saleads-estructura-optimizacion-juan'], types: true, web: false, nativeSearch: false,
    saleads: [...ACCOUNT_READS, 'saleads_get_meta_status', 'saleads_search_locations', 'saleads_list_campaigns'],
  },
  analista: {functions: ['saleads-reading-diagnosis'], types: false, web: false, nativeSearch: false, saleads: ANALYST_READS},
  optimizador: {
    functions: ['saleads-optimization-scaling', 'saleads-estructura-optimizacion-juan'], types: true, web: false, nativeSearch: false,
    saleads: [...ANALYST_READS, 'saleads_get_meta_status', 'saleads_search_locations'],
  },
};

/** Opciones de la capa de los especialistas (flags del servicio; apagadas = la capa de siempre). */
export interface ProfileOptions {
  /** MCB-012 (`SPECIALIST_EXPLICIT_READS_ENABLED`): lista exacta por especialista en vez de los comodines. */
  explicitReads?: boolean;
  /**
   * MCB-010 (`RESEARCHER_NATIVE_SEARCH_ENABLED` y proveedor `openai-codex` en la fila): el investigador suma el
   * toolset `web` con `search_backend: openai-native` y sin el anillo gratuito de terceros. Sin tope de búsquedas
   * (D19): ni contador ni límite aquí.
   */
  nativeSearch?: boolean;
  /** Managed Meta research uses the native saleads_research plugin, without legacy web providers. */
  metaSearch?: boolean;
  /** Managed continuous mode uses native, business-bound memory wrappers. */
  scopedMemory?: boolean;
  /** Complemento de Stock, solo para usuarios habilitados: perfil `stock` y skills extra del investigador. */
  stock?: boolean;
}

/**
 * Lista exacta de `architecture.md` §7.4. Un nombre nuevo del MCP no entra solo, y `saleads_stock_confirm_count` queda
 * fuera a propósito: quien lee facturas y mensajes de proveedores no puede confirmar.
 */
export const STOCK_PROFILE_TOOLS = Object.freeze([
  'saleads_get_business_profile', 'saleads_list_offerings',
  'saleads_stock_get_overview', 'saleads_stock_get_item', 'saleads_stock_list_proposals', 'saleads_stock_list_suppliers',
  'saleads_stock_list_orders', 'saleads_stock_get_bet_signal', 'saleads_stock_propose', 'saleads_stock_take_photo',
  'saleads_stock_get_photo', 'saleads_stock_document_extract', 'saleads_stock_supplier_send', 'saleads_stock_supplier_wait',
]);

/**
 * SaleADS es de solo lectura para un especialista: lista blanca (una tool de
 * escritura nueva queda fuera sin tocar esto). Gastar, pausar o lanzar pasa
 * por Ale y la aprobación del dueño en la web. Es la lista con
 * `explicitReads` apagado; encendido, cada especialista lleva la suya, con
 * nombres exactos (una lectura nueva del MCP tampoco entra sola).
 */
export const SPECIALIST_SALEADS_INCLUDE = ['saleads_get_*', 'saleads_list_*', 'saleads_search_locations'];
/** Solo Ale escribe aprendizajes, lo que dice el dueño, loops y lecciones (invariante 4). */
export const SPECIALIST_BRAIN_EXCLUDE = [
  'brain_record_learning', 'brain_record_feedback', 'brain_ingest', 'brain_loops_open', 'brain_loops_close',
  'brain_lessons_pending', 'brain_lesson_mark',
  // AAB-019: hechos tipados del dueño, solo Ale.
  'brain_record_fact',
  // AAB-013: exportar la foto al cerrar la vuelta, solo Ale.
  'brain_snapshot_flush',
];
/**
 * Toolsets de Hermes del worker (`hermes -p <n> --cli`): sin terminal, archivos,
 * navegador, imágenes, voz ni cron, que no usa y suben el costo de cada turno
 * (compuerta MLB-001: ~101.000 tokens de entrada por turno con todo). Los MCP
 * siguen todos (sin nombres de servidor en la lista, Hermes los incluye) y las
 * tools del tablero llegan solas al worker.
 */
export const SPECIALIST_TOOLSETS = ['skills', 'memory', 'todo', 'session_search'];

const quoteList = (items: string[]) => `[${items.map(item => JSON.stringify(item)).join(', ')}]`;

/** `profile-config.yaml`: la capa del especialista sobre `hermes-config` (el watcher fusiona; la capa gana). */
export function profileConfig(name: string, options: ProfileOptions = {}): string {
  // `exclude: []` pisa el de Ale (O-10), que el watcher fusionaría sobre esta capa.
  if(name==='stock')return [
    'mcp_servers:', '  saleads:', '    tools:', `      include: ${quoteList([...STOCK_PROFILE_TOOLS])}`, '      exclude: []',
    '  saleads-brain:', '    tools:', '      include: []',
    'agent:', '  image_input_mode: "native"',
    'model:', '  supports_vision: true',
    'memory:', '  memory_enabled: false', '  user_profile_enabled: false',
    // S-07: por chat completions `auxiliary.vision` cae en el JWT de Envoy.
    'auxiliary:', '  vision:', '    api_mode: "codex_responses"', '  background_review:', '    enabled: false',
    // O-7: con rol. `saleads_memory` da lectura a quien no es curador: Stock no escribe memoria.
    'platform_toolsets:', '  cli: ["skills", "todo", "vision", "saleads_memory"]', '',
  ].join('\n');
  if(name==='disenador_landings'&&options.metaSearch&&options.scopedMemory)return [
    'mcp_servers:', '  saleads:', '    tools:', '      include: []',
    '  saleads-brain:', '    tools:', '      include: []',
    'platform_toolsets:', '  cli: ["file", "skills", "todo", "vision", "saleads_memory"]', '',
  ].join('\n');
  if(name==='curador'&&options.scopedMemory)return [
    'mcp_servers:', '  saleads:', '    tools:', '      include: []',
    '  saleads-brain:', '    tools:', '      include: []',
    'platform_toolsets:', '  cli: ["todo", "saleads_memory"]', '',
  ].join('\n');
  const spec = SPECIALISTS[name];
  if (!spec) throw new Error('UNKNOWN_SPECIALIST');
  const brainExclude = spec.web && !options.metaSearch ? SPECIALIST_BRAIN_EXCLUDE : [...SPECIALIST_BRAIN_EXCLUDE, 'web_*'];
  const saleads = options.explicitReads ? spec.saleads : SPECIALIST_SALEADS_INCLUDE;
  const meta = !!options.metaSearch && spec.nativeSearch;
  const native = !options.metaSearch && !!options.nativeSearch && spec.nativeSearch;
  const base=options.scopedMemory?SPECIALIST_TOOLSETS.filter(toolset=>!['memory','session_search'].includes(toolset)).concat('saleads_memory'):SPECIALIST_TOOLSETS;
  const toolsets = meta ? [...base, 'saleads_research'] : native ? [...base, 'web'] : base;
  return [
    'mcp_servers:',
    '  saleads:',
    '    tools:',
    `      include: ${quoteList(saleads)}`,
    '  saleads-brain:',
    '    tools:',
    ...(options.scopedMemory?['      include: []']:[`      exclude: ${quoteList(brainExclude)}`]),
    'platform_toolsets:',
    `  cli: ${quoteList(toolsets)}`,
    // La lectura de páginas sigue por web_leer del cerebro; con keyless_fallback false nada sale a buscadores ajenos.
    ...(native ? ['web:', '  search_backend: "openai-native"', '  keyless_fallback: false'] : []),
    '',
  ].join('\n');
}

const FUNCTION_PATH = /^functions\/([^/]+)\/(.+)$/;
const TYPE_PATH = /^types\/([^/]+)\/([^/]+)\/(.+)$/;

/** Archivos de cada profile: `profiles/<n>/{SOUL.md, profile-config.yaml, skills/<skill>/...}`. */
export function profileFiles(bundle: AgentBundle, types: ReadonlyArray<BusinessTypeV1>, options: ProfileOptions = {}): Record<string, string> {
  const skills = JSON.parse(bundle.skills) as Record<string, string>;
  const wanted = new Set<string>(types);
  const files: Record<string, string> = {};
  for (const [name, soul] of Object.entries(bundle.profiles)) {
    if(name==='stock'){
      if(!options.stock)continue;
      files['profiles/stock/SOUL.md']=soul;
      files['profiles/stock/profile-config.yaml']=profileConfig(name,options);
      for(const [path,content] of Object.entries(bundle.profileSkills?.stock??{}))files[`profiles/stock/skills/${path}`]=content;
      continue;
    }
    if(name==='disenador_landings'){
      if(!options.metaSearch||!options.scopedMemory)continue;
      files[`profiles/${name}/SOUL.md`]=soul;
      files[`profiles/${name}/profile-config.yaml`]=profileConfig(name,options);
      for(const [path,content] of Object.entries(bundle.profileSkills?.[name]??{}))files[`profiles/${name}/skills/${path}`]=content;
      continue;
    }
    if(name==='curador'&&options.scopedMemory){
      files['profiles/curador/SOUL.md']=soul;files['profiles/curador/profile-config.yaml']=profileConfig(name,options);continue;
    }
    const spec = SPECIALISTS[name];
    if (!spec) continue;
    files[`profiles/${name}/SOUL.md`] = soul;
    files[`profiles/${name}/profile-config.yaml`] = profileConfig(name, options);
    for (const [path, content] of Object.entries(skills)) {
      const fn = FUNCTION_PATH.exec(path);
      if (fn && spec.functions.includes(fn[1] ?? '')) files[`profiles/${name}/skills/${fn[1]}/${fn[2]}`] = content;
      const type = TYPE_PATH.exec(path);
      if (type && spec.types && wanted.has(type[1] ?? '')) files[`profiles/${name}/skills/${type[2]}/${type[3]}`] = content;
    }
    // Esta rama no leía `profileSkills`; solo el complemento lo necesita.
    if (options.stock) for (const [path, content] of Object.entries(bundle.profileSkills?.[name] ?? {})) files[`profiles/${name}/skills/${path}`] = content;
  }
  return files;
}

/**
 * `hermes-profiles`: tar.gz en base64 de los archivos del equipo. Determinista
 * (mismo bundle y tipos = mismo valor, así el ack no cambia sin motivo).
 * Superar el tope de metadata es un error, nunca un truncado. Sin SOUL de
 * especialistas en el bundle, null (no hay equipo).
 */
export function hermesProfiles(bundle: AgentBundle, types: ReadonlyArray<BusinessTypeV1>, options: ProfileOptions = {}): string | null {
  const files = profileFiles(bundle, types, options);
  if (!Object.keys(files).length) return null;
  const value = gzipSync(metadataTar(files), {level: 9}).toString('base64');
  if (Buffer.byteLength(value) > MAX_SKILLS_METADATA_BYTES) throw new SkillsTooLargeError(Buffer.byteLength(value));
  return value;
}
