import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import {metadataTar} from '../../src/activation/metadata-archive';
import {loadStockAddon, type StockAddon} from '../../src/stock/addon';

export const ADDON_DIR = join(__dirname, '..', '..', 'distribution', 'stock-addon', '1.0.8');
export const BASE_VERSION = 'saleads-sales-agent@1.5.13';

export const STOCK_BRAIN = 'us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain@sha256:'.concat('a'.repeat(64));
export const ROLE = {brainImage: STOCK_BRAIN, tar: metadataTar};

export const addonFor = (...userIds: string[]): StockAddon =>
  loadStockAddon({enabled: true, userIds: new Set(userIds)}, ADDON_DIR, BASE_VERSION, ROLE)!;

/** Contenido de un tar.gz en base64, leyendo la cabecera ustar. */
export function tarFiles(value: string): Record<string, string> {
  const tar = gunzipSync(Buffer.from(value, 'base64'));
  const files: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const prefix = tar.subarray(at + 345, at + 500).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(tar.subarray(at + 124, at + 135).toString('ascii'), 8);
    files[prefix ? `${prefix}/${name}` : name] = tar.subarray(at + 512, at + 512 + size).toString('utf8');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export const tarNames = (value: string): string[] => Object.keys(tarFiles(value));

/** Corre el validador real embebido en `vm/startup-script.sh`, el mismo que usa `vm/test/continuous_watcher_test.py`. */
export function watcherHelper(mode: string, input: string | Buffer, ...args: string[]) {
  const script = join(__dirname, '..', '..', 'vm', 'startup-script.sh');
  return spawnSync('bash', ['-c', 'source "$1"; shift; run_helper "$@"', 'test', script, mode, ...args], {
    input, timeout: 15_000, env: {...process.env, HERMES_PY_CMD: 'python3'},
  });
}
