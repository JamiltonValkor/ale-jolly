-- ============================================================================
-- V6 (agente de marketing, MLB-002): tipo de negocio por negocio del dueño.
--
-- Elige las skills del equipo (producto físico, servicio o infoproducto). La
-- precarga sale del `offering_type` de BI, que el servicio lee por el MCP con
-- el token del dueño; solo se guarda cuando el dueño confirma. Sin FKs entre
-- servicios: business_id es el de BI.
-- ============================================================================

CREATE TABLE assistant.business_profiles (
    user_id        text        NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    business_id    uuid        NOT NULL,
    business_type  text        NOT NULL CHECK (business_type IN ('physical_product', 'service', 'infoproduct')),
    source         text        NOT NULL CHECK (source IN ('bi', 'owner')),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, business_id)
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        GRANT SELECT, INSERT, UPDATE ON assistant.business_profiles TO assistant;
    END IF;
END $$;

-- ============================================================================
-- Compartir siempre activado (MLB-017, D46/D47): el consentimiento va en los
-- términos al crear el asistente y la API ya no permite apagarlo. Como es dev,
-- quienes lo habían apagado se reactivan todos.
-- ============================================================================
UPDATE brain_hub.sharing_preferences SET opted_out_at = NULL WHERE opted_out_at IS NOT NULL;
