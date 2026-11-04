import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {boundaryViolations, repositoryViolations} from './support/stock-boundary';

const root = join(__dirname, '..');
const sample = (name: string) => readFileSync(join(__dirname, 'fixtures', 'stock-frontera', name), 'utf8');

describe('frontera de src/stock', () => {
  it('fuera de src/stock solo importan main.ts y app.module.ts', () => {
    expect(repositoryViolations(root)).toEqual([]);
  });

  it('un archivo de muestra ilegal hace fallar la regla, para que no pase sola', () => {
    expect(boundaryViolations('src/chat/ilegal.ts', sample('importa-stock.txt'))).toEqual(['src/chat/ilegal.ts -> src/stock/module']);
    expect(boundaryViolations('src/main.ts', sample('importa-stock.txt'))).toEqual([]);
  });

  it('src/stock no importa de robot/ ni de src/activation salvo tipos', () => {
    expect(boundaryViolations('src/stock/ilegal.ts', sample('stock-importa-robot.txt')))
      .toEqual(['src/stock/ilegal.ts -> robot/voz-hermes/cliente', 'src/stock/ilegal.ts -> src/activation/profiles']);
    expect(boundaryViolations('src/stock/tipos.ts', sample('stock-importa-tipo.txt'))).toEqual([]);
  });
});
