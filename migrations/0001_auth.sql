-- Magic-link auth schema for the Neon-backed dashboard.
--
-- Run once via the Neon Console SQL editor, or:
--   psql "$NEON_PGURI" -f migrations/0001_auth.sql

CREATE TABLE IF NOT EXISTS members (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'viewer',   -- 'uploader' | 'viewer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-time magic-link tokens. Plaintext token is hashed (SHA-256) before
-- storage so a leaked DB snapshot doesn't reveal currently-active links.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL REFERENCES members(email) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_email   ON auth_tokens(email);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);
