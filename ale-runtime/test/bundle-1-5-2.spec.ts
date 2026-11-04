import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {loadAgentBundle, withCliConfig} from '../src/activation/hermes-files';
import {composeSkills, MAX_SKILLS_METADATA_BYTES} from '../src/skills/skills-writer';

/**
 * AAB-024: 1.5.2 = 1.5.1 + CLI 1.2.0 (business_id según el esquema de cada comando) + pedir el tope de créditos una
 * vez. Con 1.5.1, el 92 % de los errores del laboratorio venía de esas dos causas.
 */
const DIR = 'distribution/saleads-sales-agent/1.5.2';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe('bundle 1.5.2 (AAB-024)', () => {
  const bundle = withCliConfig(loadAgentBundle(DIR, 'saleads-sales-agent@1.5.2'), {url: 'https://gateway-dev.saleads.ai', clientId: 'c'});
  const skills = JSON.parse(bundle.skills) as Record<string, string>;

  it('el CLI 1.2.0 ajusta business_id al esquema y recuerda el negocio', () => {
    const cli = skills['saleads-cli/scripts/saleads.py']!;
    expect(cli).toContain('VERSION = "1.2.0"');
    expect(cli).toContain('def fit_business(');
    expect(cli).toContain('remember_business(settings, args.get("business_id"))');
  });

  it('las reglas del CLI cubren el negocio recordado y el tope de créditos', () => {
    const rules = skills['saleads-cli/SKILL.md']!;
    expect(rules).toContain('El negocio lo pone el CLI');
    expect(rules).toContain('MCP-E-AGENT-CREDIT-CAP');
    expect(rules).toContain('**una vez**');
    expect(skills['saleads-loop-orchestration/SKILL.md']).toContain('Si el tope de créditos no está fijado o no alcanza');
  });

  it('versión 1.5.2 en todas las skills y bajo el tope con los tres tipos', () => {
    for (const path of files(DIR).filter(p => p.endsWith('SKILL.md'))) {
      expect(readFileSync(path, 'utf8')).toMatch(/\nversion: 1\.5\.2\n/);
    }
    expect(files(DIR).some(p => readFileSync(p, 'utf8').includes('saleads-sales-agent@1.5.1'))).toBe(false);
    expect(Buffer.byteLength(composeSkills(bundle.skills, [], ['physical_product', 'service', 'infoproduct']))).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
  });
});
