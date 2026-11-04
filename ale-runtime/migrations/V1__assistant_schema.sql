-- ============================================================================
-- V1: schema `assistant` del asistente Hermes en un clic (OCB-006, ADR0028).
--
-- Base `assistant_db` en la instancia Cloud SQL saleads-dev-svc04. Flyway corre
-- en Cloud Build con la identidad de CI, así que los objetos quedan de ese rol.
-- El pod se conecta como el rol `assistant` (DATABASE_URL del ExternalSecret).
-- Modelo: docs/tasks/saleads-hermes-one-click-mvp-v1/architecture.md.
--
-- Campos *_enc: AES-256-GCM por la aplicación, AAD
-- 'assistant:<tabla>.<columna>:<user_id>'. La base nunca ve texto plano.
-- Sin FKs: cada tabla se escribe en un paso distinto del flujo (OCB-007).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS assistant;

-- Una fila por usuario (un asistente, una VM). `deleted_at` marca el borrado:
-- GET /assistants/me devuelve status=none si no hay fila o si está borrada.
CREATE TABLE assistant.assistants (
    user_id                text        PRIMARY KEY
                                       CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    status                 text        NOT NULL
                                       CHECK (status IN ('activating', 'ready', 'stopped', 'failed', 'deleting')),
    step                   text        CHECK (step IN ('preparing_access', 'preparing_environment', 'installing_agent', 'configure_ai')),
    instance_name          text        CHECK (instance_name ~ '^sa-assistant-[a-f0-9]{32}$'),
    zone                   text        CHECK (char_length(zone) <= 64),
    private_ip             inet,
    api_server_key_enc     bytea,
    bundle_version         text        CHECK (char_length(bundle_version) <= 128),
    ai_provider            text        CHECK (char_length(ai_provider) <= 100),
    ai_model               text        CHECK (char_length(ai_model) <= 200),
    ai_configured          boolean     NOT NULL DEFAULT false,
    session_id             text        CHECK (char_length(session_id) <= 200),
    activation_started_at  timestamptz,
    ready_since            timestamptz,
    attempts               integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    deleted_at             timestamptz
);

CREATE UNIQUE INDEX assistants_instance_name_uq
    ON assistant.assistants (instance_name)
    WHERE instance_name IS NOT NULL AND deleted_at IS NULL;

-- Credencial propia del asistente ante el MCP (offline token cifrado).
CREATE TABLE assistant.assistant_credentials (
    user_id            text        PRIMARY KEY
                                   CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    refresh_token_enc  bytea       NOT NULL,
    access_expires_at  timestamptz,
    obtained_at        timestamptz NOT NULL DEFAULT now()
);

-- Flujo OAuth en curso (PKCE + prompt=none). Se guarda el hash del state, nunca
-- el state; el verifier va cifrado. TTL de 10 minutos.
CREATE TABLE assistant.oauth_flows (
    state_hash    text        PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
    user_id       text        NOT NULL
                              CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    verifier_enc  bytea       NOT NULL,
    expires_at    timestamptz NOT NULL
);

CREATE INDEX oauth_flows_expires_at_idx ON assistant.oauth_flows (expires_at);
CREATE INDEX oauth_flows_user_id_idx ON assistant.oauth_flows (user_id);

-- Registro append-only de lo que pasó (causas exactas para el equipo, OCM-002 y
-- OCM-009). Sin contenido privado: ni tokens, ni keys, ni chat.
CREATE TABLE assistant.assistant_events (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      text        NOT NULL
                             CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    kind         text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{0,63}$'),
    phase        text        CHECK (phase ~ '^[a-z][a-z0-9_.]{0,63}$'),
    cause_code   text        CHECK (cause_code IN (
                                 'oauth_failed',
                                 'login_required',
                                 'vm_create_failed',
                                 'vm_start_failed',
                                 'vm_stop_failed',
                                 'vm_delete_failed',
                                 'readiness_timeout',
                                 'config_apply_failed',
                                 'ai_test_failed',
                                 'mcp_unavailable',
                                 'refresh_failed',
                                 'revoke_failed',
                                 'archive_failed',
                                 'unknown'
                             )),
    detail_safe  text        CHECK (char_length(detail_safe) <= 500),
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_events_user_at_idx ON assistant.assistant_events (user_id, at DESC);

CREATE FUNCTION assistant.reject_event_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'assistant_events is append-only';
END $$;

CREATE TRIGGER assistant_events_append_only
    BEFORE UPDATE OR DELETE ON assistant.assistant_events
    FOR EACH ROW EXECUTE FUNCTION assistant.reject_event_mutation();

-- ----------------------------------------------------------------------------
-- Grants de runtime para el rol `assistant` (copia del patrón de
-- sa-mcp-server V5__grant_runtime_role.sql:16-27). Condicional: el Postgres
-- efímero de Cloud Build y los tests no tienen ese rol.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT USAGE ON SCHEMA assistant TO assistant;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA assistant TO assistant;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA assistant TO assistant;
        ALTER DEFAULT PRIVILEGES IN SCHEMA assistant GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assistant;
        ALTER DEFAULT PRIVILEGES IN SCHEMA assistant GRANT USAGE, SELECT ON SEQUENCES TO assistant;
        -- El historial de Flyway (si vive en este schema) no es del runtime.
        IF to_regclass('assistant.flyway_schema_history') IS NOT NULL THEN
            REVOKE ALL ON TABLE assistant.flyway_schema_history FROM assistant;
        END IF;
    ELSE
        RAISE NOTICE 'role assistant not present; runtime grants skipped';
    END IF;
END $$;
