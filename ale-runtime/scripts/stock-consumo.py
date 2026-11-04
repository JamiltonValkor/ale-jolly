#!/usr/bin/env python3
"""Mide el consumo de Ale y de los workers en la VM, de solo lectura, contra el presupuesto de Stock (S-30).

Uso en la VM: python3 stock-consumo.py [--db ~/.hermes/state.db] [--horas 24]. Solo imprime JSON con números.
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

TURNO_ESPERADO = 136_000   # src/stock/usage.ts, STOCK_TOKENS
TURNO_TERMINAL = 503_000
DIARIO = 2_200_000


def clase(entrada):
    if entrada <= TURNO_ESPERADO:
        return "ok"
    return "alto" if entrada <= TURNO_TERMINAL else "fuera"


def medir(db, horas, ahora):
    # mode=ro: esta medición nunca debe tocar la base viva del asistente.
    con = sqlite3.connect(f"file:{Path(db).expanduser()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    filas = con.execute(
        """SELECT id, source, model, started_at, tool_call_count, input_tokens, output_tokens, cache_read_tokens
             FROM sessions WHERE started_at >= ? ORDER BY input_tokens DESC""",
        (ahora - horas * 3600,),
    ).fetchall()
    turnos = [dict(f) | {"clase": clase(f["input_tokens"] or 0)} for f in filas]
    total = sum(t["input_tokens"] or 0 for t in turnos)
    por_clase = {c: sum(1 for t in turnos if t["clase"] == c) for c in ("ok", "alto", "fuera")}
    return {
        "horas": horas, "turnos": len(turnos), "tokens_entrada": total, "cache_leida": sum(t["cache_read_tokens"] or 0 for t in turnos),
        "presupuesto_diario": DIARIO, "excede_presupuesto": total * 24 / horas > DIARIO, "por_clase": por_clase, "mayores": turnos[:10],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default="~/.hermes/state.db")
    ap.add_argument("--horas", type=float, default=24)
    args = ap.parse_args()
    json.dump(medir(args.db, args.horas, time.time()), sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
