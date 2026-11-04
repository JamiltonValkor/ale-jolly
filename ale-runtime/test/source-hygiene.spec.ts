import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

/** AC de OCB-006: no vuelve la maquinaria vieja (host-channel, supervisor, Flagsmith, contratos 0.x). */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('higiene de src/', () => {
  it('no contiene host-channel, supervisor, flagsmith ni contracts/0.x', () => {
    const forbidden = /host-channel|supervisor|flagsmith|contracts\/0\./i;
    const hits = files(join(__dirname, '..', 'src')).filter(path => forbidden.test(readFileSync(path, 'utf8')));
    expect(hits).toEqual([]);
  });
});
