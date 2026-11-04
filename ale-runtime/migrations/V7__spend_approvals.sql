-- ============================================================================
-- V7 (agente de marketing, MLB-013): aprobaciones de gasto.
--
-- Lanzar un plan, pausar o reanudar una campaña y cambiar el presupuesto de un
-- plan sin lanzar los aprueba el dueño en la web con un código de un solo uso
-- (simulado en el MVP, D8). El servicio ejecuta con los mismos endpoints que la
-- web. Solo se guarda el hash del código; vence en 5 minutos, 3 intentos por
-- código y como máximo 3 códigos por aprobación.
-- ============================================================================

ALTER TABLE assistant.approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE assistant.approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
    'install_skill', 'uninstall_skill', 'install_mcp',
    'launch_plan', 'pause_campaign', 'change_budget', 'resume_campaign'));

ALTER TABLE assistant.approvals
    ADD COLUMN details        jsonb,
    ADD COLUMN params         jsonb,
    ADD COLUMN otp_hash       text CHECK (otp_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN otp_expires_at timestamptz,
    ADD COLUMN otp_attempts   integer NOT NULL DEFAULT 0 CHECK (otp_attempts BETWEEN 0 AND 3),
    ADD COLUMN otp_issued     integer NOT NULL DEFAULT 0 CHECK (otp_issued BETWEEN 0 AND 3);
