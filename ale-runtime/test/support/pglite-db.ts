import {fork, type ChildProcess} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from '../../src/persistence/database';

/**
 * Postgres de prueba (PGlite en un proceso hijo) con todas las migraciones aplicadas, en orden. Expone la
 * misma interfaz `pool.query(sql, params)` que usa el servicio con `pg`.
 */
export interface TestDatabase { database: Database; close(): Promise<void> }

export async function startTestDatabase(): Promise<TestDatabase> {
  const root = join(__dirname, '..', '..');
  const migrations = readdirSync(join(root, 'migrations')).filter(name => /^V\d+__.+\.sql$/.test(name))
    .sort((a, b) => Number(a.slice(1, a.indexOf('__'))) - Number(b.slice(1, b.indexOf('__'))))
    .map(name => join(root, 'migrations', name));
  const child: ChildProcess = fork(join(__dirname, 'pglite-server.mjs'), migrations, {
    cwd: root, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const pending = new Map<number, {resolve: (value: {rows: unknown[]; rowCount: number}) => void; reject: (error: Error) => void}>();
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    child.once('message', (message: {ready: boolean; error?: string}) =>
      message.ready ? resolve() : reject(new Error(message.error)));
    child.once('error', reject);
  });
  child.on('message', (message: {id?: number; rows?: unknown[]; rowCount?: number; error?: string}) => {
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error !== undefined) waiter?.reject(new Error(message.error));
    else waiter?.resolve({rows: (message.rows ?? []).map(toNodeRow), rowCount: message.rowCount ?? 0});
  });
  const query = (sql: string, params: unknown[] = []) => new Promise<{rows: unknown[]; rowCount: number}>((resolve, reject) => {
    const id = next++;
    pending.set(id, {resolve, reject});
    child.send({id, sql, params});
  });
  const pool = {query, end: async () => undefined} as unknown as Database['pool'];
  return {
    database: new Database(pool),
    close: () => new Promise<void>(resolve => {child.once('exit', () => resolve()); child.disconnect();}),
  };
}

/** Como `pg`: bytea → Buffer. */
function toNodeRow(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value]));
}
