import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

/** OSB-015: brain_hub es extraíble a un microservicio. Su módulo no depende del resto del servicio. */
const SRC = join(__dirname, '..', 'src');
const HUB = join(SRC, 'brain-hub');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('aislamiento de brain_hub', () => {
  it('src/brain-hub solo importa de sí mismo, node:*, zod o pg', () => {
    const offenders = files(HUB).flatMap(file => {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(match => match[1] ?? '');
      return imports.filter(spec => !(spec.startsWith('./') || spec.startsWith('node:') || ['zod', 'pg'].includes(spec) || spec.startsWith('@nestjs/')))
        .map(spec => `${relative(SRC, file)} → ${spec}`);
    });
    expect(offenders).toEqual([]);
  });

  it('fuera de src/brain-hub nadie escribe SQL sobre brain_hub', () => {
    const offenders = files(SRC).filter(file => !file.startsWith(HUB) && /brain_hub\.[a-z_]+/.test(readFileSync(file, 'utf8')));
    expect(offenders.map(file => relative(SRC, file))).toEqual([]);
  });
});
