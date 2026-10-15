-- 049_auth_v1.sql — Authentication v1 (SPEC §25, patch docs/claude_spec-patch-auth-v1.md)
--
-- Replace, do not extend, the Replit-era users table. The old table was never
-- read by the running server (the April strip left it orphaned), so there is
-- nothing to migrate: no row in it is a login anyone uses.
--
-- The first account is created by `tsx script/create-admin.ts`, never by a
-- default row here. No default password anywhere.

DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,           -- login identifier; lowercase enforced in code
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,                  -- bcrypt, cost 12
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin','member')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = disabled; cannot log in; sessions revoked
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,                    -- NULL = not locked
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- connect-pg-simple store shape. Expired rows are pruned by the store's own
-- sweeper; nothing else reads or writes this table.
CREATE TABLE sessions (
  sid     TEXT PRIMARY KEY,
  sess    JSONB NOT NULL,
  expire  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions (expire);
