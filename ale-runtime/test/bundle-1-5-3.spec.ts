import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {loadAgentBundle, withCliConfig} from '../src/activation/hermes-files';
import {composeSkills, MAX_SKILLS_METADATA_BYTES} from '../src/skills/skills-writer';

/**
 * AAB-024 (plan de correcciones 2026-11-02): 1.5.3 = archivos de trabajo dentro de /opt/data, una publicación por
 * apuesta, encendido con publication_id, evidencia consultiva y servicio con el método de Juan.
 */
const DIR = 'distribution/saleads-sales-agent/1.5.3';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe('bundle 1.5.3 (AAB-024)', () => {
  const bundle = withCliConfig(loadAgentBundle(DIR, 'saleads-sales-agent@1.5.3'), {url: 'https://gateway-dev.saleads.ai', clientId: 'c'});
  const skills = JSON.parse(bundle.skills) as Record<string, string>;
  const all = files(DIR).map(p => readFileSync(p, 'utf8')).join('\n');

  it('nunca manda a escribir en /tmp: Hermes solo deja escribir en /opt/data', () => {
    expect(all).not.toMatch(/\/tmp\/\w/);
    expect(skills['saleads-cli/SKILL.md']).toContain('/opt/data/trabajo/');
  });

  it('una publicación por apuesta y el encendido con publication_id', () => {
    const loop = skills['saleads-loop-orchestration/SKILL.md']!;
    expect(loop).toContain('Una sola publicación por apuesta en la vuelta');
    expect(loop).toContain('encendido pedir --campo publication_id');
    const formatos = skills['saleads-cli/references/formatos.md']!;
    const examples = [...formatos.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]!) as Record<string, unknown>);
    expect(examples).toHaveLength(6);
    expect(Object.keys(examples[5]!).sort()).toEqual(['business_id', 'publication_id']);
  });

  it('la evidencia se pide al dueño en vez de descartar la apuesta, sin inventarla', () => {
    const soul = readFileSync(join(DIR, 'SOUL.md'), 'utf8');
    expect(soul).toContain('No inventes testimonios');
    expect(soul).toContain('propónsela al dueño');
    expect(readFileSync(join(DIR, 'profiles/estratega/SOUL.md'), 'utf8')).toContain('pide evidencia al dueño');
    for (const type of ['physical_product/saleads-type-physical-product', 'service/saleads-type-service', 'infoproduct/saleads-type-infoproduct']) {
      expect(readFileSync(join(DIR, `skills/types/${type}/SKILL.md`), 'utf8')).toMatch(/propónsela al dueño/);
    }
  });

  it('servicio usa el método de Juan; infoproducto sigue con el lanzamiento en 4 fases', () => {
    const service = readFileSync(join(DIR, 'skills/types/service/saleads-type-service/SKILL.md'), 'utf8');
    expect(service).toContain('origin: juan');
    expect(service).toContain('saleads-estructura-optimizacion-juan');
    expect(service).not.toContain('No hay todavía la estrategia de un experto');
    expect(readFileSync(join(DIR, 'skills/types/infoproduct/saleads-type-infoproduct/SKILL.md'), 'utf8')).toContain('lanzamiento en cuatro fases');
  });

  it('versión 1.5.3 en todas las skills y bajo el tope con los tres tipos', () => {
    for (const path of files(DIR).filter(p => p.endsWith('SKILL.md'))) {
      expect(readFileSync(path, 'utf8')).toMatch(/\nversion: 1\.5\.3\n/);
    }
    expect(all).not.toContain('saleads-sales-agent@1.5.2');
    expect(Buffer.byteLength(composeSkills(bundle.skills, [], ['physical_product', 'service', 'infoproduct']))).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
  });
});
