import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import * as contract from '../src/contracts/stock-v1';

/**
 * El front copia las tablas de `stock-contract-v1.md`. Si una dice «No» donde el código acepta nulo, el front
 * rechaza una respuesta válida. Gana el código: cada tabla debe listar los mismos campos y con el mismo nulable.
 */
const DOC = readFileSync(join(__dirname, '..', 'docs', 'stock-contract-v1.md'), 'utf8');

type Row = {field: string; type: string; nullable: boolean};
interface Table {section: string; label: string; rows: Row[]}

function tables(text: string): Table[] {
  const out: Table[] = [];
  let section = '';
  let label = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('### ')) [section, label] = [line.slice(4).trim(), ''];
    else if (/^(Detalle|Campos comunes):$/.test(line)) label = line.slice(0, -1);
    if (line !== '| Campo | Tipo | Nulable | Obligatorio |') continue;
    const rows: Row[] = [];
    for (i += 2; i < lines.length && lines[i]!.startsWith('|'); i++) {
      const cells = lines[i]!.split('|').slice(1, -1).map(cell => cell.trim());
      rows.push({field: cells[0]!.replace(/`/g, ''), type: cells[1]!, nullable: cells[2] === 'Sí'});
    }
    out.push({section, label, rows});
  }
  return out;
}

type Schema = z.ZodType;
const def = (schema: Schema) => (schema as unknown as {def: {type: string; innerType?: Schema; element?: Schema; in?: Schema}}).def;

function bare(schema: Schema): Schema {
  const {type, innerType, in: input} = def(schema);
  if ((type === 'optional' || type === 'nullable' || type === 'default') && innerType) return bare(innerType);
  if (type === 'pipe' && input) return bare(input);
  return schema;
}

function shape(schema: Schema): Record<string, Schema> {
  const inner = bare(schema);
  const {type, element} = def(inner);
  if (type === 'array' && element) return shape(element);
  if (type !== 'object') throw new Error(`no es objeto: ${type}`);
  return (inner as z.ZodObject).shape as Record<string, Schema>;
}

/** Todas las rutas del esquema, con `[]` en listas de objetos, igual que el documento. */
function paths(schema: Schema, prefix = ''): Map<string, Schema> {
  const out = new Map<string, Schema>();
  for (const [name, field] of Object.entries(shape(schema))) {
    const path = `${prefix}${name}`;
    out.set(path, field);
    const inner = bare(field);
    const {type, element} = def(inner);
    if (type === 'object') for (const [p, s] of paths(field, `${path}.`)) out.set(p, s);
    if (type === 'array' && element && def(bare(element)).type === 'object') for (const [p, s] of paths(element, `${path}[].`)) out.set(p, s);
  }
  return out;
}

const acceptsNull = (schema: Schema): boolean => schema.safeParse(null).success;

function schemaFor(table: Table): Schema | null {
  const kind = /^Propuesta `(\w+)`$/.exec(table.section)?.[1];
  if (kind) {
    const option = contract.StockProposalV1.options.find(item => item.shape.tipo.value === kind)!;
    if (table.label === 'Detalle') return option.shape.detalle as Schema;
    return (option as unknown as z.ZodObject).omit({detalle: true});
  }
  const named = (contract as unknown as Record<string, Schema | undefined>)[table.section];
  return named ?? null;
}

describe('stock-contract-v1.md frente al código', () => {
  const found = tables(DOC);

  it('cada tabla tiene su esquema, y hay detalle de los 9 tipos', () => {
    expect(found.length).toBeGreaterThanOrEqual(17);
    for (const table of found) expect([table.section, schemaFor(table) !== null]).toEqual([table.section, true]);
    const kinds = found.filter(table => table.label === 'Detalle').map(table => /`(\w+)`/.exec(table.section)![1]);
    expect(kinds.sort()).toEqual([...contract.StockProposalKindV1.options].sort());
  });

  it.each(tables(DOC).map(table => [`${table.section} ${table.label}`.trim(), table] as const))('%s: mismos campos y mismo nulable que el esquema', (_name, table) => {
    const real = paths(schemaFor(table)!);
    expect(table.rows.map(row => row.field).sort()).toEqual([...real.keys()].sort());
    const wrong = table.rows.filter(row => row.nullable !== acceptsNull(real.get(row.field)!)).map(row => `${row.field} dice ${row.nullable ? 'Sí' : 'No'}`);
    expect(wrong).toEqual([]);
  });

  it('ningún tipo queda como «valor»: el front copia el tipo', () => {
    expect(found.flatMap(table => table.rows.filter(row => row.type === 'valor').map(row => `${table.section}: ${row.field}`))).toEqual([]);
  });

  it('cada ejemplo de propuesta lleva un título de su tipo, no el de conteo', () => {
    const examples = [...DOC.matchAll(/<!-- ejemplo: StockProposalV1 -->\n```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!) as {tipo: string; titulo: string});
    expect(examples.filter(item => item.tipo !== 'conteo' && /^Conteo/.test(item.titulo)).map(item => item.tipo)).toEqual([]);
  });

  it('la prueba detecta un nulable mal escrito', () => {
    const table = found.find(item => item.section === 'Propuesta `conteo`' && item.label === 'Detalle')!;
    const real = paths(schemaFor(table)!);
    expect(acceptsNull(real.get('foto_url')!)).toBe(true);
    expect(acceptsNull(real.get('producto')!)).toBe(false);
  });
});
