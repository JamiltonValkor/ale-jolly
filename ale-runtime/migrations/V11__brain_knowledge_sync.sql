-- ============================================================================
-- V11 (API agencial, AAB-013): cursor del empuje de conocimiento a BI.
--
-- Por dueño y negocio, la última versión de la foto del cerebro que BI ya
-- recibió (knowledge-sync.v1). Un fallo deja `failed` y el próximo sondeo
-- reintenta desde el mismo cursor. Sin FKs (BI es otro servicio).
-- ============================================================================

CREATE TABLE IF NOT EXISTS assistant.brain_knowledge_sync (
    user_id              TEXT        NOT NULL,
    business_id          UUID        NOT NULL,
    last_synced_version  INTEGER     NOT NULL DEFAULT 0,
    status               TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('ok', 'pending', 'failed')),
    attempts             INTEGER     NOT NULL DEFAULT 0,
    last_error_code      TEXT        NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, business_id)
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT, UPDATE ON assistant.brain_knowledge_sync TO assistant;
    END IF;
END $$;
