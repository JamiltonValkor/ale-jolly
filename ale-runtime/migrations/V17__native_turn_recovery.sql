-- Transport recovery metadata only. Native Hermes remains execution authority.
ALTER TABLE assistant.first_loop_turns
 ADD COLUMN first_dispatch_at timestamptz,
 ADD COLUMN native_scope_hash text CHECK(native_scope_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN native_text_sha256 text CHECK(native_text_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN native_body_sha256 text CHECK(native_body_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN native_fingerprint text CHECK(native_fingerprint ~ '^[a-f0-9]{64}$'),
 ADD COLUMN native_observed_at timestamptz,
 ADD COLUMN native_terminal_status text CHECK(native_terminal_status IN ('completed','failed','cancelled','interrupted'));

-- Older attempts have no trustworthy first-send timestamp. Anchor conservatively
-- to their original row creation; never grant them a fresh retry horizon.
UPDATE assistant.first_loop_turns SET first_dispatch_at=created_at WHERE dispatch_attempts>0;
