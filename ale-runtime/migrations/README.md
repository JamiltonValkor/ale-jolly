# Migraciones Flyway — schema `assistant`

Las migraciones SQL de esta carpeta son inmutables. Un cambio de schema añade
un archivo `V<n+1>__*.sql`; nunca modifica una migración ya aplicada. El servicio
no ejecuta DDL al arrancar.

La conexión PostgreSQL, su base y el rol de runtime pertenecen a tu despliegue.
La identidad que ejecuta Flyway debe poder crear y mantener el schema; no uses
esa identidad como usuario habitual del servicio. `V1` concede `USAGE` y DML al
rol `assistant` si existe.

## Validar y aplicar

`npm test -- --runInBand` valida el schema y sus restricciones con bases PGlite
efímeras. La receta [de validación remota](../ci/README.md) ejecuta esas pruebas
sin Docker local. Esto no sustituye una ejecución real de Flyway en PostgreSQL.

Antes de cambiar SQL, valida todas las migraciones con Flyway sobre una base
PostgreSQL desechable, incluido un segundo `migrate` sin cambios pendientes y
la matriz de grants del rol de runtime. No uses una base productiva.

Para aplicar, configura `FLYWAY_URL`, `FLYWAY_USER` y `FLYWAY_PASSWORD` fuera del
repositorio y ejecuta:

```bash
flyway \
  -locations=filesystem:migrations \
  -schemas=assistant \
  -defaultSchema=assistant \
  -table=flyway_schema_history \
  -cleanDisabled=true \
  -validateMigrationNaming=true \
  migrate
```

Las recetas operativas, identidades y conexiones de cada entorno se mantienen
fuera de esta copia pública.
