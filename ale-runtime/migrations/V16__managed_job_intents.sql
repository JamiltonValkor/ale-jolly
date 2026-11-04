-- Managed-only native cron admission receipts; no native scheduler/DDL at startup.
CREATE TABLE assistant.managed_job_intents (
 owner_id text NOT NULL, business_id uuid NOT NULL, instance_generation text NOT NULL,
 base_name text NOT NULL, job_name text NOT NULL, session_id text NOT NULL,
 desired_hash text NOT NULL CHECK(desired_hash ~ '^[a-f0-9]{64}$'),
 original_schedule text NOT NULL, native_job_id text CHECK(native_job_id ~ '^[a-f0-9]{12}$'),
 legacy_job_id text CHECK(legacy_job_id ~ '^[a-f0-9]{12}$'), legacy_hash text,
 create_attempted boolean NOT NULL DEFAULT false,
 legacy_pause_attempted boolean NOT NULL DEFAULT false,
 legacy_paused boolean NOT NULL DEFAULT false,
 phase text NOT NULL DEFAULT 'prepared'
   CHECK(phase IN ('prepared','creating','created_paused','binding','active','preserved','missing','conflict')),
 reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,business_id,instance_generation,base_name),
 UNIQUE(owner_id,instance_generation,job_name)
);
