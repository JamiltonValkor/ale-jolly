"""Current operator policy affects eligibility, never immutable source authorship."""
from __future__ import annotations

import json
import stat
import uuid
from pathlib import Path
from typing import Any


class OperatorCanaryAdmission:
    def __init__(self, path: Path, owner_id: str) -> None:
        self.path, self.owner_id = path, owner_id
        self._signature: tuple[int, ...] | None = None
        self._ids: frozenset[str] | None = None

    def _clients(self) -> frozenset[str] | None:
        try:
            metadata = self.path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536:
                return None
            signature = (metadata.st_dev, metadata.st_ino, metadata.st_size,
                         metadata.st_mtime_ns, metadata.st_ctime_ns)
            if signature == self._signature:
                return self._ids
            value = json.loads(self.path.read_text())
            if (not isinstance(value, dict) or value.get("schema_version") != "operator-canary-clients/1"
                    or value.get("owner_id") != self.owner_id
                    or not isinstance(value.get("client_message_ids"), list)
                    or len(value["client_message_ids"]) > 1000):
                return None
            ids = frozenset(str(uuid.UUID(item)) for item in value["client_message_ids"])
            self._signature, self._ids = signature, ids
            return ids
        except (OSError, ValueError, TypeError, AttributeError):
            return None

    def __call__(self, owner_id: str, business_id: str, source: dict[str, Any]) -> str | None:
        if (owner_id, business_id) != (source.get("owner_id"), source.get("business_id")):
            return "source_binding_mismatch"
        if source.get("source_kind") != "owner_message":
            return None
        ids = self._clients() if owner_id == self.owner_id else None
        if ids is None:
            return "source_policy_unavailable"
        try:
            client = str(uuid.UUID(str(source.get("source_id"))))
        except (ValueError, TypeError, AttributeError):
            return None  # Legacy non-client source IDs are not guessed from their text.
        return "operator_canary" if client in ids else None
