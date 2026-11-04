import {spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'stock-retirar-vm.sh');
const ARGS = ['--instance', 'sa-assistant-abc', '--zone', 'us-central1-a', '--project', 'saleads-dev'];

function run(version: string, ...extra: string[]) {
  const bin = mkdtempSync(join(tmpdir(), 'stock-retiro-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'gcloud'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$3" = describe ]; then echo '${JSON.stringify({metadata: {items: [{key: 'hermes-bundle-version', value: version}]}})}'; fi\n`);
  chmodSync(join(bin, 'gcloud'), 0o755);
  writeFileSync(log, '');
  const result = spawnSync('bash', [SCRIPT, ...ARGS, ...extra], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`}});
  return {...result, calls: readFileSync(log, 'utf8')};
}

describe('rollback en disco (S-43)', () => {
  it('sin --apply no entra a la VM', () => {
    const result = run('saleads-sales-agent@1.5.13');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hermes profile delete stock --yes');
    expect(result.calls).not.toContain('ssh');
  });

  it('con --apply borra perfil, estado del watcher y el trabajo de Stock, y comprueba', () => {
    const result = run('saleads-sales-agent@1.5.13', '--apply');
    expect(result.status).toBe(0);
    expect(result.calls).toContain('compute ssh sa-assistant-abc');
    expect(result.calls).toContain('--tunnel-through-iap');
    expect(result.calls).toContain('hermes profile delete stock --yes');
    expect(result.calls).toContain('/var/lib/hermes/data/profiles/stock /var/lib/hermes/state/profiles/stock');
    expect(result.calls).toContain('startswith("saleads:stock-tick:")');
    expect(result.calls).toContain('hermes cron remove');
    expect(result.calls).toContain('test ! -e /var/lib/hermes/data/profiles/stock');
  });

  it('si la metadata sigue con Stock se niega: el watcher lo recrearía', () => {
    const result = run('saleads-sales-agent@1.5.13+stock-1.0.8', '--apply');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STOCK_USER_IDS');
    expect(result.calls).not.toContain('ssh');
  });

  it('no acepta una instancia que no sea de asistente', () => {
    const result = spawnSync('bash', [SCRIPT, '--instance', 'otra-vm', '--zone', 'z', '--project', 'p', '--apply'], {encoding: 'utf8'});
    expect(result.status).toBe(2);
  });
});
