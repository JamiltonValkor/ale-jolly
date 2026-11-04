import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {META_EXTENSION_FILES, metaRuntimeExtensions} from '../src/activation/vm-extensions';

describe('fixed managed Meta extensions archive', () => {
  it('packs only declared immutable assets, deterministically; no tests or private env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-extension-test-'));
    try {
      for (const asset of Object.values(META_EXTENSION_FILES)) {
        mkdirSync(join(dir, asset, '..'), {recursive: true});
        writeFileSync(join(dir, asset), `# ${asset}\n`);
      }
      writeFileSync(join(dir, '.env'), 'DO_NOT_PACK');
      const first = metaRuntimeExtensions(dir);
      expect(metaRuntimeExtensions(dir)).toBe(first);
      const tar = gunzipSync(Buffer.from(first, 'base64')).toString('utf8');
      for (const entry of Object.keys(META_EXTENSION_FILES)) expect(tar).toContain(entry);
      expect(tar).not.toContain('DO_NOT_PACK');
      expect(Object.keys(META_EXTENSION_FILES)).toEqual(expect.arrayContaining([
        'plugins/saleads-continuity/plugin.yaml', 'runtime/continuous-exporter.py',
        'plugins/saleads-continuity/run_receipts.py',
        'plugins/saleads-continuity/role-catalog.json',
        'plugins/saleads-memory/landing_experience.py',
      ]));
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
  it('fails closed when a required asset is missing', () => {
    expect(() => metaRuntimeExtensions('/nonexistent-meta-extensions')).toThrow();
  });
  it('ships an English plugin without overrides or another provider', () => {
    const entry = readFileSync('vm/extensions/saleads-meta-search/__init__.py', 'utf8');
    expect(entry).toContain('name="saleads_web_search"');
    expect(entry).toContain('toolset="saleads_research"');
    expect(entry).not.toContain('override=True');
  });
});
