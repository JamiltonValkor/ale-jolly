import {profileConfig} from '../src/activation/profiles';

describe('managed Meta search isolation', () => {
  it('gives only the researcher the native Meta toolset and excludes legacy web', () => {
    const researcher = profileConfig('investigador', {metaSearch: true, nativeSearch: true, explicitReads: true});
    expect(researcher).toContain('"saleads_research"');
    expect(researcher).toContain('"web_*"');
    expect(researcher).not.toContain('"web"');
    expect(researcher).not.toContain('openai-native');
    for (const name of ['estratega', 'estructurador', 'analista', 'optimizador']) {
      expect(profileConfig(name, {metaSearch: true})).not.toContain('saleads_research');
    }
  });
  it('preserves the classical native-search config when Meta is off', () => {
    expect(profileConfig('investigador', {nativeSearch: true})).toContain('search_backend: "openai-native"');
    expect(profileConfig('investigador', {metaSearch: false})).toBe(profileConfig('investigador'));
  });
});
