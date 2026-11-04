// PGlite de larga vida fuera del sandbox de jest (PGlite usa import() dinámico).
// Protocolo por IPC (serialización 'advanced': Buffer, Date y Uint8Array viajan tal cual):
//   → {id, sql, params?}   ← {id, rows, rowCount} | {id, error}
// Al arrancar aplica los SQL de argv (migraciones) y responde {ready:true}.
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const db = new PGlite();
try {
  for (const file of process.argv.slice(2)) await db.exec(readFileSync(file, 'utf8'));
  process.send({ready: true});
} catch (error) {
  process.send({ready: false, error: String(error?.message)});
}
// Una consulta a la vez, en orden de llegada (como una conexión de Postgres).
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    try {
      const result = await db.query(message.sql, message.params ?? []);
      process.send({id: message.id, rows: result.rows, rowCount: result.affectedRows ?? result.rows.length});
    } catch (error) {
      process.send({id: message.id, error: String(error?.message)});
    }
  });
});
process.on('disconnect', () => {void db.close().finally(() => process.exit(0));});
