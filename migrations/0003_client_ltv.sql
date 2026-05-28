-- Client Lifetime Value (LTV) for retail (Public account 110000) registered
-- clients. Earnings = total_price - driver_total_price on DONE rides.
--
-- Match strategy: phone primary (last 9 digits, country-code-agnostic),
-- email fallback when phone-matching isn't possible on one side.
-- Hashed identifiers stored for privacy in API responses.
--
-- Run once via the Neon SQL editor, or:
--   psql "$NEON_PGURI" -f migrations/0003_client_ltv.sql

CREATE TABLE IF NOT EXISTS client_ltv (
  client_id        TEXT PRIMARY KEY,
  email_hash       TEXT,
  phone_hash       TEXT,
  -- registration meta
  registered_at    TIMESTAMPTZ NOT NULL,
  reg_status       TEXT,
  reg_origin       TEXT,
  -- cohort LTV windows (earnings within N days post-registration)
  ltv_30d          NUMERIC NOT NULL DEFAULT 0,
  rides_30d        INT     NOT NULL DEFAULT 0,
  ltv_90d          NUMERIC NOT NULL DEFAULT 0,
  rides_90d        INT     NOT NULL DEFAULT 0,
  ltv_180d         NUMERIC NOT NULL DEFAULT 0,
  rides_180d       INT     NOT NULL DEFAULT 0,
  -- maturity flags — false when registered_at + N days is in the future
  -- so we don't pollute cohort averages with under-aged samples.
  mature_30d       BOOLEAN NOT NULL,
  mature_90d       BOOLEAN NOT NULL,
  mature_180d      BOOLEAN NOT NULL,
  -- all-time aggregates for context
  first_ride_at    DATE,
  last_ride_at     DATE,
  total_rides_all  INT     NOT NULL DEFAULT 0,
  total_earn_all   NUMERIC NOT NULL DEFAULT 0,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_ltv_reg_date ON client_ltv (registered_at);
CREATE INDEX IF NOT EXISTS idx_client_ltv_180d     ON client_ltv (ltv_180d DESC);
CREATE INDEX IF NOT EXISTS idx_client_ltv_90d      ON client_ltv (ltv_90d DESC);
CREATE INDEX IF NOT EXISTS idx_client_ltv_30d      ON client_ltv (ltv_30d DESC);
CREATE INDEX IF NOT EXISTS idx_client_ltv_origin   ON client_ltv (reg_origin);
