-- Stock (inventario-vivo-v1): tablas aditivas en el schema assistant. Sin FK a tablas de otros dominios.
-- El libro es la verdad: stock_movements es de solo inserción y cada movimiento apunta a su confirmación.
-- Con un run de banco activo, lectura y libro usan solo filas de ese run_id; sin run, solo run_id IS NULL.
-- Un run simulado nunca se borra: los índices únicos incluyen el run para que dos corridas siembren igual.

CREATE FUNCTION assistant.reject_stock_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE FUNCTION assistant.reject_stock_mandate_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.target_price IS DISTINCT FROM OLD.target_price
       OR NEW.max_price IS DISTINCT FROM OLD.max_price
       OR NEW.max_quantity IS DISTINCT FROM OLD.max_quantity THEN
        RAISE EXCEPTION 'stock_negotiations mandate is immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE TABLE assistant.stock_enabled_businesses (
    business_id uuid PRIMARY KEY,
    user_id     text NOT NULL,
    currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    enabled_at  timestamptz NOT NULL DEFAULT now()
);

-- Un kit propuesto o recién aprobado puede vivir sin oferta (O-5); todo lo demás se liga a una oferta (R1).
CREATE TABLE assistant.stock_products (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    user_id         text NOT NULL,
    name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 200),
    offering_type   text CHECK (offering_type IN ('product','service')),
    offering_id     text,
    offering_name   text,
    is_kit          boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','archivado')),
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid,
    CHECK (is_kit OR offering_id IS NOT NULL),
    CHECK ((offering_id IS NULL) = (offering_type IS NULL))
);
CREATE UNIQUE INDEX stock_products_name_uq ON assistant.stock_products
    (business_id, normalized_name, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)));

CREATE TABLE assistant.stock_variants (
    id            uuid PRIMARY KEY,
    product_id    uuid NOT NULL REFERENCES assistant.stock_products(id),
    name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    sku_interno   text,
    units_per_box integer CHECK (units_per_box > 0),
    unit_cost     numeric(15,2) CHECK (unit_cost >= 0),
    sale_price    numeric(15,2) CHECK (sale_price >= 0),
    currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    is_kit        boolean NOT NULL DEFAULT false,
    recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_variants_product_idx ON assistant.stock_variants(product_id);

CREATE TABLE assistant.stock_kit_components (
    kit_variant_id       uuid NOT NULL REFERENCES assistant.stock_variants(id),
    component_variant_id uuid NOT NULL REFERENCES assistant.stock_variants(id),
    quantity             integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (kit_variant_id, component_variant_id),
    CHECK (kit_variant_id <> component_variant_id)
);

CREATE TABLE assistant.stock_proposals (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    user_id         text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('conteo','entrada','venta','catalogo','union_catalogo','pedido','kit','apuesta','autonomia')),
    title           text NOT NULL,
    reason          text NOT NULL,
    payload         jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','aprobada','rechazada','vencida')),
    revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    effects_yes     jsonb NOT NULL,
    effects_no      jsonb NOT NULL,
    expires_at      timestamptz NOT NULL,
    idempotency_key text NOT NULL,
    request_hash    text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    trace_id        uuid NOT NULL,
    created_by      text NOT NULL,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid
);
CREATE UNIQUE INDEX stock_proposals_idem_uq ON assistant.stock_proposals
    (business_id, idempotency_key, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX stock_proposals_business_status_idx ON assistant.stock_proposals(business_id, status);

-- Frases del dueño capturadas por el servidor: son del usuario, porque el robot es del usuario.
CREATE TABLE assistant.stock_owner_utterances (
    id          uuid PRIMARY KEY,
    user_id     text NOT NULL,
    device_id   uuid NOT NULL,
    text        text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_owner_utterances_user_idx ON assistant.stock_owner_utterances(user_id, recorded_at DESC);

CREATE TABLE assistant.stock_confirmations (
    id              uuid PRIMARY KEY,
    proposal_id     uuid NOT NULL UNIQUE REFERENCES assistant.stock_proposals(id),
    business_id     uuid NOT NULL,
    method          text NOT NULL CHECK (method IN ('web','voz','canal','semilla')),
    actor           text NOT NULL,
    utterance_id    uuid REFERENCES assistant.stock_owner_utterances(id),
    quote           text CHECK (char_length(quote) BETWEEN 1 AND 300),
    channel         text,
    session_id      text,
    decision        text NOT NULL CHECK (decision IN ('aprobada','rechazada')),
    reason          text CHECK (char_length(reason) <= 300),
    idempotency_key text,
    request_hash    text CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid,
    CHECK (method <> 'voz' OR utterance_id IS NOT NULL),
    CHECK (method <> 'canal' OR quote IS NOT NULL),
    CHECK (method <> 'semilla' OR (simulated AND run_id IS NOT NULL))
);
CREATE UNIQUE INDEX stock_confirmations_utterance_uq ON assistant.stock_confirmations (utterance_id)
    WHERE utterance_id IS NOT NULL;
CREATE UNIQUE INDEX stock_confirmations_idem_uq ON assistant.stock_confirmations
    (business_id, idempotency_key, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE assistant.stock_variant_aliases (
    alias_variant_id     uuid PRIMARY KEY REFERENCES assistant.stock_variants(id),
    canonical_variant_id uuid NOT NULL REFERENCES assistant.stock_variants(id),
    confirmation_id      uuid NOT NULL REFERENCES assistant.stock_confirmations(id),
    recorded_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (alias_variant_id <> canonical_variant_id)
);
CREATE INDEX stock_variant_aliases_canonical_idx ON assistant.stock_variant_aliases(canonical_variant_id);

-- Sin teléfono real: el número solo vive en el relé.
CREATE TABLE assistant.stock_suppliers (
    id             uuid PRIMARY KEY,
    business_id    uuid NOT NULL,
    user_id        text NOT NULL,
    name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    contact_label  text,
    lead_time_days integer CHECK (lead_time_days >= 0),
    occurred_at    timestamptz NOT NULL,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    simulated      boolean NOT NULL DEFAULT false,
    run_id         uuid
);
CREATE INDEX stock_suppliers_business_idx ON assistant.stock_suppliers(business_id);

CREATE TABLE assistant.stock_supplier_quotes (
    id                uuid PRIMARY KEY,
    supplier_id       uuid NOT NULL REFERENCES assistant.stock_suppliers(id),
    variant_id        uuid NOT NULL REFERENCES assistant.stock_variants(id),
    price             numeric(15,2) NOT NULL CHECK (price >= 0),
    freight           numeric(15,2) NOT NULL DEFAULT 0 CHECK (freight >= 0),
    min_qty           integer NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
    payment_term_days integer CHECK (payment_term_days >= 0),
    warranty          text,
    equivalent_proof  jsonb,
    currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    recorded_at       timestamptz NOT NULL DEFAULT now()
);

-- La fila nace al aprobar: una propuesta rechazada nunca crea pedido.
CREATE TABLE assistant.stock_orders (
    id               uuid PRIMARY KEY,
    business_id      uuid NOT NULL,
    user_id          text NOT NULL,
    variant_id       uuid NOT NULL REFERENCES assistant.stock_variants(id),
    supplier_id      uuid NOT NULL REFERENCES assistant.stock_suppliers(id),
    quantity         integer NOT NULL CHECK (quantity > 0),
    status           text NOT NULL CHECK (status IN ('aprobado','negociando','acordado','en_camino','recibido','cancelado')),
    expected_cost    numeric(15,2) CHECK (expected_cost >= 0),
    agreed_cost      numeric(15,2) CHECK (agreed_cost >= 0),
    base_unit_cost   numeric(15,2) CHECK (base_unit_cost >= 0),
    currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    received_qty     integer CHECK (received_qty >= 0),
    saving_confirmed numeric(15,2),
    novedad          text CHECK (novedad IN ('respuesta_proveedor')),
    proposal_id      uuid NOT NULL REFERENCES assistant.stock_proposals(id),
    occurred_at      timestamptz NOT NULL,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    simulated        boolean NOT NULL DEFAULT false,
    run_id           uuid
);
CREATE INDEX stock_orders_business_idx ON assistant.stock_orders(business_id, status);

CREATE TABLE assistant.stock_negotiations (
    order_id            uuid PRIMARY KEY REFERENCES assistant.stock_orders(id),
    target_price        numeric(15,2) NOT NULL CHECK (target_price >= 0),
    max_price           numeric(15,2) NOT NULL CHECK (max_price >= target_price),
    max_quantity        integer NOT NULL CHECK (max_quantity > 0),
    state               text NOT NULL DEFAULT 'abierta' CHECK (state IN ('abierta','esperando_proveedor','esperando_stock','acordada','sin_acuerdo','expirada')),
    round               integer NOT NULL DEFAULT 0 CHECK (round >= 0),
    last_offer          numeric(15,2),
    last_message_cursor bigint,
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stock_negotiations_mandate_fixed
    BEFORE UPDATE ON assistant.stock_negotiations
    FOR EACH ROW EXECUTE FUNCTION assistant.reject_stock_mandate_change();

CREATE TABLE assistant.stock_supplier_messages (
    id              uuid PRIMARY KEY,
    order_id        uuid REFERENCES assistant.stock_orders(id),
    direction       text NOT NULL CHECK (direction IN ('saliente','entrante')),
    body            text NOT NULL,
    relay_id        text UNIQUE,
    wamid           text,
    wa_id_hash      text,
    sent_at         timestamptz,
    blocked_reason  text,
    idempotency_key text,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.stock_relay_state (
    id         smallint PRIMARY KEY CHECK (id = 1),
    cursor     bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.stock_photos (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    user_id         text NOT NULL,
    request_id      uuid NOT NULL UNIQUE,
    status          text NOT NULL CHECK (status IN ('solicitada','entregada','lista','fallida','vencida')),
    concept         text NOT NULL CHECK (char_length(concept) BETWEEN 1 AND 80),
    label           text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
    parent_photo_id uuid REFERENCES assistant.stock_photos(id),
    object_original text,
    object_numerada text,
    sam             jsonb,
    total           integer CHECK (total >= 0),
    fuente          text,
    imagen_sha256   text CHECK (imagen_sha256 ~ '^[a-f0-9]{64}$'),
    error           text,
    device_id       uuid,
    idempotency_key text,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid
);
CREATE UNIQUE INDEX stock_photos_idem_uq ON assistant.stock_photos
    (business_id, idempotency_key, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    WHERE idempotency_key IS NOT NULL;

-- Solo inserción: un error se corrige con un movimiento nuevo (R3).
CREATE TABLE assistant.stock_movements (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    variant_id      uuid NOT NULL REFERENCES assistant.stock_variants(id),
    kind            text NOT NULL CHECK (kind IN ('entrada','venta','ajuste','devolucion')),
    delta           integer NOT NULL CHECK (delta <> 0),
    unit_cost       numeric(15,2) CHECK (unit_cost >= 0),
    currency        char(3) CHECK (currency ~ '^[A-Z]{3}$'),
    origin          text NOT NULL,
    cause           text CHECK (cause IN ('venta','fiado','movimiento','otra')),
    confirmation_id uuid NOT NULL REFERENCES assistant.stock_confirmations(id),
    proposal_id     uuid NOT NULL REFERENCES assistant.stock_proposals(id),
    order_id        uuid REFERENCES assistant.stock_orders(id),
    kit_variant_id  uuid REFERENCES assistant.stock_variants(id),
    trace_id        uuid NOT NULL,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid
);
CREATE INDEX stock_movements_variant_idx ON assistant.stock_movements(variant_id, occurred_at);
CREATE TRIGGER stock_movements_append_only
    BEFORE UPDATE OR DELETE ON assistant.stock_movements
    FOR EACH ROW EXECUTE FUNCTION assistant.reject_stock_mutation();

-- counted_at es conteo_en: el instante de la foto o de la frase, nunca el de la aprobación.
CREATE TABLE assistant.stock_counts (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    proposal_id     uuid NOT NULL REFERENCES assistant.stock_proposals(id),
    variant_id      uuid NOT NULL REFERENCES assistant.stock_variants(id),
    counted_at      timestamptz NOT NULL,
    expected        integer NOT NULL,
    counted         integer NOT NULL CHECK (counted >= 0),
    difference      integer NOT NULL,
    origin          text NOT NULL CHECK (origin IN ('foto','voz','canal')),
    photo_id        uuid REFERENCES assistant.stock_photos(id),
    cause           text CHECK (cause IN ('venta','fiado','movimiento','otra')),
    order_id        uuid REFERENCES assistant.stock_orders(id),
    confirmation_id uuid REFERENCES assistant.stock_confirmations(id),
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid
);
CREATE INDEX stock_counts_variant_idx ON assistant.stock_counts(variant_id, counted_at DESC);

CREATE TABLE assistant.stock_documents (
    id              uuid PRIMARY KEY,
    business_id     uuid NOT NULL,
    user_id         text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('factura','pantallazo')),
    content_type    text NOT NULL,
    object          text,
    sha256          text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    channel         text NOT NULL,
    status          text NOT NULL,
    extraction      jsonb,
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    simulated       boolean NOT NULL DEFAULT false,
    run_id          uuid
);
CREATE UNIQUE INDEX stock_documents_sha_uq ON assistant.stock_documents
    (business_id, sha256, (COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)));

CREATE TABLE assistant.stock_document_lines (
    id          uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES assistant.stock_documents(id),
    description text NOT NULL,
    quantity    integer CHECK (quantity >= 0),
    unit_cost   numeric(15,2) CHECK (unit_cost >= 0),
    doubtful    jsonb NOT NULL DEFAULT '[]'::jsonb,
    variant_id  uuid REFERENCES assistant.stock_variants(id)
);
CREATE INDEX stock_document_lines_document_idx ON assistant.stock_document_lines(document_id);

CREATE TABLE assistant.stock_rotation_baselines (
    variant_id  uuid NOT NULL REFERENCES assistant.stock_variants(id),
    computed_at timestamptz NOT NULL,
    weekly_rate numeric(12,4) NOT NULL CHECK (weekly_rate >= 0),
    weeks       integer NOT NULL CHECK (weeks >= 0),
    before_bet  boolean NOT NULL DEFAULT false,
    proposal_id uuid REFERENCES assistant.stock_proposals(id),
    PRIMARY KEY (variant_id, computed_at)
);

CREATE TABLE assistant.stock_autonomy (
    business_id uuid NOT NULL,
    area        text NOT NULL CHECK (area IN ('inventario','reposicion','negociacion','ofertas')),
    level       integer NOT NULL CHECK (level BETWEEN 1 AND 4),
    revision    integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, area)
);

CREATE TABLE assistant.stock_autonomy_requests (
    id          uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    area        text NOT NULL CHECK (area IN ('inventario','reposicion','negociacion','ofertas')),
    from_level  integer NOT NULL CHECK (from_level BETWEEN 1 AND 4),
    to_level    integer NOT NULL CHECK (to_level BETWEEN 1 AND 4),
    evidence    jsonb NOT NULL,
    proposal_id uuid REFERENCES assistant.stock_proposals(id),
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.stock_robot_events (
    id           bigserial PRIMARY KEY,
    business_id  uuid NOT NULL,
    user_id      text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('foto','recount','decir','limpiar')),
    payload      jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','entregado','recibido','hecho','descartado','vencido','para_canal','ignorada')),
    dedupe_key   text,
    dedupe_day   date,
    proposal_id  uuid REFERENCES assistant.stock_proposals(id),
    expires_at   timestamptz,
    delivered_at timestamptz,
    acked_at     timestamptz,
    recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_robot_events_dedupe_uq ON assistant.stock_robot_events (user_id, dedupe_key, dedupe_day)
    WHERE kind = 'decir';
CREATE INDEX stock_robot_events_pending_idx ON assistant.stock_robot_events(user_id, id) WHERE status = 'pendiente';

-- Solo op:events y op:state la escriben: un turno de voz con el hilo de eventos muerto no es robot en línea.
CREATE TABLE assistant.stock_device_presence (
    device_id      uuid PRIMARY KEY,
    user_id        text NOT NULL,
    device_state   text NOT NULL CHECK (device_state IN ('activo','dormido')),
    events_seen_at timestamptz NOT NULL
);

CREATE TABLE assistant.stock_usage (
    business_id uuid NOT NULL,
    day         date NOT NULL,
    metric      text NOT NULL,
    value       bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
    PRIMARY KEY (business_id, day, metric)
);

CREATE TABLE assistant.stock_run_budgets (
    run_id      uuid NOT NULL,
    metric      text NOT NULL,
    limit_value bigint NOT NULL CHECK (limit_value >= 0),
    used        bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
    PRIMARY KEY (run_id, metric)
);

CREATE TABLE assistant.stock_audit (
    id          uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    trace_id    uuid NOT NULL,
    actor       text NOT NULL,
    action      text NOT NULL,
    entity      text NOT NULL,
    entity_id   text NOT NULL,
    args_hash   text NOT NULL CHECK (args_hash ~ '^[a-f0-9]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_audit_trace_idx ON assistant.stock_audit(business_id, trace_id);
CREATE TRIGGER stock_audit_append_only
    BEFORE UPDATE OR DELETE ON assistant.stock_audit
    FOR EACH ROW EXECUTE FUNCTION assistant.reject_stock_mutation();

CREATE TABLE assistant.stock_clock_offsets (
    business_id    uuid PRIMARY KEY,
    offset_seconds bigint NOT NULL DEFAULT 0,
    updated_by     text NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.stock_clock_jumps (
    id          uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    from_ts     timestamptz NOT NULL,
    to_ts       timestamptz NOT NULL,
    run_id      uuid,
    actor       text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.stock_runs (
    id          uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    name        text NOT NULL,
    seed        text NOT NULL,
    status      text NOT NULL CHECK (status IN ('activo','cerrado')),
    started_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_runs_active_uq ON assistant.stock_runs(business_id) WHERE status = 'activo';

CREATE TABLE assistant.stock_sim_campaigns (
    id          uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    variant_id  uuid NOT NULL REFERENCES assistant.stock_variants(id),
    budget      numeric(15,2) NOT NULL CHECK (budget >= 0),
    signals     jsonb NOT NULL DEFAULT '{}'::jsonb,
    status      text NOT NULL,
    simulated   boolean NOT NULL DEFAULT true CHECK (simulated),
    run_id      uuid,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Grants explícitos (S-16): el callback de Flyway no está confirmado. Las tablas de libro y prueba son de solo
-- inserción también para el rol de runtime, y BIGSERIAL necesita su secuencia. V1 deja privilegios por defecto que
-- darían DML a toda tabla nueva: por eso el REVOKE, comprobado en Postgres real con el trabajo stock-postgres.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
        REVOKE ALL ON assistant.stock_movements, assistant.stock_confirmations, assistant.stock_audit FROM assistant;
        GRANT SELECT, INSERT ON assistant.stock_movements, assistant.stock_confirmations, assistant.stock_audit TO assistant;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            assistant.stock_enabled_businesses, assistant.stock_products, assistant.stock_variants,
            assistant.stock_variant_aliases, assistant.stock_kit_components, assistant.stock_proposals,
            assistant.stock_owner_utterances, assistant.stock_counts, assistant.stock_photos,
            assistant.stock_documents, assistant.stock_document_lines, assistant.stock_suppliers,
            assistant.stock_supplier_quotes, assistant.stock_orders, assistant.stock_negotiations,
            assistant.stock_supplier_messages, assistant.stock_relay_state, assistant.stock_rotation_baselines,
            assistant.stock_autonomy, assistant.stock_autonomy_requests, assistant.stock_robot_events,
            assistant.stock_device_presence, assistant.stock_usage, assistant.stock_run_budgets,
            assistant.stock_clock_offsets, assistant.stock_clock_jumps, assistant.stock_runs,
            assistant.stock_sim_campaigns
            TO assistant;
        GRANT USAGE, SELECT ON SEQUENCE assistant.stock_robot_events_id_seq TO assistant;
    END IF;
END $$;
