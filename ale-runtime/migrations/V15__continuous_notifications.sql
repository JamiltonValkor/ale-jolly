-- Additive delivery ledger; native Hermes remains execution authority.
CREATE TABLE assistant.scheduled_job_bindings (
 owner_id text NOT NULL, job_id text NOT NULL, business_id uuid NOT NULL,
 session_id text NOT NULL, response_locale text NOT NULL, locale_revision integer NOT NULL CHECK(locale_revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,job_id)
);
CREATE TABLE assistant.notifications (
 id text PRIMARY KEY, cursor bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 owner_id text NOT NULL, business_id uuid NOT NULL, session_id text NOT NULL,
 source_id text NOT NULL, execution_id text NOT NULL, source_version text NOT NULL,
 payload_enc bytea NOT NULL, payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, saleads_delivered_at timestamptz,
 home_state text CHECK(home_state IN ('accepted','delivered','failed','unknown')),
 reconcile_by timestamptz,
 UNIQUE(owner_id,business_id,source_id,execution_id,source_version)
);
CREATE INDEX notifications_conversation ON assistant.notifications(owner_id,business_id,session_id,cursor);
CREATE TABLE assistant.notification_receipts (
 owner_id text NOT NULL, notification_id text NOT NULL, attempt_id text NOT NULL,
 destination text NOT NULL CHECK(destination IN ('home','saleads')),
 state text NOT NULL CHECK(state IN ('accepted','delivered','failed','unknown')),
 payload_enc bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,notification_id,attempt_id)
);
