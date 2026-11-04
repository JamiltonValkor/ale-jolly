-- ============================================================================
-- V4 (ORQA cliente, OSB-013): aprobaciones de instalación.
--
-- Instalar una habilidad del catálogo o un MCP lo aprueba el dueño en la web
-- con su sesión. Cada aprobación vence (24 h), es de un solo uso y queda STALE
-- si el ítem cambió de versión. El rechazo queda registrado para no insistir.
-- La numeración reserva V3 para brain_snapshots (OSB-010) y V5 para brain_hub.
-- Sin FKs, como V1. Sin contenido privado: solo ids, versión y nombre público.
-- ============================================================================

CREATE TABLE assistant.approvals (
    id            uuid        PRIMARY KEY,
    user_id       text        NOT NULL
                              CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    business_id   uuid        NOT NULL,
    kind          text        NOT NULL CHECK (kind IN ('install_skill', 'uninstall_skill', 'install_mcp')),
    item_id       text        NOT NULL CHECK (item_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    item_version  text        NOT NULL CHECK (char_length(item_version) BETWEEN 1 AND 64),
    item_name     text        NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 120),
    item_summary  text        CHECK (char_length(item_summary) <= 500),
    status        text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'executing', 'executed', 'failed', 'rejected', 'expired', 'stale')),
    decision_key  text        CHECK (decision_key ~ '^[A-Za-z0-9_-]{8,128}$'),
    result        jsonb,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    decided_at    timestamptz
);

CREATE INDEX approvals_user_created_idx ON assistant.approvals (user_id, created_at DESC);

-- Una sola propuesta pendiente por ítem y versión.
CREATE UNIQUE INDEX approvals_pending_item_uq
    ON assistant.approvals (user_id, kind, item_id, item_version)
    WHERE status = 'pending';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT, UPDATE ON assistant.approvals TO assistant;
    END IF;
END $$;
