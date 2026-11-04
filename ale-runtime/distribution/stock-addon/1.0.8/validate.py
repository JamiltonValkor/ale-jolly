#!/usr/bin/env python3
"""Valida el complemento de Stock sin red ni modelo.

Uso: python3 distribution/stock-addon/1.0.8/validate.py [--write]
--write reescribe `files` de manifest.json. Sin él, solo comprueba.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
TOOL = re.compile(r"saleads_stock_[a-z_]+")
# Ale no los ve (O-10) y Stock no debe confirmar ni hablar con el dueño (§7.4).
ONLY_STOCK = {"saleads_stock_take_photo", "saleads_stock_document_extract", "saleads_stock_supplier_send", "saleads_stock_supplier_wait"}
ONLY_ALE = {"saleads_stock_confirm_count", "saleads_stock_robot_say", "saleads_stock_document_register"}
VOSEO = re.compile(r"\b(tenés|podés|querés|sos|hacé|mirá|pedí|usá|decí|poné|contá)\b", re.I)
SKIP = {"manifest.json", "__pycache__"}


def files():
    return sorted(p for p in HERE.rglob("*") if p.is_file() and not (set(p.relative_to(HERE).parts) & SKIP))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest_path = HERE / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    current = {p.relative_to(HERE).as_posix(): digest(p) for p in files() if p.name != "validate.py"}
    if "--write" in sys.argv:
        manifest["files"] = current
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    errors = []
    if manifest.get("files") != current:
        errors.append("manifest.json no coincide con los archivos")
    known = set(re.findall(r"^## (saleads_stock_[a-z_]+)$", (REPO / "docs/stock-tools-v1.md").read_text(encoding="utf-8"), re.M))
    if len(known) != 15:
        errors.append(f"docs/stock-tools-v1.md trae {len(known)} herramientas y deben ser 15")
    for path in files():
        rel = path.relative_to(HERE).as_posix()
        if path.suffix not in (".md", ".json"):
            continue
        text = path.read_text(encoding="utf-8")
        cited = set(TOOL.findall(text))
        for tool in sorted(cited - known):
            errors.append(f"{rel}: herramienta inexistente {tool}")
        if rel.startswith("profiles/stock/"):
            for tool in sorted(cited & ONLY_ALE):
                errors.append(f"{rel}: Stock no tiene {tool}")
        elif rel in ("SOUL.addendum.md", "jobs.json") or rel.startswith("skills/"):
            for tool in sorted(cited & ONLY_STOCK):
                errors.append(f"{rel}: Ale no tiene {tool}")
        if VOSEO.search(text):
            errors.append(f"{rel}: voseo")
    soul = (HERE / "SOUL.addendum.md").read_text(encoding="utf-8")
    if not soul.startswith("<!-- stock:start -->") or not soul.rstrip().endswith("<!-- stock:end -->"):
        errors.append("SOUL.addendum.md sin marcadores")
    for skill in HERE.rglob("SKILL.md"):
        head = skill.read_text(encoding="utf-8").split("---")
        name = re.search(r"^name: (.+)$", head[1], re.M) if len(head) > 2 else None
        if not name or name.group(1) != skill.parent.name:
            errors.append(f"{skill.relative_to(HERE)}: nombre distinto a su carpeta")
    jobs = json.loads((HERE / "jobs.json").read_text(encoding="utf-8"))["jobs"]
    for job in jobs:
        if len(job["prompt"]) > 5000:
            errors.append(f"{job['name']}: prompt largo")
        for skill in job["skills"]:
            if not (HERE / "skills" / skill / "SKILL.md").is_file():
                errors.append(f"{job['name']}: skill raíz inexistente {skill}")
    print("\n".join(errors) or f"OK: {len(current)} archivos")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
