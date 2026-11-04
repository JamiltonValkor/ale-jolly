-- Current owner language is a durable product preference, separate from historical work snapshots.
-- No cross-service physical foreign key; the authenticated BFF synchronizes Subscription's value.
CREATE TABLE assistant.user_language_preferences (
 user_id text PRIMARY KEY,
 response_locale text NOT NULL CHECK(response_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(response_locale)<=35),
 locale_revision integer NOT NULL DEFAULT 1 CHECK(locale_revision>0),
 source_updated_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assistant.first_loop_flows DROP CONSTRAINT first_loop_flows_response_locale_check;
ALTER TABLE assistant.first_loop_flows ADD CONSTRAINT first_loop_flows_response_locale_check
 CHECK(response_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(response_locale)<=35);
ALTER TABLE assistant.first_loop_works DROP CONSTRAINT first_loop_works_response_locale_check;
ALTER TABLE assistant.first_loop_works ADD CONSTRAINT first_loop_works_response_locale_check
 CHECK(response_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(response_locale)<=35);
