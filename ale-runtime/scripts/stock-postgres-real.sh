#!/usr/bin/env bash
# Validación de V19 sobre Postgres real y desechable: Flyway, segundo migrate sin cambios, matriz de grants y
# pruebas con concurrencia real. Nunca apunta a una base compartida. Requiere STOCK_PG_URL, psql y flyway.
set -euo pipefail

: "${STOCK_PG_URL:?STOCK_PG_URL es obligatorio}"
command -v psql >/dev/null || { echo 'falta psql' >&2; exit 2; }
command -v flyway >/dev/null || { echo 'falta flyway' >&2; exit 2; }
case "$STOCK_PG_URL" in
  *@postgres:*|*@localhost:*|*@127.0.0.1:*) ;;
  *) echo 'STOCK_PG_URL debe ser una base local y desechable' >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Identidad del runtime: solo vive en esta base desechable.
runtime_password="stock-ci-runtime"
psql "$STOCK_PG_URL" -v ON_ERROR_STOP=1 -qc \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='assistant') THEN CREATE ROLE assistant LOGIN PASSWORD '${runtime_password}'; END IF; END \$\$"

jdbc="$(node -e 'const u=new URL(process.env.STOCK_PG_URL);process.stdout.write(`jdbc:postgresql://${u.host}${u.pathname}`)')"
export FLYWAY_URL="$jdbc"
export FLYWAY_USER="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.STOCK_PG_URL).username))')"
export FLYWAY_PASSWORD="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.STOCK_PG_URL).password))')"
migrate() {
  flyway -locations=filesystem:migrations -schemas=assistant -defaultSchema=assistant -table=flyway_schema_history \
    -cleanDisabled=true -validateMigrationNaming=true migrate
}

echo '== Primer migrate'
migrate | tee /tmp/stock-flyway-1.log
grep -q 'Successfully applied' /tmp/stock-flyway-1.log

echo '== Segundo migrate: no debe aplicar nada'
migrate | tee /tmp/stock-flyway-2.log
grep -q 'No migration necessary' /tmp/stock-flyway-2.log
if grep -q 'Successfully applied' /tmp/stock-flyway-2.log; then echo 'el segundo migrate cambió el schema' >&2; exit 1; fi
version="$(psql "$STOCK_PG_URL" -Atc "SELECT max(version::int) FROM assistant.flyway_schema_history WHERE success")"
test "$version" = '19'

echo '== Matriz de grants del runtime'
psql "$STOCK_PG_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
DO $$
DECLARE
  append_only text[] := ARRAY['stock_movements','stock_confirmations','stock_audit'];
  t text; p text;
BEGIN
  FOREACH t IN ARRAY append_only LOOP
    IF NOT has_table_privilege('assistant', format('assistant.%I', t), 'SELECT')
       OR NOT has_table_privilege('assistant', format('assistant.%I', t), 'INSERT') THEN
      RAISE EXCEPTION 'falta SELECT/INSERT en %', t;
    END IF;
    FOREACH p IN ARRAY ARRAY['UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('assistant', format('assistant.%I', t), p) THEN RAISE EXCEPTION '% no debe tener %', t, p; END IF;
    END LOOP;
  END LOOP;
  FOR t IN SELECT table_name FROM information_schema.tables WHERE table_schema='assistant' AND table_name LIKE 'stock\_%' AND NOT (table_name = ANY(append_only)) LOOP
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT has_table_privilege('assistant', format('assistant.%I', t), p) THEN RAISE EXCEPTION 'falta % en %', p, t; END IF;
    END LOOP;
  END LOOP;
  IF NOT has_sequence_privilege('assistant', 'assistant.stock_robot_events_id_seq', 'USAGE') THEN RAISE EXCEPTION 'falta la secuencia'; END IF;
  IF has_table_privilege('assistant', 'assistant.flyway_schema_history', 'SELECT') THEN RAISE EXCEPTION 'el runtime lee el historial de Flyway'; END IF;
END $$;
SQL

echo '== Pruebas con el rol de runtime y conexiones reales'
runtime_url="$(RUNTIME_PASSWORD="$runtime_password" node -e 'const u=new URL(process.env.STOCK_PG_URL);u.username="assistant";u.password=process.env.RUNTIME_PASSWORD;process.stdout.write(u.href)')"
STOCK_PG_RUNTIME_URL="$runtime_url" npx jest --runInBand test/stock-postgres.real.spec.ts
