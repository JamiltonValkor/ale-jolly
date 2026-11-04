"""`saleads-brain serve | ingest-seed [ruta] | ingest-day | analyze | export-snapshot | extract-lessons`."""

from __future__ import annotations

import asyncio
import json
import sys

from saleads_brain.app import COMMANDS, Brain
from saleads_brain.ledger import Ledger
from saleads_brain.settings import load


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] not in ("serve", *COMMANDS):
        sys.stderr.write("usage: saleads-brain serve|" + "|".join(COMMANDS) + "\n")
        return 64
    settings = load()
    from saleads_brain.graph import FalkorStore

    settings.data_dir.mkdir(parents=True, exist_ok=True)
    brain = Brain(
        settings,
        FalkorStore(settings.falkor_host, settings.falkor_port),
        Ledger(settings.ledger_path),
    )
    if args[0] == "serve":
        from saleads_brain.server import create_server

        create_server(brain).run(transport="streamable-http")
        return 0
    result = asyncio.run(brain.run(args[0], args[1] if len(args) > 1 else None))
    # Solo contadores (nunca contenido) para el log del watcher.
    sys.stderr.write(json.dumps({k: v for k, v in result.items() if k != "message"}) + "\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
