"""Valida el bundle con el código de Hermes 818c13be (OSB-008).

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
names = set()
for name in sorted(os.listdir(skills_dir)):
    fm, _ = parse_frontmatter(open(os.path.join(skills_dir, name, "SKILL.md"), encoding="utf-8").read())
    if fm.get("name") != name or not NAME.match(name):
        errors.append(f"{name}: nombre inválido")
    if not fm.get("description"):
        errors.append(f"{name}: sin descripción")
    names.add(name)

for job in json.load(open(os.path.join(HERE, "jobs.json"), encoding="utf-8"))["jobs"]:
    if (err := _scan_cron_prompt(job["prompt"])):
        errors.append(f"{job['name']}: {err}")
    if parse_schedule(job["schedule"])["kind"] != "cron":
        errors.append(f"{job['name']}: horario no cron")
    if len(job["prompt"]) > 5000 or len(job["name"]) > 200:
        errors.append(f"{job['name']}: demasiado largo")
    for skill in job.get("skills", []):
        if skill not in names:
            errors.append(f"{job['name']}: skill {skill} no existe")

print("\n".join(errors) or f"OK: {len(names)} skills")
sys.exit(1 if errors else 0)
