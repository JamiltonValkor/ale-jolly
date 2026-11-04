"""AAB-013 (D27): la foto del cerebro sale poco después de cada escritura tipada, no cada 6 horas.

Una ráfaga de escrituras programa UNA exportación al cabo de `delay` segundos; `flush` exporta ya (cierre de la
vuelta). Un fallo no rompe la escritura que la disparó: queda en el log con su tipo, sin contenido.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger("saleads_brain.export")


class SnapshotDebouncer:
    def __init__(
        self,
        export: Callable[[], Awaitable[dict[str, Any]]],
        delay: float = 30.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._export = export
        self._delay = delay
        self._sleep = sleep
        self._pending: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    @property
    def pending(self) -> bool:
        return self._pending is not None and not self._pending.done()

    def schedule(self) -> None:
        """Programa una exportación si no hay otra esperando (la ráfaga comparte la misma)."""
        if self.pending:
            return
        self._pending = asyncio.get_running_loop().create_task(self._later())

    async def flush(self) -> dict[str, Any]:
        """Exporta ahora; la pendiente (si había) ya no hace falta."""
        if self.pending and self._pending is not None:
            self._pending.cancel()
        self._pending = None
        return await self._run()

    async def _later(self) -> None:
        await self._sleep(self._delay)
        self._pending = None
        try:
            await self._run()
        except Exception as error:  # noqa: BLE001 - la escritura ya quedó; se registra solo el tipo
            log.warning("export-snapshot por evento falló: %s", type(error).__name__)

    async def _run(self) -> dict[str, Any]:
        async with self._lock:
            return await self._export()
