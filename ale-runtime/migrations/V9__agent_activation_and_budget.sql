-- ============================================================================
-- V9 (API agencial, AAB-012): encendido de lo que publicó el agente y
-- presupuesto mensual aprobado del agente.
--
-- El agente (Ale) publica en pausa y propone el encendido; el dueño lo aprueba
-- en la web con un botón, sin código (D21). El presupuesto mensual aprobado
-- (D23) lo fija el dueño por negocio; cambiarlo cierra la fila vigente e
-- inserta otra revisión (historia append-only). Montos en el offset de Meta
-- (COP = pesos enteros, USD = centavos). Sin FKs entre servicios.
-- ============================================================================

ALTER TABLE assistant.approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE assistant.approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
    'install_skill', 'uninstall_skill', 'install_mcp',
    'launch_plan', 'pause_campaign', 'change_budget', 'resume_campaign',
    'activate_agent_publication'));

CREATE TABLE assistant.agent_monthly_budgets (
    id            uuid        PRIMARY KEY,
    business_id   uuid        NOT NULL,
    user_id       text        NOT NULL
                              CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    amount_minor  bigint      NOT NULL CHECK (amount_minor > 0),
    currency      char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    period_start  date        NOT NULL,
    revision      integer     NOT NULL CHECK (revision >= 1),
    set_by        text        NOT NULL CHECK (set_by = 'owner'),
    set_at        timestamptz NOT NULL DEFAULT now(),
    superseded_at timestamptz,
    UNIQUE (business_id, revision)
);

-- Una sola fila vigente por negocio.
CREATE UNIQUE INDEX agent_monthly_budgets_current_uq
    ON assistant.agent_monthly_budgets (business_id)
    WHERE superseded_at IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT, UPDATE ON assistant.agent_monthly_budgets TO assistant;
    END IF;
END $$;
