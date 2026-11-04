import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {loadAgentBundle} from '../src/activation/hermes-files';

/**
 * OSB-008: bundle 1.2.0. La validación con el código de Hermes vive en
 * distribution/saleads-sales-agent/1.2.0/validate.py; esta prueba cubre lo que
 * debe sostenerse en CI sin el checkout de Hermes.
 */
const DIR = 'distribution/saleads-sales-agent/1.2.0';

/** Patrones estrictos de `_scan_cron_prompt` (tools/cronjob_tools.py @818c13be). */
const CRON_THREATS = [
  /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /system\s+prompt\s+override/i,
  /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
  /authorized_keys/i,
  /\/etc\/sudoers|visudo/i,
  /rm\s+-rf\s+\//i,
];
const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]');

/** Tools que mueven dinero o cambian el estado de campañas. */
const MUTATING_TOOLS = /saleads_(pause_campaign|request_resume_campaign|request_plan_launch|approve_campaign|update_plan|set_campaign_images|update_campaign_copies|quote_special_plan)/;

const PROACTIVE = ['saleads-proactive-digest', 'saleads-account-health', 'saleads-creative-fatigue', 'saleads-seasonal-lookahead', 'saleads-collective-learning'];
const NEW_SKILLS = [...PROACTIVE, 'saleads-business-brain', 'saleads-monthly-review', 'saleads-company-analysis', 'saleads-decision-support',
  'saleads-paid-growth', 'saleads-report-analysis', 'saleads-silo-analysis', 'saleads-carousel-quality'];

const skill = (name: string) => readFileSync(join(DIR, 'skills', name, 'SKILL.md'), 'utf8');
const jobs = () => (JSON.parse(readFileSync(join(DIR, 'jobs.json'), 'utf8')) as {schema: string; jobs: Array<{name: string; schedule: string; prompt: string; skills: string[]}>});

describe('bundle saleads-sales-agent 1.2.0 (OSB-008)', () => {
  it('carga las 18 skills con nombres válidos de Hermes, sin README, jobs ni validador', () => {
    const files = JSON.parse(loadAgentBundle(DIR, 'saleads-sales-agent@1.2.0').skills) as Record<string, string>;
    const names = Object.keys(files).filter(path => path.endsWith('/SKILL.md')).map(path => path.split('/')[0] ?? '');
    expect(names).toHaveLength(18);
    expect(names.every(name => /^[a-z0-9][a-z0-9._-]*$/.test(name))).toBe(true);
    for (const name of NEW_SKILLS) expect(names).toContain(name);
    expect(Object.keys(files).some(path => /README|jobs\.json|validate\.py/.test(path))).toBe(false);
  });

  it('las skills nuevas llevan version y metadata.hermes, descripción entre comillas y sin requires_tools', () => {
    for (const name of NEW_SKILLS) {
      const text = skill(name);
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: "[^"\\n]+"\\nversion: 1\\.2\\.0\\nmetadata:\\n  hermes:\\n    category: saleads-[a-z]+\\n    tags: \\[`));
      expect(text).not.toMatch(/requires_tools|user-invocable/);
    }
  });

  it('no menciona Jamilton, Telegram, Metricool, LENS ni LOOP', () => {
    const all = [readFileSync(join(DIR, 'SOUL.md'), 'utf8'), ...readdirSync(join(DIR, 'skills')).map(skill)].join('\n');
    expect(all).not.toMatch(/Jamilton|Telegram|Metricool|LENS|\bLOOP\b/);
  });

  it('cada skill proactiva instruye [SILENT] exacto y solo', () => {
    for (const name of PROACTIVE) expect(skill(name)).toContain('tu respuesta completa es exactamente `[SILENT]`, sin nada antes ni después');
  });

  it('el SOUL no fija un tope de mensajes y deja el dinero como recomendación', () => {
    const soul = readFileSync(join(DIR, 'SOUL.md'), 'utf8');
    expect(soul).toContain('No hay un número fijo de mensajes');
    expect(soul).toContain('queda como recomendación');
    expect(soul).not.toMatch(/máximo de mensajes|un mensaje al día/i);
  });

  it('ninguna skill nueva llama a tools que muevan dinero o cambien campañas', () => {
    for (const name of NEW_SKILLS) expect(skill(name)).not.toMatch(MUTATING_TOOLS);
  });

  it('los prompts de los jobs pasan el scanner de cron de Hermes y piden [SILENT] o un solo mensaje', () => {
    const {schema, jobs: list} = jobs();
    expect(schema).toBe('saleads-jobs/1');
    expect(list.map(job => job.name)).toEqual(['saleads:proactive-digest', 'saleads:account-health', 'saleads:creative-fatigue',
      'saleads:seasonal-lookahead', 'saleads:monthly-review', 'saleads:share-lessons', 'saleads:catalog-check']);
    for (const job of list) {
      expect(CRON_THREATS.some(re => re.test(job.prompt))).toBe(false);
      expect(INVISIBLE.test(job.prompt)).toBe(false);
      expect(job.prompt.length).toBeLessThanOrEqual(5000);
      expect(job.schedule.split(' ')).toHaveLength(5);
      expect(job.skills.every(name => readdirSync(join(DIR, 'skills')).includes(name))).toBe(true);
      expect(job.prompt).toMatch(/\[SILENT\]|un solo mensaje completo/);
    }
  });
});
