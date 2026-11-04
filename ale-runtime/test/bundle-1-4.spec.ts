import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

import {CLI_CONFIG_PATH, initialHermesMetadata, loadAgentBundle, withCliConfig} from '../src/activation/hermes-files';
import {composeSkills, MAX_SKILLS_METADATA_BYTES} from '../src/skills/skills-writer';

/**
 * AAB-005 (saleads-api-agencial-v1): el bundle 1.4.0 es 1.3.0 + la skill `saleads-cli`. La validación con el
 * código de Hermes vive en distribution/saleads-sales-agent/1.4.0/validate.py.
 */
const ROOT = 'distribution/saleads-sales-agent';
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const tree = (version: string) => files(join(ROOT, version)).map(path => relative(join(ROOT, version), path)).sort();

describe('bundle 1.4.0 (AAB-005)', () => {
  const bundle = loadAgentBundle(join(ROOT, '1.4.0'), 'saleads-sales-agent@1.4.0');

  it('es 1.3.0 más skills/saleads-cli, sin otros cambios fuera del README', () => {
    const added = tree('1.4.0').filter(path => !tree('1.3.0').includes(path));
    expect(added).toEqual(['skills/saleads-cli/SKILL.md', 'skills/saleads-cli/references/comandos.md', 'skills/saleads-cli/scripts/saleads.py']);
    for (const path of tree('1.3.0').filter(p => p !== 'README.md')) {
      expect(readFileSync(join(ROOT, '1.4.0', path), 'utf8')).toBe(readFileSync(join(ROOT, '1.3.0', path), 'utf8'));
    }
  });

  it('la skill exige terminal (los especialistas sin terminal no la ven) y no trae la config del host', () => {
    const skill = readFileSync(join(ROOT, '1.4.0/skills/saleads-cli/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: saleads-cli\ndescription: "[^"\n]{1,1024}"\nversion: 1\.4\.0\nmetadata:\n {2}hermes:\n/);
    expect(skill).toContain('    requires_toolsets: [terminal]');
    expect(skill).not.toMatch(/notify_on_complete|watch_patterns/);
    expect(JSON.parse(bundle.skills)).not.toHaveProperty([CLI_CONFIG_PATH]);
  });

  it('el script es stdlib, pesa menos de 40 KB y no tiene --url', () => {
    const script = readFileSync(join(ROOT, '1.4.0/skills/saleads-cli/scripts/saleads.py'), 'utf8');
    expect(Buffer.byteLength(script)).toBeLessThan(40_000);
    expect(script).not.toMatch(/== "--url"/);
    const imports = [...script.matchAll(/^(?:import|from) ([a-z_.]+)/gm)].map(m => m[1]!.split('.')[0]);
    expect(new Set(imports)).toEqual(new Set(['__future__', 'json', 'os', 'sys', 'time', 'urllib', 'uuid', 'typing']));
  });

  it('el servicio escribe la config del CLI con el origen fijado y el client_id; hermes-skills cabe en la metadata', () => {
    const withCli = withCliConfig(bundle, {url: 'https://gateway-dev.saleads.ai/cualquier/ruta', clientId: 'mcp-saleads-assistant-dev'});
    const skills = JSON.parse(withCli.skills) as Record<string, string>;
    expect(JSON.parse(skills[CLI_CONFIG_PATH]!)).toEqual({url: 'https://gateway-dev.saleads.ai', client_id: 'mcp-saleads-assistant-dev'});
    expect(Object.keys(skills)).toEqual(Object.keys(skills).sort());
    const value = composeSkills(withCli.skills, [], ['physical_product', 'service', 'infoproduct']);
    expect(Buffer.byteLength(value)).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
    const metadata = initialHermesMetadata({
      apiServerKey: 'k', bundle: withCli, mcpTokens: '{}',
      mcp: {mcpUrl: 'https://dev.saleads.ai/mcp', clientId: 'mcp-saleads-assistant-dev', scope: 'openid'},
    });
    expect(JSON.parse(metadata['hermes-skills']!)).toHaveProperty([CLI_CONFIG_PATH]);
  });

  it('sin la skill o sin URL, el bundle no cambia', () => {
    const old = loadAgentBundle(join(ROOT, '1.3.0'), 'saleads-sales-agent@1.3.0');
    expect(withCliConfig(old, {url: 'https://gateway-dev.saleads.ai', clientId: 'c'})).toBe(old);
    expect(withCliConfig(bundle, {url: '', clientId: 'c'})).toBe(bundle);
  });
});
