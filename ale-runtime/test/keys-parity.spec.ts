import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HERMES_KEYS} from '../src/compute/metadata';

/**
 * OSB-005: la lista cerrada de claves hermes-* vive en varias copias y su orden
 * es parte del contrato del ack. Todas deben ser idénticas.
 */
const root = join(__dirname, '..');
const watcherKeys = () => {
  const match = readFileSync(join(root, 'vm', 'startup-script.sh'), 'utf8').match(/^KEYS="([^"]+)"$/m);
  return (match?.[1] ?? '').split(' ');
};
const testReferenceKeys = () => {
  const match = readFileSync(join(root, 'vm', 'test', 'watcher-test.sh'), 'utf8').match(/keys = \[([^\]]+)\]/);
  return [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
};

describe('paridad de las claves hermes-*', () => {
  it('el watcher, el servicio y la referencia del test usan la misma lista en el mismo orden', () => {
    expect(watcherKeys()).toEqual([...HERMES_KEYS]);
    expect(testReferenceKeys()).toEqual([...HERMES_KEYS]);
  });
});
