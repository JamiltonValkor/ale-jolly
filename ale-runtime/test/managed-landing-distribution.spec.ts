import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {initialHermesMetadata, loadAgentBundle} from '../src/activation/hermes-files';
import {hermesProfiles, profileFiles} from '../src/activation/profiles';
import {META_EXTENSION_FILES, metaRuntimeExtensions} from '../src/activation/vm-extensions';
import {MIN_META_WATCHER_VERSION} from '../src/ai/meta-model';
import {composeSkills, encodeSkillsMetadata, MAX_SKILLS_METADATA_BYTES, SkillsWriter} from '../src/skills/skills-writer';
import {HERMES_KEYS} from '../src/compute/metadata';

const dir = 'distribution/saleads-sales-agent/1.5.13';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('managed landing distribution', () => {
  it('requires the watcher that supports the complete landing archive', () => {
    expect(MIN_META_WATCHER_VERSION).toBe(11);
    expect(readFileSync('vm/startup-script.sh', 'utf8')).toContain('WATCHER_VERSION=11');
    expect(Object.keys(META_EXTENSION_FILES)).toEqual(expect.arrayContaining([
      'runtime/landing-pilot/cli/landing_cli.py', 'runtime/landing-pilot/build_metadata.py',
      'plugins/saleads-memory/landing_experience.py', 'plugins/saleads-continuity/role-catalog.json',
    ]));
  });

  it('installs the exact validated designer snapshot only in managed Meta without overflowing root metadata', () => {
    const bundle = loadAgentBundle(dir, 'saleads-sales-agent@1.5.13');
    const files = profileFiles(bundle, ['physical_product'], {metaSearch: true, scopedMemory: true});
    const coder = 'profiles/disenador_landings/skills/landing-coder/SKILL.md';
    expect(digest(files[coder]!)).toBe('b53e87613c9e5f536fe639c642020a8b74b5a06071904d728c3a6fce73022566');
    expect(files['profiles/disenador_landings/skills/landing-design-variation/SKILL.md']).toBeDefined();
    const config = files['profiles/disenador_landings/profile-config.yaml']!;
    expect(config).toContain('"file"'); expect(config).toContain('"vision"'); expect(config).toContain('"saleads_memory"');
    expect(config).not.toContain('"terminal"'); expect(config).not.toContain('"session_search"');
    expect(config).not.toContain('"memory"');
    expect(Object.keys(profileFiles(bundle, [], {})).some(path => path.includes('disenador_landings'))).toBe(false);
    const root = composeSkills(bundle.skills, [], ['physical_product', 'service', 'infoproduct']);
    expect(Buffer.byteLength(root)).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
    expect(root).not.toContain('landing-coder/references');
    const archive = hermesProfiles(bundle, ['physical_product'], {metaSearch: true, scopedMemory: true})!;
    expect(Buffer.byteLength(archive)).toBeLessThan(MAX_SKILLS_METADATA_BYTES);
    expect(gunzipSync(Buffer.from(archive, 'base64')).toString('utf8')).toContain('landing-design-variation');
    expect(bundle.soul).toContain('When the growth strategy requires a');
    expect(JSON.parse(bundle.skills)['saleads-landing-pilot/SKILL.md']).toContain('saleads_agent_prepare_landing_destination');
  });

  it('preserves every source byte and licence and packages the combined helper with current learning', () => {
    const manifest = JSON.parse(readFileSync(dir + '/landing-distribution.json', 'utf8')) as {
      files: Array<{path: string; sha256: string}>; runtime_files: Array<{path: string; sha256: string}>;
    };
    for (const file of manifest.files) expect(digest(readFileSync(dir + '/' + file.path))).toBe(file.sha256);
    for (const file of manifest.runtime_files) expect(digest(readFileSync('vm/extensions/' + file.path))).toBe(file.sha256);
    const complete = JSON.parse(readFileSync(dir + '/manifest.json', 'utf8')) as {files: Array<{path: string; sha256: string}>};
    for (const file of complete.files) expect(digest(readFileSync(dir + '/' + file.path))).toBe(file.sha256);
    expect(manifest.files.some(file => file.path.endsWith('THIRD_PARTY_NOTICES.md'))).toBe(true);
    expect(manifest.files.some(file => file.path.endsWith('frontend-design.LICENSE.txt'))).toBe(true);
    expect(digest(readFileSync('vm/extensions/landing-pilot/cli/landing_cli.py'))).toBe('92a1a78458b402f1def7057f76ed75157ade7656c5272a0d4ac21869a24aa5f1');
    const tar = gunzipSync(Buffer.from(metaRuntimeExtensions(), 'base64')).toString('utf8');
    expect(tar).toContain('runtime/landing-pilot/cli/landing_cli.py');
  });

  it('fits the complete new-account Compute metadata, including the startup script and every Hermes key', () => {
    const bundle = loadAgentBundle(dir, 'saleads-sales-agent@1.5.13');
    // Six signed URLs have a conservative 2 KiB allowance each; credentials and
    // context are synthetic. Include all business types and every optional key.
    const values: Record<string, string> = Object.fromEntries(HERMES_KEYS.map(key => [key,
      key.endsWith('-url') ? 'https://storage.example.invalid/' + 'a'.repeat(2016) : 'x'.repeat(2048)]));
    Object.assign(values, {
      'startup-script': readFileSync('vm/startup-script.sh', 'utf8'),
      'enable-guest-attributes': 'TRUE', 'enable-oslogin': 'TRUE',
      'hermes-bundle-version': bundle.version, 'hermes-soul': bundle.soul,
      'hermes-skills': encodeSkillsMetadata(composeSkills(bundle.skills, [], ['physical_product', 'service', 'infoproduct']), bundle.skillsEncoding),
      'hermes-profiles': hermesProfiles(bundle, ['physical_product', 'service', 'infoproduct'], {metaSearch: true, scopedMemory: true})!,
      'hermes-extensions': metaRuntimeExtensions(),
    });
    const sizes = Object.entries(values).map(([key, value]) => ({key, key_bytes: Buffer.byteLength(key), value_bytes: Buffer.byteLength(value)}));
    for (const size of sizes) {
      expect(size.key_bytes).toBeLessThanOrEqual(128);
      expect(size.value_bytes).toBeLessThanOrEqual(256 * 1024);
    }
    const total = sizes.reduce((bytes, size) => bytes + size.key_bytes + size.value_bytes, 0);
    // GCE counts all keys AND values. Leave 16 KiB for deployment-specific fields.
    process.stdout.write('managed_landing_metadata_budget=' + JSON.stringify({total_bytes: total, headroom_bytes: 512 * 1024 - total,
      startup_bytes: Buffer.byteLength(values['startup-script']!), root_skills_bytes: Buffer.byteLength(values['hermes-skills']!),
      profiles_bytes: Buffer.byteLength(values['hermes-profiles']!), extensions_bytes: Buffer.byteLength(values['hermes-extensions']!)}) + '\n');
    expect(total).toBeLessThan(512 * 1024 - 16 * 1024);
  });

  it('uses the existing lossless skills archive on both provisioning and resync while preserving legacy JSON', () => {
    const bundle = loadAgentBundle(dir, 'saleads-sales-agent@1.5.13');
    expect(bundle.skillsEncoding).toBe('tar.gz/base64');
    const initial = initialHermesMetadata({apiServerKey: 'synthetic-key', bundle, mcpTokens: '{}', mcp: {mcpUrl: 'https://mcp.example.invalid', clientId: 'synthetic-client', scope: 'saleads:read'}});
    const writer = new SkillsWriter(bundle.skills, {} as never, {} as never, async () => [], bundle.skillsEncoding);
    expect(writer.compose([], [])).toBe(initial['hermes-skills']);
    const tar = gunzipSync(Buffer.from(initial['hermes-skills']!, 'base64'));
    const roundtrip: Record<string, string> = {};
    for (let position = 0; position + 512 <= tar.length;) {
      const header = tar.subarray(position, position + 512); position += 512;
      const name = header.subarray(0, 100).toString('utf8').split('\0')[0]!;
      if (!name) break;
      const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0]!;
      const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim(), 8);
      roundtrip[prefix ? prefix + '/' + name : name] = tar.subarray(position, position + size).toString('utf8');
      position += Math.ceil(size / 512) * 512;
    }
    expect(Object.keys(roundtrip).sort()).toEqual(Object.keys(JSON.parse(composeSkills(bundle.skills, [], []))).sort());
    for (const [name, content] of Object.entries(JSON.parse(composeSkills(bundle.skills, [], [])) as Record<string, string>)) expect(digest(roundtrip[name]!)).toBe(digest(content));
    const legacy = loadAgentBundle('distribution/saleads-sales-agent/1.5.12', 'saleads-sales-agent@1.5.12');
    expect(new SkillsWriter(legacy.skills, {} as never, {} as never, async () => []).compose([], [])).toBe(composeSkills(legacy.skills, [], []));
  });
});
