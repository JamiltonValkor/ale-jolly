-- ============================================================================
-- V2 (OCB-016): zona horaria IANA del dueño, tomada de su navegador.
--
-- Aditiva: columna nullable, sin default ni backfill. NULL = el front aún no
-- la envió; el servicio escribe `timezone: "America/Bogota"` en config.yaml.
-- La valida la aplicación (Intl.DateTimeFormat); aquí solo se acota.
-- Los grants de V1 son por tabla: cubren la columna nueva.
-- ============================================================================

ALTER TABLE assistant.assistants
    ADD COLUMN timezone text CHECK (char_length(timezone) BETWEEN 1 AND 64);
