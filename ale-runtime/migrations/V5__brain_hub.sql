-- ============================================================================
-- V5 (ORQA cliente, OSB-015): schema `brain_hub`, el buzón del Cerebro SaleADS.
--
-- ADR0020: aprender entre negocios solo con habilidades, nunca con datos. Aquí
-- llegan lecciones abstractas de lo que el dueño dice o decide (desidentificadas
-- en su VM); un admin las valida y las publica como ítems del catálogo.
-- Aislado en su propio schema y módulo para poder extraerlo a un microservicio.
-- Sin FKs entre schemas. Nunca métricas de plataforma ni datos personales.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS brain_hub;

CREATE TABLE brain_hub.lessons (
    id             uuid        PRIMARY KEY,
    user_id        text        NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    business_id    uuid        NOT NULL,
    industry_slug  text        NOT NULL CHECK (industry_slug ~ '^[a-z][a-z0-9_]{1,63}$'),
    text           text        NOT NULL CHECK (char_length(text) BETWEEN 20 AND 1000),
    provenance     text        NOT NULL CHECK (provenance IN ('owner_said', 'owner_decided')),
    status         text        NOT NULL DEFAULT 'received'
                               CHECK (status IN ('received', 'validated', 'rejected', 'published')),
    reviewer_id    text        CHECK (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    catalog_item_id text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    reviewed_at    timestamptz
);

CREATE INDEX lessons_industry_status_idx ON brain_hub.lessons (industry_slug, status, created_at DESC);
CREATE INDEX lessons_user_idx ON brain_hub.lessons (user_id, created_at DESC);

CREATE TABLE brain_hub.catalog_items (
    id             text        NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    version        text        NOT NULL CHECK (char_length(version) BETWEEN 1 AND 64),
    kind           text        NOT NULL CHECK (kind IN ('skill', 'mcp')),
    source         text        NOT NULL CHECK (source IN ('saleads_capability', 'industry_playbook', 'validated_lesson')),
    industry_slug  text        CHECK (industry_slug ~ '^[a-z][a-z0-9_]{1,63}$'),
    name           text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    summary        text        CHECK (char_length(summary) <= 500),
    files          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    provenance     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retired')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, version)
);

-- Una sola versión activa por ítem.
CREATE UNIQUE INDEX catalog_items_active_uq ON brain_hub.catalog_items (id) WHERE status = 'active';

CREATE TABLE brain_hub.installs (
    user_id     text        NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    item_id     text        NOT NULL,
    version     text        NOT NULL,
    status      text        NOT NULL CHECK (status IN ('proposed', 'installed', 'rejected', 'uninstalled')),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, item_id)
);

-- Industria de cada negocio, la informa el MCP (categoría del wizard de BI).
-- La web filtra el catálogo con ella sin consultar a BI (OSB-016).
CREATE TABLE brain_hub.business_industries (
    business_id    uuid        PRIMARY KEY,
    industry_slug  text        NOT NULL CHECK (industry_slug ~ '^[a-z][a-z0-9_]{1,63}$'),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Compartir viene activado por defecto: sin fila, el dueño comparte.
CREATE TABLE brain_hub.sharing_preferences (
    user_id        text        PRIMARY KEY CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    opted_out_at   timestamptz,
    notice_ack_at  timestamptz
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT USAGE ON SCHEMA brain_hub TO assistant;
        GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA brain_hub TO assistant;
        ALTER DEFAULT PRIVILEGES IN SCHEMA brain_hub GRANT SELECT, INSERT, UPDATE ON TABLES TO assistant;
    ELSE
        RAISE NOTICE 'role assistant not present; brain_hub grants skipped';
    END IF;
END $$;
