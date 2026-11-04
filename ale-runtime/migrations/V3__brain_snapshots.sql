-- ============================================================================
-- V3 (ORQA cliente, OSB-010): fotos del cerebro del negocio.
--
-- La VM sube una foto (`saleads-explorer-snapshot/1`, .json.gz) con N negocios
-- a una URL PUT firmada; el servicio la valida, descarta negocios que no son
-- del dueño y guarda una versión por negocio (objeto JSON en GCS). El front la
-- lee aunque la VM esté apagada. Sin FKs entre microservicios.
-- ============================================================================

CREATE TABLE assistant.brain_snapshots (
    user_id      text        NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    business_id  uuid        NOT NULL,
    version      integer     NOT NULL CHECK (version >= 1),
    object_path  text        NOT NULL CHECK (char_length(object_path) BETWEEN 1 AND 512),
    sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    node_count   integer     NOT NULL CHECK (node_count >= 0),
    edge_count   integer     NOT NULL CHECK (edge_count >= 0),
    generated_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, business_id, version)
);

CREATE INDEX brain_snapshots_timeline_idx ON assistant.brain_snapshots (user_id, business_id, version DESC);

-- Última foto de la VM ya procesada (válida o descartada): evita reprocesarla.
CREATE TABLE assistant.brain_snapshot_uploads (
    user_id      text        PRIMARY KEY CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    sha256       text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    outcome      text        NOT NULL CHECK (outcome IN ('stored', 'invalid', 'no_owned_business')),
    processed_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT ON assistant.brain_snapshots TO assistant;
        GRANT SELECT, INSERT, UPDATE ON assistant.brain_snapshot_uploads TO assistant;
    END IF;
END $$;
