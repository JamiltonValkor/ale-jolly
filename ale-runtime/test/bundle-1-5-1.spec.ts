import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {loadAgentBundle, withCliConfig} from '../src/activation/hermes-files';
import {composeSkills, MAX_SKILLS_METADATA_BYTES} from '../src/skills/skills-writer';

/**
 * AAB-024: 1.5.1 = 1.5.0 + la forma exacta de apuestas, piezas, subidas y árboles (`saleads-cli/references/formatos.md`).
 * En la primera tanda del laboratorio Ale inventaba esas formas y el canal nuevo fallaba 30-65 de cada 100 llamadas.
 */
const DIR = 'distribution/saleads-sales-agent/1.5.1';
const FORMATOS = 'skills/saleads-cli/references/formatos.md';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe('bundle 1.5.1 (AAB-024)', () => {
  const bundle = withCliConfig(loadAgentBundle(DIR, 'saleads-sales-agent@1.5.1'), {url: 'https://gateway-dev.saleads.ai', clientId: 'c'});
  const skills = JSON.parse(bundle.skills) as Record<string, string>;
  const formatos = readFileSync(join(DIR, FORMATOS), 'utf8');
  const examples = [...formatos.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]!);

  it('trae la referencia de formatos en la skill del CLI y la regla para corregir details.fields', () => {
    expect(skills['saleads-cli/references/formatos.md']).toBe(formatos);
    expect(skills['saleads-cli/SKILL.md']).toContain('references/formatos.md');
    expect(skills['saleads-cli/SKILL.md']).toContain('details.fields');
  });

  it('cada ejemplo es JSON válido y usa las formas reales (Graph, master_ref, image_hash)', () => {
    expect(examples).toHaveLength(5);
    const parsed = examples.map(text => JSON.parse(text) as Record<string, unknown>);
    expect(JSON.stringify(parsed[4])).toContain('object_story_spec');
    expect(parsed[2]).toMatchObject({piece: {role: 'variation', master_ref: {image_index: 0}}});
    expect(parsed[3]).toMatchObject({action: 'image', source: {kind: 'gen_image'}});
    // Lo que pone SaleADS nunca va dentro de la pieza.
    for (const piece of [parsed[1]!.piece, parsed[2]!.piece] as Array<Record<string, unknown>>) {
      for (const field of ['business_id', 'client_request_id', 'quote_token', 'accepted_credits', 'agent_action_id']) expect(piece).not.toHaveProperty(field);
    }
  });

  it('la apuesta de ejemplo tiene todos los campos que exige agent-bet.v1', () => {
    const bet = (JSON.parse(examples[0]!) as {bets: Array<Record<string, unknown>>}).bets[0]!;
    for (const key of ['bet_key', 'avatar', 'angle', 'promise', 'test', 'format', 'attribution_unit', 'copies', 'confidence']) expect(bet).toHaveProperty(key);
    expect(bet.bet_key).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });

  it('versión 1.5.1 en todas las skills, sin «con su código» y bajo el tope con los tres tipos', () => {
    for (const path of files(DIR).filter(p => p.endsWith('SKILL.md'))) {
      expect(readFileSync(path, 'utf8')).toMatch(/\nversion: 1\.5\.1\n/);
    }
    expect(files(DIR).some(p => readFileSync(p, 'utf8').includes('con su código'))).toBe(false);
    expect(Buffer.byteLength(composeSkills(bundle.skills, [], ['physical_product', 'service', 'infoproduct']))).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
  });
});
