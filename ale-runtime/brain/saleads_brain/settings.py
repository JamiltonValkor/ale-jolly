"""Configuración del cerebro desde el entorno (derivado del .env del dueño por el watcher)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# D16 (MCB-009): el cerebro nunca llama a OpenRouter. Las constantes quedan solo para las rutas con LLM,
# hoy inalcanzables (`llm_enabled` es siempre False), que son la base de una mejora futura.
OPENROUTER_BASE = "https://openrouter.ai/api/v1"
# Elegido en la compuerta OSB-001: 100 % JSON válido, ~9 s por episodio.
DEFAULT_LLM_MODEL = "deepseek/deepseek-v4-flash-0731"
DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"


@dataclass(frozen=True, slots=True)
class Settings:
    # D16: siempre None. `load()` no lee OPENROUTER_API_KEY aunque el watcher la copie del .env del dueño.
    api_key: str | None
    llm_model: str
    embedding_model: str
    falkor_host: str
    falkor_port: int
    data_dir: Path
    hermes_data: Path
    port: int
    # Token de Ale (MLB-009): solo el MCP del profile raíz lo manda; sin él no se escriben aprendizajes.
    ale_token: str | None = None
    owner_id: str | None = None
    managed_curation_enabled: bool = False

    @property
    def llm_enabled(self) -> bool:
        """D16 (MCB-009): el cerebro no tiene modelo propio. Guarda y busca; el que piensa es Ale."""
        return False

    @property
    def learned_dir(self) -> Path:
        """Tipos aprendidos activos, un archivo por negocio (MLB-011)."""
        return self.data_dir / "learned-ontology"

    @property
    def ledger_path(self) -> Path:
        return self.data_dir / "ledger.db"

    @property
    def seed_path(self) -> Path:
        return self.hermes_data / "saleads" / "seed" / "seed.json"

    @property
    def snapshot_path(self) -> Path:
        return self.hermes_data / "saleads" / "graph" / "snapshot.json.gz"

    @property
    def state_db(self) -> Path:
        return self.hermes_data / "state.db"


def load(env: dict[str, str] | None = None) -> Settings:
    e = dict(os.environ if env is None else env)
    return Settings(
        api_key=None,
        llm_model=e.get("BRAIN_LLM_MODEL", DEFAULT_LLM_MODEL),
        embedding_model=e.get("BRAIN_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
        falkor_host=e.get("FALKOR_HOST", "falkordb"),
        falkor_port=int(e.get("FALKOR_PORT", "6379")),
        data_dir=Path(e.get("BRAIN_DATA", "/brain")),
        hermes_data=Path(e.get("HERMES_DATA", "/opt/data")),
        port=int(e.get("BRAIN_PORT", "8765")),
        ale_token=(e.get("BRAIN_ALE_TOKEN") or "").strip() or None,
        owner_id=(e.get("BRAIN_OWNER_ID") or "").strip() or None,
        managed_curation_enabled=e.get("BRAIN_MANAGED_CURATION", "").lower() == "true",
    )


def group_id(business_id: str) -> str:
    """Grafo de FalkorDB por negocio (Graphiti usa el group_id como nombre del grafo)."""
    return "b_" + business_id.replace("-", "").lower()
