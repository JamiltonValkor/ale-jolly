// Ejecuta pasos SQL en un PGlite vacío fuera del sandbox de jest (PGlite usa
// import() dinámico, que jest no permite sin --experimental-vm-modules).
// Entrada (stdin): [{op:'exec'|'query', sql}] · Salida (stdout): [{ok, rows?, error?}]
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const steps = JSON.parse(readFileSync(0, 'utf8'));
const db = new PGlite();
const results = [];
try {
  for (const step of steps) {
    try {
      if (step.op === 'exec') {await db.exec(step.sql); results.push({ok: true});}
      else results.push({ok: true, rows: (await db.query(step.sql)).rows});
    } catch (error) {
      results.push({ok: false, error: String(error?.message)});
    }
  }
} finally {
  await db.close();
}
process.stdout.write(JSON.stringify(results));
