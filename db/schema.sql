-- =====================================================================
-- BC Dashboard — Supabase schema
-- =====================================================================
-- Run this once in your Supabase project (SQL Editor → New query → paste → run).
-- Re-running is safe; tables and policies use IF NOT EXISTS / DROP-IF-EXISTS.
-- =====================================================================

-- Members table: who can sign in, and what they can do.
-- email is the unique identifier; role is one of 'uploader' or 'viewer'.
CREATE TABLE IF NOT EXISTS public.members (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('uploader','viewer')),
  added_at   TIMESTAMPTZ DEFAULT now()
);

-- Account name lookup (corporate clients). Kept separate so it's easy to drop
-- if you later decide to anonymise account names too.
CREATE TABLE IF NOT EXISTS public.account_names (
  account_no  INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Income Structure: one row per uploaded file, payload is the parsed sections.
CREATE TABLE IF NOT EXISTS public.income_files (
  id           BIGSERIAL PRIMARY KEY,
  file_hash    TEXT UNIQUE NOT NULL,            -- SHA-256 hex of bytes
  source_name  TEXT NOT NULL,
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  sections     JSONB NOT NULL,                  -- entire parseIncome().sections
  kpis         JSONB NOT NULL,                  -- parseIncome().kpis convenience
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS income_files_period_idx
  ON public.income_files (period_from, period_to);

-- Hour Statistics: one row per uploaded file, weekly bundle of 168 hourly points.
CREATE TABLE IF NOT EXISTS public.hours_files (
  id           BIGSERIAL PRIMARY KEY,
  file_hash    TEXT UNIQUE NOT NULL,
  source_name  TEXT NOT NULL,
  period       TEXT NOT NULL,                   -- "DD/MM/YYYY - DD/MM/YYYY"
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  timestamps   TEXT[] NOT NULL,                 -- "YYYY-MM-DDTHH:00" local
  hourly       JSONB NOT NULL,                  -- {online:[...], doing_job:[...], ...}
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hours_files_period_idx
  ON public.hours_files (period_start, period_end);

-- Job Analogue: file-level metadata + rows split out for date-range queries.
CREATE TABLE IF NOT EXISTS public.job_files (
  id           BIGSERIAL PRIMARY KEY,
  file_hash    TEXT UNIQUE NOT NULL,
  source_name  TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  row_count    INTEGER NOT NULL,
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT now()
);

-- Anonymised job rows. PII never reaches this table:
--   * passenger name/email/phone -> dropped
--   * phone -> SHA-256 hash (kept so retail unique counts + top-25 still work)
--   * driver name/email/phone -> dropped
--   * vehicle reg -> SHA-256 hash
--   * pickup/dropoff text -> reduced to two booleans (is_otp_pickup/dropoff)
--   * cancel reason -> reduced to is_no_supply_cancel boolean
CREATE TABLE IF NOT EXISTS public.job_rows (
  id                     BIGSERIAL PRIMARY KEY,
  file_id                BIGINT REFERENCES public.job_files(id) ON DELETE CASCADE,
  date                   DATE NOT NULL,
  account_no             INTEGER,
  phone_hash             TEXT,
  urgency                TEXT,
  status                 TEXT,
  service                TEXT,
  hour                   INTEGER,
  total                  NUMERIC,
  driver_total           NUMERIC,
  response_min           NUMERIC,
  vehicle_hash           TEXT,
  is_otp_pickup          BOOLEAN,
  is_otp_dropoff         BOOLEAN,
  is_no_supply_cancel    BOOLEAN
);
CREATE INDEX IF NOT EXISTS job_rows_date_idx       ON public.job_rows (date);
CREATE INDEX IF NOT EXISTS job_rows_account_idx    ON public.job_rows (account_no);
CREATE INDEX IF NOT EXISTS job_rows_status_idx     ON public.job_rows (status);

-- Registrations: file metadata + per-row created_at + status.
CREATE TABLE IF NOT EXISTS public.reg_files (
  id           BIGSERIAL PRIMARY KEY,
  file_hash    TEXT UNIQUE NOT NULL,
  source_name  TEXT NOT NULL,
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.reg_rows (
  id          BIGSERIAL PRIMARY KEY,
  file_id     BIGINT REFERENCES public.reg_files(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL,
  status      TEXT,
  email_hash  TEXT  -- so unique-user counts work without storing emails
);
CREATE INDEX IF NOT EXISTS reg_rows_created_idx ON public.reg_rows (created_at);

-- =====================================================================
-- Row-Level Security: everything off unless you're in the members table.
-- =====================================================================

-- Helper: am I a member?
CREATE OR REPLACE FUNCTION public.is_member()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.members WHERE email = auth.email()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_uploader()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.members
    WHERE email = auth.email() AND role = 'uploader'
  );
$$;

-- Enable RLS on every table.
ALTER TABLE public.members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_names   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.income_files    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hours_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_files       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_rows        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reg_files       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reg_rows        ENABLE ROW LEVEL SECURITY;

-- Members: you can read your own row (to know your role). Writes through SQL editor only.
DROP POLICY IF EXISTS "members read own"     ON public.members;
CREATE POLICY "members read own" ON public.members
  FOR SELECT USING (email = auth.email());

-- Account names: any member can read; only uploaders can write.
DROP POLICY IF EXISTS "account_names read" ON public.account_names;
DROP POLICY IF EXISTS "account_names write"ON public.account_names;
CREATE POLICY "account_names read"  ON public.account_names FOR SELECT USING (public.is_member());
CREATE POLICY "account_names write" ON public.account_names FOR ALL    USING (public.is_uploader()) WITH CHECK (public.is_uploader());

-- Same pattern for every data table.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['income_files','hours_files','job_files','job_rows','reg_files','reg_rows']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s read"  ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s write" ON public.%I;', t, t);
    EXECUTE format('CREATE POLICY "%s read"  ON public.%I FOR SELECT USING (public.is_member());', t, t);
    EXECUTE format('CREATE POLICY "%s write" ON public.%I FOR ALL    USING (public.is_uploader()) WITH CHECK (public.is_uploader());', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- Done.
-- After running this:
--   1. Add yourself: INSERT INTO public.members (email, role) VALUES ('you@example.com', 'uploader');
--   2. Add colleagues:
--      INSERT INTO public.members (email, role) VALUES
--        ('alice@example.com','uploader'),
--        ('bob@example.com','viewer'),
--        ('carol@example.com','viewer');
--   3. In Supabase Dashboard → Authentication → URL Configuration: add your
--      production URL (e.g. https://bc-dashboard.vercel.app) and any preview
--      URLs to Site URL / Redirect URLs.
-- =====================================================================
