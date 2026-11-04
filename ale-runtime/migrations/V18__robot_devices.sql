-- Canal robot: un robot físico (Ale en una Raspberry) se empareja con el USUARIO, no con un negocio.
-- Solo se guardan hashes: ni el código de emparejamiento, ni el secreto de sondeo, ni la credencial del
-- dispositivo quedan en claro. La credencial se entrega una sola vez al robot que inició el emparejamiento.
CREATE TABLE assistant.robot_pairings (
 id uuid PRIMARY KEY,
 code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 poll_hash text NOT NULL CHECK(poll_hash ~ '^[a-f0-9]{64}$'),
 device_name text NOT NULL CHECK(char_length(device_name) BETWEEN 1 AND 60),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','delivered')),
 user_id text CHECK(user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
 device_id uuid,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status = 'pending') = (user_id IS NULL)),
 CHECK((status = 'delivered') = (device_id IS NOT NULL))
);
CREATE INDEX robot_pairings_expires_idx ON assistant.robot_pairings(expires_at);

CREATE TABLE assistant.robot_devices (
 id uuid PRIMARY KEY,
 user_id text NOT NULL CHECK(user_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX robot_devices_user_idx ON assistant.robot_devices(user_id) WHERE revoked_at IS NULL;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON assistant.robot_pairings, assistant.robot_devices TO assistant;
 END IF;
END $$;
