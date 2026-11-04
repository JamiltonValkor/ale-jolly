"""Valida el bundle con el código de Hermes 818c13be (OSB-008, MLB-004).

Recorre las skills en cualquier nivel (skills/<skill>, skills/types/<t>/<skill>,
skills/functions/<skill>): Hermes las encuentra anidadas (agent/skill_utils.py).
Uso: python validate.py <ruta a hermes-agent>
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, sys.argv[1])

from agent.skill_utils import parse_frontmatter  # noqa: E402
from cron.jobs import parse_schedule  # noqa: E402
from tools.cronjob_tools import _scan_cron_prompt  # noqa: E402

NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
errors = []
skills_dir = os.path.join(HERE, "skills")
names = {}
for root, _dirs, files in sorted(os.walk(skills_dir)):
    if "SKILL.md" not in files:
        continue
    folder = os.path.basename(root)
    rel = os.path.relpath(root, skills_dir)
    fm, _ = parse_frontmatter(open(os.path.join(root, "SKILL.md"), encoding="utf-8").read())
    if fm.get("name") != folder or not NAME.match(folder):
        errors.append(f"{rel}: nombre inválido")
    if not fm.get("description") or len(fm["description"]) > 1024:
        errors.append(f"{rel}: descripción ausente o de más de 1024 caracteres")
    if folder in names:
        errors.append(f"{rel}: nombre repetido (también en {names[folder]})")
    names[folder] = rel

jobs_path = os.path.join(HERE, "jobs.json")
jobs = json.load(open(jobs_path, encoding="utf-8"))["jobs"] if os.path.exists(jobs_path) else []
for job in jobs:
    if (err := _scan_cron_prompt(job["prompt"])):
        errors.append(f"{job['name']}: {err}")
    if parse_schedule(job["schedule"])["kind"] != "cron":
        errors.append(f"{job['name']}: horario no cron")
    if len(job["prompt"]) > 5000 or len(job["name"]) > 200:
        errors.append(f"{job['name']}: demasiado largo")
    for skill in job.get("skills", []):
        if names.get(skill) != skill:
            errors.append(f"{job['name']}: skill {skill} no existe en el primer nivel")

print("\n".join(errors) or f"OK: {len(names)} skills")
sys.exit(1 if errors else 0)
