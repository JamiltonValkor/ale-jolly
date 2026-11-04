"""Validate the new bundle against the pinned official Hermes skill/cron parsers.
Usage: python validate.py <path-to-pinned-hermes-source>. No cloud or model calls.
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
        errors.append(f"{rel}: invalid name")
    if not fm.get("description") or len(fm["description"]) > 1024:
        errors.append(f"{rel}: missing description or more than1024characters")
    if folder in names:
        errors.append(f"{rel}: duplicate name (also in {names[folder]})")
    names[folder] = rel

jobs_path = os.path.join(HERE, "jobs.json")
jobs = json.load(open(jobs_path, encoding="utf-8"))["jobs"] if os.path.exists(jobs_path) else []
for job in jobs:
    if (err := _scan_cron_prompt(job["prompt"])):
        errors.append(f"{job['name']}: {err}")
    if parse_schedule(job["schedule"])["kind"] != "cron":
        errors.append(f"{job['name']}: schedule is not cron")
    if len(job["prompt"]) > 5000 or len(job["name"]) > 200:
        errors.append(f"{job['name']}: too long")
    for skill in job.get("skills", []):
        if names.get(skill) != skill:
            errors.append(f"{job['name']}: skill {skill} does not exist at top level")

if not names:
    errors.append("no skills found")

print("\n".join(errors) or f"OK: {len(names)} skills")
sys.exit(1 if errors else 0)
