-- Run manually with the schema-owner connection; never from an HTTP request.
BEGIN;
CREATE SCHEMA IF NOT EXISTS cashbook;
REVOKE ALL ON SCHEMA cashbook FROM PUBLIC;
CREATE TABLE IF NOT EXISTS cashbook.control (
  id smallint PRIMARY KEY CHECK (id=1),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  payload json NOT NULL CHECK (json_typeof(payload)='object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  CHECK ((payload->>'revision')::bigint=revision)
);
CREATE TABLE IF NOT EXISTS cashbook.transactions (
  department_id uuid NOT NULL, id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  payload json NOT NULL CHECK (json_typeof(payload)='object'),
  PRIMARY KEY (department_id,id,version,hash),
  CHECK ((payload->>'id')::uuid=id AND (payload->>'departmentId')::uuid=department_id AND (payload->>'version')::bigint=version)
);
CREATE TABLE IF NOT EXISTS cashbook.snapshots (
  revision bigint PRIMARY KEY, payload json NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cashbook.sessions (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  payload json NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cashbook_session_expiry ON cashbook.sessions (expires_at);
CREATE TABLE IF NOT EXISTS cashbook.backups (
  id uuid PRIMARY KEY, contents text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA cashbook FROM PUBLIC;
COMMIT;
