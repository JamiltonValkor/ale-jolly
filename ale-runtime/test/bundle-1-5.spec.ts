import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {gunzipSync} from 'node:zlib';

import {CLI_CONFIG_PATH, loadAgentBundle, withCliConfig} from '../src/activation/hermes-files';
import {hermesProfiles, profileFiles, SPECIALISTS} from '../src/activation/profiles';
import {composeSkills, MAX_SKILLS_METADATA_BYTES} from '../src/skills/skills-writer';

/**
 * AAB-023 (saleads-api-agencial-v1): el bundle 1.5.0 pasa Ale al canal del agente (CLI), alinea permisos con
 * D13/D21/D23 y suma la skill de Juan. La validación con el código de Hermes vive en
 * distribution/saleads-sales-agent/1.5.0/validate.py.
 */
const ROOT = 'distribution/saleads-sales-agent';
const DIR = join(ROOT, '1.5.0');
const KIT = 'distribution/kits/saleads-kit-belleza/1.0.0/skills/saleads-kit-belleza';
const JUAN = 'saleads-estructura-optimizacion-juan';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const tree = (dir: string) => files(dir).map(path => relative(dir, path)).sort();
const read = (path: string) => readFileSync(join(DIR, path), 'utf8');
const all = () => tree(DIR).filter(path => !path.endsWith('.py')).map(path => ({path, text: read(path)}));
const ALL_TYPES = ['physical_product', 'service', 'infoproduct'] as const;

/** Herramientas del flujo de la web que el camino del agente ya no usa (D3, D17). */
const WEB_FLOW = /saleads_(start_strategy|prepare_campaign|update_campaign_copies|request_plan_launch|regenerate_strategy|approve_campaign)/;
/** Lo que nunca se inventa (invariante 8). Una frase que lo nombra junto a un verbo de crear debe negarlo. */
const INVENTED = /testimonio|cifra|métrica|resultado|descuento|escasez|garant[ií]a|autoridad|certificaci[oó]n|iniciales|reseña/i;
const CREATE = /\b(inventa|inventes|inventar|fabrica|fabricar|simula|simular|crea(r)? (un|una|unos|unas)? ?(testimonio|cifra|descuento|garant))/i;
const NEGATION = /\b(no|nunca|ni|sin|jamás)\b/i;

describe('bundle 1.5.0 (AAB-023)', () => {
  const bundle = loadAgentBundle(DIR, 'saleads-sales-agent@1.5.0');

  it('es 1.4.0 más la skill de Juan; solo cambian los archivos de la tarea y jobs.json queda igual', () => {
    const before = tree(join(ROOT, '1.4.0'));
    expect(tree(DIR).filter(path => !before.includes(path))).toEqual([
      `skills/functions/${JUAN}/SKILL.md`, `skills/functions/${JUAN}/references/metodo.md`,
    ]);
    expect(before.filter(path => !tree(DIR).includes(path))).toEqual([]);
    expect(read('jobs.json')).toBe(readFileSync(join(ROOT, '1.4.0/jobs.json'), 'utf8'));
    const changed = before.filter(path => read(path) !== readFileSync(join(ROOT, '1.4.0', path), 'utf8'));
    const skillFiles = changed.filter(path => path.endsWith('/SKILL.md'));
    expect(changed.filter(path => !path.endsWith('/SKILL.md')).sort()).toEqual([
      'README.md', 'SOUL.md', 'profiles/estructurador/SOUL.md', 'profiles/optimizador/SOUL.md',
      'skills/saleads-cli/references/comandos.md', 'skills/saleads-cli/scripts/saleads.py',
      'skills/saleads-human-decisions/references/decision.md', 'validate.py',
    ]);
    // Todos los SKILL.md cambian al menos su `version:` (V-T2).
    expect(skillFiles.length).toBe(before.filter(path => path.endsWith('/SKILL.md')).length);
  });

  it('todos los SKILL.md declaran version 1.5.0 y el bundle carga con sus trabajos', () => {
    for (const path of tree(DIR).filter(p => p.endsWith('/SKILL.md'))) {
      const fm = read(path).split('\n---\n')[0] ?? '';
      expect({path, version: /^version: (.+)$/m.exec(fm)?.[1]}).toEqual({path, version: '1.5.0'});
    }
    expect(bundle.jobs.map(job => job.name)).toContain('saleads:loop-tick');
  });

  it('ninguna skill ni el SOUL dicen «con su código», prohíben pausar o nombran el flujo de la web en el camino del agente', () => {
    for (const {path, text} of all()) {
      expect({path, codigo: /con su c[oó]digo/i.test(text)}).toEqual({path, codigo: false});
      expect({path, pausa: /nunca (lances, reanudes, )?paus|ni pauses/i.test(text)}).toEqual({path, pausa: false});
      // El plan de la web del dueño conserva sus tools, acotado a ese caso (D2, D22).
      if (!path.startsWith('skills/saleads-prepare-approved-work/')) expect({path, web: WEB_FLOW.test(text)}).toEqual({path, web: false});
    }
    expect(read('skills/saleads-prepare-approved-work/SKILL.md')).toMatch(/^description: Solo cuando el dueño pide trabajar un plan de la web/m);
  });

  it('el SOUL y las skills dejan pausar y mover dentro del presupuesto aprobado; encender, borrar o pasarse piden el botón', () => {
    const soul = read('SOUL.md');
    expect(soul).toContain('Crear en pausa, pausar y mover presupuesto dentro del presupuesto mensual\naprobado los haces tú');
    expect(soul).toContain('Encender, borrar o\npasarte del presupuesto aprobado lo aprueba el dueño con un botón en el panel de\nSaleADS');
    expect(soul).toContain('repite solo con el mismo `--id`');
    for (const path of ['skills/saleads-loop-orchestration/SKILL.md', 'skills/saleads-human-decisions/SKILL.md',
      'skills/functions/saleads-optimization-scaling/SKILL.md', `skills/functions/${JUAN}/SKILL.md`]) {
      expect({path, ok: /presupuesto (mensual )?aprobado/.test(read(path))}).toEqual({path, ok: true});
    }
    expect(read('skills/functions/saleads-optimization-scaling/SKILL.md')).not.toContain('nunca cambia gasto por su cuenta');
  });

  it('la orquestación sigue el camino del agente y la vuelta de loop-tick termina con brain_snapshot_flush (D27)', () => {
    const text = read('skills/saleads-loop-orchestration/SKILL.md');
    const order = ['saleads apuestas registrar', 'saleads piezas cotizar', 'saleads piezas generar', 'saleads campana publicar',
      'saleads encendido pedir', 'brain_attach_adset'].map(step => text.indexOf(step));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('MCP-E-UNKNOWN-COMMAND');
    expect(text).toContain('**por campaña**');
    const section = text.slice(text.indexOf('## 7. En cada vuelta de saleads:loop-tick'), text.indexOf('## 8.'));
    expect(section.trim().split('\n').at(-1)).toBe('8. Al terminar la vuelta, llama `brain_snapshot_flush`, también cuando la respuesta es `[SILENT]`.');
    // El trabajo carga la sección por su nombre.
    expect(bundle.jobs.find(job => job.name === 'saleads:loop-tick')?.prompt).toContain('«En cada vuelta de saleads:loop-tick»');
  });

  it('el CLI tiene un alias por cada comando del agente, y comandos.md los lista todos', () => {
    const script = read('skills/saleads-cli/scripts/saleads.py');
    const aliases = Object.fromEntries([...script.matchAll(/^ {4}"([a-z ]+)": "(saleads_[a-z_]+)",$/gm)].map(m => [m[1]!, m[2]!]));
    const agent = Object.values(aliases).filter(name => name.startsWith('saleads_agent_')).sort();
    expect(agent).toEqual(['bet_state', 'generate_pieces', 'mirror', 'pieces', 'publish_campaign', 'quote_pieces', 'read_boxes',
      'register_bets', 'report_box_sales', 'report_lead_quality', 'request_activation', 'trace', 'upload_media'].map(n => `saleads_agent_${n}`));
    const doc = read('skills/saleads-cli/references/comandos.md');
    for (const [alias, name] of Object.entries(aliases)) expect(doc).toMatch(new RegExp(`\\| \`${alias}\`( ✎)? \\| \`${name}\` \\|`));
    const skill = read('skills/saleads-cli/SKILL.md');
    expect(skill).toContain('    requires_toolsets: [terminal]');
    expect(skill).toContain('APPROVAL_REQUIRED');
    expect(skill).toContain('--archivo');
    expect(skill).toMatch(/details\.meta_error/);
    expect(skill).not.toMatch(/notify_on_complete|watch_patterns/);
    expect(Buffer.byteLength(script)).toBeLessThan(40_000);
  });

  it('el CLI une «sustantivo verbo» en un solo alias', () => {
    const run = (args: string[]) => execFileSync('python3', ['-I', '-B', '-c', [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("s", ${JSON.stringify(join(DIR, 'skills/saleads-cli/scripts/saleads.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'c, p, o = m.parse(json.loads(sys.argv[1])); print(json.dumps([c, p, o["args"]]))',
    ].join('\n'), JSON.stringify(args)], {encoding: 'utf8'});
    expect(JSON.parse(run(['apuestas', 'registrar', '--campo', 'business_id', 'b']))).toEqual(['apuestas registrar', [], {business_id: 'b'}]);
    expect(JSON.parse(run(['cajas', 'leer', '--campo', 'level', 'adset']))).toEqual(['cajas leer', [], {level: 'adset'}]);
    expect(JSON.parse(run(['cajas', '--campo', 'campaign_id', 'c']))).toEqual(['cajas', [], {campaign_id: 'c'}]);
    expect(JSON.parse(run(['esquema', 'campana', 'publicar']))).toEqual(['esquema', ['campana publicar'], {}]);
  });

  it('la skill de Juan: criterios con su porqué, sin plantillas ni números obligatorios, dentro del presupuesto aprobado', () => {
    const skill = read(`skills/functions/${JUAN}/SKILL.md`);
    const method = read(`skills/functions/${JUAN}/references/metodo.md`);
    expect(skill).toMatch(new RegExp(`^---\\nname: ${JUAN}\\ndescription: "[^"\\n]{1,1024}"\\nversion: 1\\.5\\.0\\nmetadata:\\n  hermes:\\n`));
    expect(skill).toContain('  saleads:\n    origin: juan\n');
    for (const text of [skill, method]) {
      expect(text).not.toMatch(/```/);
      expect(text).toMatch(/[Pp]or qué/);
    }
    expect(skill).toContain('criterio de esta skill que la justifica');
    expect(method).toContain('no como reglas');
    expect(method).toContain('**Aquí manda el presupuesto mensual aprobado:**');
  });

  it('estructurador y optimizador reciben la skill de Juan; los demás no, y sus SOUL la nombran', () => {
    expect(SPECIALISTS.estructurador?.functions).toContain(JUAN);
    expect(SPECIALISTS.optimizador?.functions).toEqual(['saleads-optimization-scaling', JUAN]);
    const profile = profileFiles(bundle, ['physical_product']);
    for (const name of ['estructurador', 'optimizador']) {
      expect(profile[`profiles/${name}/skills/${JUAN}/SKILL.md`]).toBe(read(`skills/functions/${JUAN}/SKILL.md`));
      expect(profile[`profiles/${name}/skills/${JUAN}/references/metodo.md`]).toBeDefined();
      expect(profile[`profiles/${name}/SOUL.md`]).toContain(JUAN);
      expect(profile[`profiles/${name}/SOUL.md`]).toMatch(/Ale (la publica|lo ejecuta)[^.]*CLI/);
    }
    for (const name of ['analista', 'investigador', 'estratega']) {
      expect(Object.keys(profile).some(path => path.startsWith(`profiles/${name}/skills/${JUAN}/`))).toBe(false);
    }
    // Los especialistas siguen sin terminal: la skill del CLI no llega a sus profiles.
    expect(Object.keys(profile).some(path => path.includes('/skills/saleads-cli/'))).toBe(false);
  });

  it('con todos los tipos, la config del CLI y el kit de belleza instalado, hermes-skills cabe en la metadata', () => {
    const kit = Object.fromEntries(tree(KIT).map(path => [path, readFileSync(join(KIT, path), 'utf8')]));
    const withCli = withCliConfig(bundle, {url: 'https://gateway-dev.saleads.ai', clientId: 'mcp-saleads-assistant-dev'});
    const value = composeSkills(withCli.skills, [{item_id: 'saleads-kit-belleza', files: kit}], [...ALL_TYPES]);
    expect(Buffer.byteLength(value)).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
    const skills = JSON.parse(value) as Record<string, string>;
    expect(skills).toHaveProperty([CLI_CONFIG_PATH]);
    expect(skills['saleads-collective/saleads-kit-belleza/SKILL.md']).toBe(kit['SKILL.md']);
    const profiles = hermesProfiles(bundle, [...ALL_TYPES]);
    expect(profiles).not.toBeNull();
    expect(gunzipSync(Buffer.from(profiles!, 'base64')).length).toBeGreaterThan(0);
  });

  it('ni el bundle ni el kit mandan inventar testimonios, cifras, garantías o autoridad (invariante 8)', () => {
    const texts = [...all(), ...tree(KIT).map(path => ({path: `kit/${path}`, text: readFileSync(join(KIT, path), 'utf8')}))];
    for (const {path, text} of texts) {
      const offending = text.split(/(?<=[.!?:])\s+|\n/).filter(s => CREATE.test(s) && INVENTED.test(s) && !NEGATION.test(s));
      expect({path, offending}).toEqual({path, offending: []});
    }
  });
});
