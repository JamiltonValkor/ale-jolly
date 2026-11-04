import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {StockDocumentExtractResultV1} from '../src/contracts/stock-v1';
import {META_API_BASE_URL} from '../src/ai/meta-model';
import {metaInvoiceModel, StockDocuments} from '../src/stock/documents';
import {StockClock} from '../src/stock/clock';
import {STOCK_LIMITS} from '../src/stock/config';
import {outboundFetch} from '../src/outbound/http-client';
import {startTestDatabase, type TestDatabase} from './support/pglite-db';
import {createWorld, key, type World} from './support/stock-world';

/**
 * N2 con costo: se salta sin `STOCK_REAL_MODEL=1`, y un verde sin la tabla no cuenta. Solo facturas sintéticas.
 * STOCK_REAL_MODEL=1 STOCK_EXTRACT_MODEL=... META_API_KEY=... STOCK_EVIDENCE_DIR=... npm test -- test/stock-documents.real.spec.ts
 */
const real = process.env.STOCK_REAL_MODEL === '1';
const dir = join(__dirname, '..', 'robot', 'banco', 'facturas');
interface Truth {archivo: string; content_type: string; sha256: string; proveedor: string; moneda: string; total: string; paginas: number; ambiguos: string[]; lineas: Array<{descripcion: string; cantidad: number; costo_unitario: string}>}
const normal = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

(real ? describe : describe.skip)('facturas sintéticas con modelo real', () => {
  let test: TestDatabase;
  let world: World;
  beforeAll(async () => {
    test = await startTestDatabase();
    world = await createWorld(test);
  });
  afterAll(async () => {await test.close();});

  it('6 facturas: 100 % de proveedor, 95 % de cantidades y costos, y todo error en dudas', async () => {
    const truths = JSON.parse(readFileSync(join(dir, 'verdad.json'), 'utf8')) as Truth[];
    const model = process.env.STOCK_EXTRACT_MODEL ?? '';
    expect(model).not.toBe('');
    let calls = 0;
    const client = metaInvoiceModel({apiKey: process.env.META_API_KEY ?? '', model, baseUrl: META_API_BASE_URL, fetcher: outboundFetch({userAgent: 'stock-banco', timeoutMs: STOCK_LIMITS.extractTimeoutMs})});
    const counted = {id: client.id, extract: (input: Parameters<typeof client.extract>[0]) => {calls += 1; return client.extract(input);}};
    const objects = new Map<string, Buffer>();
    const store = {signPut: async (object: string) => object, exists: async (object: string) => objects.has(object), download: async (object: string) => objects.get(object) ?? null};
    const documents = new StockDocuments({usage: world.stock.usage, db: world.db, clock: new StockClock(world.db, () => world.now.value), now: () => world.now.value, benchEnabled: true, store, model: counted});

    const rows: string[] = [];
    let [providers, fields, right, silent] = [0, 0, 0, 0];
    for (const truth of truths) {
      const bytes = readFileSync(join(dir, truth.archivo));
      const registered = await documents.register(world.userId, world.businessId, {idempotency_key: key(), tipo: 'factura', content_type: truth.content_type as 'application/pdf', tamano: bytes.length, sha256: truth.sha256, canal: 'banco'});
      objects.set(registered.url!, bytes);
      const started = Date.now();
      const result = StockDocumentExtractResultV1.parse(await documents.extract(world.userId, world.businessId, registered.document_id));
      if (result.status !== 'ok') {
        rows.push(`| ${truth.archivo} | ${result.status}${'motivo' in result ? ` ${result.motivo}` : ''} | - | - | - | - | - | ${Date.now() - started} |`);
        fields += truth.lineas.length * 2;
        continue;
      }
      const {extraccion} = result;
      const doubts = new Set(extraccion.dudas.map(item => item.campo));
      const provider = normal(extraccion.proveedor.nombre) === normal(truth.proveedor);
      if (provider) providers += 1;
      const missed: string[] = [];
      truth.lineas.forEach((line, index) => {
        const got = extraccion.lineas[index];
        fields += 2;
        for (const [field, ok] of [['cantidad', got?.cantidad === line.cantidad], ['costo_unitario', got?.costo_unitario === line.costo_unitario]] as const) {
          if (ok) right += 1;
          else if (!doubts.has(`lineas[${index}].${field}`)) missed.push(`lineas[${index}].${field}`);
        }
      });
      const ambiguous = truth.ambiguos.filter(field => !doubts.has(field));
      if (extraccion.lineas.length !== truth.lineas.length) missed.push(`lineas ${extraccion.lineas.length}/${truth.lineas.length}`);
      silent += missed.length + ambiguous.length;
      rows.push(`| ${truth.archivo} | ok | ${provider ? 'sí' : `no: ${extraccion.proveedor.nombre}`} | ${extraccion.lineas.length}/${truth.lineas.length} | ${extraccion.moneda} | ${extraccion.total} | ${[...doubts].join(', ') || '-'} | ${Date.now() - started} |`);
      if (missed.length || ambiguous.length) rows.push(`| | sin marcar: ${[...missed, ...ambiguous].join(', ')} | | | | | | |`);
    }
    const summary = {modelo: model, llamadas: calls, proveedor: `${providers}/${truths.length}`, campos: `${right}/${fields}`, errores_sin_duda: silent};
    const run = createHash('sha256').update(JSON.stringify({summary, rows, at: new Date().toISOString()})).digest('hex').slice(0, 16);
    const table = [`# Exactitud de facturas sintéticas`, '', `Corrida \`${run}\`. ${JSON.stringify(summary)}`, '',
      '| Archivo | Estado | Proveedor | Líneas | Moneda | Total | Dudas | ms |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
    const evidence = process.env.STOCK_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, {recursive: true});
      writeFileSync(join(evidence, `exactitud-${run}.md`), table);
    }
    process.stdout.write(`${table}\n`);
    expect(providers).toBe(truths.length);
    expect(right / fields).toBeGreaterThanOrEqual(0.95);
    expect(silent).toBe(0);
  }, 900_000);
});
