-- ============================================================================
-- V8 (agente de marketing, MLB-014): fotos v2 del cerebro y cola del feedback.
--
-- La imagen nueva del cerebro sube `saleads-explorer-snapshot/2`; cada versión
-- guarda su esquema para servir la v1 al front viejo. Las subidas marcadas
-- inválidas antes de este despliegue (una v2 contra el parser v1) se reprocesan.
-- Lo que el dueño dice de una memoria en «Mi cerebro» se encola y le llega a Ale
-- por una sesión aparte (D49), nunca a su chat. El texto no va a eventos ni logs.
-- ============================================================================

ALTER TABLE assistant.brain_snapshots
    ADD COLUMN schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2));

DELETE FROM assistant.brain_snapshot_uploads WHERE outcome = 'invalid';

CREATE TABLE assistant.brain_feedback_queue (
    id              uuid        PRIMARY KEY,
    user_id         text        NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    business_id     uuid        NOT NULL,
    node_id         text        NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 64),
    node_label      text        NOT NULL CHECK (char_length(node_label) <= 200),
    node_type       text        NOT NULL CHECK (char_length(node_type) <= 64),
    action          text        NOT NULL CHECK (action IN ('confirm', 'correct', 'no_longer_applies')),
    text            text        CHECK (char_length(text) <= 1000),
    idempotency_key text        CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
    status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        integer     NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz
);

CREATE UNIQUE INDEX brain_feedback_idem_uq ON assistant.brain_feedback_queue (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX brain_feedback_pending_idx ON assistant.brain_feedback_queue (user_id, created_at) WHERE status = 'pending';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT, UPDATE ON assistant.brain_feedback_queue TO assistant;
    END IF;
END $$;
