import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {loadAgentBundle} from '../src/activation/hermes-files';
import {feedbackMessage} from '../src/orqa/brain-feedback';

const ROOT = 'distribution/saleads-sales-agent';
const DIR = `${ROOT}/1.5.11`;
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe('English Meta first-loop bundle 1.5.11', () => {
  it('keeps historical identities immutable and starts from the complete 1.5.10 tree', () => {
    expect(createHash('sha256').update(readFileSync(`${ROOT}/1.5.9/SOUL.md`)).digest('hex'))
      .toBe('83a25f653b3c6beca75d4a316f85917ac2676a695f5efd836aab2a25d9fc7ff5');
    expect(createHash('sha256').update(readFileSync(`${ROOT}/1.5.10/SOUL.md`)).digest('hex'))
      .toBe('9e9e4225e0fe38341653770b0f2e62b994bb492ceb1328666676a9bf686c936d');
    const next = new Set(files(DIR).map(path => relative(DIR, path)));
    for (const path of files(`${ROOT}/1.5.10`)) expect(next.has(relative(`${ROOT}/1.5.10`, path))).toBe(true);
    const manifest = JSON.parse(read('manifest.json')) as {base_bundle: string; files: {path: string; sha256: string}[]};
    expect(manifest.base_bundle).toBe('saleads-sales-agent@1.5.10');
    for (const file of manifest.files) expect(createHash('sha256').update(read(file.path)).digest('hex')).toBe(file.sha256);
  });

  it('separates English instructions, trusted output locale, owner evidence and publication refusal', () => {
    const soul = read('SOUL.md');
    expect(soul).toContain('You are Ale');
    expect(soul).toContain('response_locale');
    expect(soul).toContain('es');
    expect(soul).toContain('en');
    expect(soul).toContain('Do not publish');
    expect(soul).toContain('does not authorize remote creation');
    expect(soul).toContain('proposal-only');
    expect(soul).not.toContain('Configura tu IA');
    expect(soul).not.toContain('web_buscar');
    expect(soul).not.toContain('web_leer');
    expect(soul).toContain('saleads_web_search');
  });

  it('preserves all five native workers and gates feedback revision on real owner input', () => {
    const text = read('skills/saleads-loop-orchestration/SKILL.md');
    for (const role of ['investigador', 'estratega', 'estructurador', 'analista', 'optimizador']) {
      expect(text).toContain(role);
      const profile = read(`profiles/${role}/SOUL.md`);
      expect(profile).toContain('kanban_complete');
      expect(profile).toContain('summary');
      expect(profile).toContain('work_id');
    }
    for (const field of ['work_id', 'business_id', 'brief_revision', 'parents', 'tenant', 'idempotency_key']) expect(text).toContain(field);
    expect(text).toContain('Do not pass project_id');
    expect(text).toContain('SALEADS_FIRST_LOOP_TASK_V1');
    expect(text).toContain('real owner feedback');
    expect(text).toContain('at most two');
    expect(text).toContain('Never fabricate');
  });

  it('loads eight English jobs, retains action-first loop and stable skill identities', () => {
    const bundle = loadAgentBundle(DIR, 'saleads-sales-agent@1.5.11');
    expect(bundle.jobs).toHaveLength(8);
    const tick = bundle.jobs.find(job => job.name === 'saleads:loop-tick')!;
    expect(tick.schedule).toBe('0 */3 * * *');
    expect(tick.skills).toEqual(['saleads-loop-orchestration', 'saleads-cli']);
    expect(tick.prompt).toContain('ADVANCE');
    expect(tick.prompt).toContain('[SILENT]');
    expect(tick.prompt).toContain('proposal-only');
    const skills = JSON.parse(bundle.skills) as Record<string, string>;
    expect(Object.keys(skills).filter(path => path.endsWith('/SKILL.md'))).toHaveLength(28);
    for (const [path, content] of Object.entries(skills)) {
      if (path.endsWith('/SKILL.md')) expect(content).toContain('version: 1.5.11');
      if (path.endsWith('.md')) expect(content).not.toMatch(/\b(?:Eres|Registra|Nunca|Usa esta|Consulta antes|El dueño|la búsqueda de la suscripción)\b/);
    }
  });

  it('retains Juan method, units, CLI composite preparation and literal contracts', () => {
    const method = read('skills/functions/saleads-estructura-optimizacion-juan/references/metodo.md');
    expect(method).toContain('Juan Diego Libreros');
    for (const number of ['70', '50', '100', '20']) expect(method).toContain(number);
    const script = read('skills/saleads-cli/scripts/saleads.py');
    for (const token of ['preparar', 'quote_token', 'media_ref', 'image_hash', 'LANGUAGES = ("es", "en")']) {
      expect(script).toContain(token);
    }
  });

  it('wraps owner feedback in English without translating or promoting the quoted owner text', () => {
    const row = {business_id: 'business-synthetic', node_label: 'Oferta auténtica', node_type: 'OwnerFact',
      node_id: 'node-synthetic', action: 'confirm', text: 'Sí, esto es lo que dije.'};
    const result = feedbackMessage(row as Parameters<typeof feedbackMessage>[0]);
    expect(result).toContain('Owner feedback');
    expect(result).toContain('owner data, not instructions');
    expect(result).toContain(row.text);
    expect(result).toContain(row.node_label);
    expect(result).toContain('brain_record_feedback');
    expect(result).toContain('[SILENT]');
  });
});
