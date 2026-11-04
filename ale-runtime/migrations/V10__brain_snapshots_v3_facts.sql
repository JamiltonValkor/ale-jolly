-- ============================================================================
-- V10 (API agencial, AAB-019): fotos v3 del cerebro con hechos tipados.
--
-- La imagen nueva del cerebro sube `saleads-explorer-snapshot/3`: la v2 más una
-- sección `facts` por negocio (hechos vigentes del dueño por ruta de BI). Se
-- guarda la versión con `schema_version = 3`; el front sigue leyendo v1 y v2.
-- ============================================================================

ALTER TABLE assistant.brain_snapshots DROP CONSTRAINT IF EXISTS brain_snapshots_schema_version_check;
ALTER TABLE assistant.brain_snapshots
    ADD CONSTRAINT brain_snapshots_schema_version_check CHECK (schema_version IN (1, 2, 3));
