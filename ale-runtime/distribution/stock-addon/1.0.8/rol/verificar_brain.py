"""Falla la construcción si la imagen no atiende a todos los roles de siempre más stock."""
import json
from importlib import resources

ROLES = {"ale", "investigador", "estratega", "estructurador", "analista", "optimizador", "disenador_landings", "curador", "stock"}
contracts = resources.files("saleads_brain").joinpath("contracts/mcl")
trusted = json.loads(contracts.joinpath("trusted-context.schema.json").read_text())
found = set(trusted["properties"]["actor_role"]["enum"])
if found != ROLES:
    raise SystemExit(f"roles inesperados: {sorted(found ^ ROLES)}")
experience = json.loads(contracts.joinpath("specialist-experience.schema.json").read_text())
if "stock" not in experience["properties"]["specialist_role"]["enum"]:
    raise SystemExit("specialist-experience sin stock")
print("roles ok")
