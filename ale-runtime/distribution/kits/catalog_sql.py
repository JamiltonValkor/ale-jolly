"""Genera el `files` de un kit para su migración del catálogo (AAB-023).

Uso: python3 distribution/kits/catalog_sql.py <carpeta de la skill del kit> <migración V__.sql>
Reemplaza el bloque entre `$kit$` de la migración por el árbol de la skill (claves ordenadas). Las migraciones ya
aplicadas son inmutables: solo se regenera antes de desplegar. test/kit-belleza.spec.ts compara byte a byte.
"""
import json
import os
import re
import sys

skill_dir, migration = sys.argv[1], sys.argv[2]
files = {}
for root, _dirs, names in os.walk(skill_dir):
    for name in names:
        path = os.path.join(root, name)
        files[os.path.relpath(path, skill_dir).replace(os.sep, "/")] = open(path, encoding="utf-8").read()
blob = json.dumps(dict(sorted(files.items())), ensure_ascii=False, indent=2)
if "$kit$" in blob or "${" in blob:
    sys.exit("el kit no puede contener $kit$ ni ${ (Flyway los interpreta)")
sql = open(migration, encoding="utf-8").read()
sql, count = re.subn(r"\$kit\$\n.*?\$kit\$::jsonb", lambda _m: "$kit$\n" + blob + "$kit$::jsonb", sql, flags=re.S)
if count != 1:
    sys.exit("la migración debe tener un solo bloque $kit$ … $kit$::jsonb")
open(migration, "w", encoding="utf-8").write(sql)
print(f"OK: {len(files)} archivos")
