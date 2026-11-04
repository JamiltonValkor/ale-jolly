import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, normalize, relative} from 'node:path';

/** Únicos archivos de `src` que pueden conocer `src/stock`: los marcados en architecture.md §4. */
export const STOCK_IMPORTERS = new Set(['src/main.ts', 'src/app.module.ts']);

const IMPORT = /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** `file` es relativo a la raíz del repo; un archivo de muestra entra con la ruta que tendría en `src`. */
export function boundaryViolations(file: string, content: string): string[] {
  const violations: string[] = [];
  const inStock = file.startsWith('src/stock/');
  for (const match of content.matchAll(IMPORT)) {
    const specifier = match[3] ?? match[4] ?? '';
    if (!specifier.startsWith('.')) continue;
    const target = normalize(join(dirname(file), specifier));
    const isType = Boolean(match[2]);
    if (!inStock && target.startsWith('src/stock') && !STOCK_IMPORTERS.has(file)) violations.push(`${file} -> ${target}`);
    if (inStock && (target.startsWith('robot/') || (target.startsWith('src/activation') && !isType))) violations.push(`${file} -> ${target}`);
  }
  return violations;
}

export function repositoryViolations(root: string): string[] {
  return sourceFiles(join(root, 'src')).flatMap(path => {
    const file = relative(root, path);
    return boundaryViolations(file, readFileSync(path, 'utf8'));
  });
}
