-- First-loop control metadata; native Hermes/Kanban remains the execution authority.
-- Owner/business references are logical, never physical foreign keys across services.
CREATE TABLE assistant.first_loop_flows (
 id uuid PRIMARY KEY, user_id text NOT NULL, business_id uuid NOT NULL, session_id text NOT NULL,
 response_locale text NOT NULL CHECK(response_locale IN ('es','en')),
 brief_revision integer NOT NULL DEFAULT 0, brief_enc bytea, missing_fields jsonb NOT NULL DEFAULT '["goal"]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,business_id), UNIQUE(user_id,session_id)
);
CREATE TABLE assistant.first_loop_works (
 id uuid PRIMARY KEY, user_id text NOT NULL, business_id uuid NOT NULL, flow_id uuid NOT NULL,
 brief_revision integer NOT NULL, brief_enc bytea NOT NULL, revision integer NOT NULL DEFAULT 1,
 response_locale text NOT NULL CHECK(response_locale IN ('es','en')), feedback_count integer NOT NULL DEFAULT 0,
 projection_enc bytea, projection_generation text, observed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(flow_id,brief_revision)
);
CREATE TABLE assistant.first_loop_turns (
 id uuid PRIMARY KEY, flow_id uuid NOT NULL, user_id text NOT NULL, business_id uuid NOT NULL,
 client_message_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('message','kickoff','feedback')),
 request_hash text NOT NULL, payload_enc bytea NOT NULL, work_id uuid,
 dispatch_attempts integer NOT NULL DEFAULT 0, retry_after timestamptz,
 run_id text, status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','running','completed','failed','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(flow_id,client_message_id)
);
CREATE TABLE assistant.first_loop_receipts (
 user_id text NOT NULL, flow_id uuid NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
 request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,flow_id,operation,idempotency_key)
);
CREATE INDEX first_loop_turns_pending ON assistant.first_loop_turns(flow_id,created_at);
CREATE INDEX first_loop_works_owner ON assistant.first_loop_works(user_id,business_id,created_at DESC);
