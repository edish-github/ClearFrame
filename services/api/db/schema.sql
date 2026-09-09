-- ClearFrame schema.
-- Money is stored in integer micro-dollars. Never floats.
-- The ledger is append-only and hash chained; nothing in it is ever updated.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity

CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('producer', 'coordinator', 'counsel', 'reviewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'producer',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- ------------------------------------------------------------- productions

DO $$ BEGIN
  CREATE TYPE production_status AS ENUM
    ('draft', 'breakdown', 'running', 'review', 'complete', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS productions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title            text NOT NULL,
  format           text NOT NULL DEFAULT 'Feature film',
  status           production_status NOT NULL DEFAULT 'draft',
  budget_cap_micros bigint NOT NULL,
  spent_micros     bigint NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users(id),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS productions_org_idx ON productions (org_id, updated_at DESC);

-- One row per uploaded screenplay. Pass n = cuts.n.
CREATE TABLE IF NOT EXISTS cuts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  n             int NOT NULL,
  filename      text NOT NULL,
  storage_key   text NOT NULL,
  mime_type     text NOT NULL,
  content_hash  text NOT NULL,
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_id, n)
);

-- ---------------------------------------------------------------- findings

DO $$ BEGIN
  CREATE TYPE finding_status AS ENUM (
    'queued', 'researching', 'verifying', 'tracing', 'assessing',
    'review', 'cleared', 'approved', 'licensed', 'replaced', 'rejected',
    'withdrawn', 'held', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_level AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS findings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id  uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  first_cut_id   uuid REFERENCES cuts(id),
  pass_n         int NOT NULL DEFAULT 1,
  item           text NOT NULL,
  category       text NOT NULL,
  scene          text,
  page           text,
  context        text NOT NULL DEFAULT '',
  -- identity across cuts: category + normalised item name
  item_key       text NOT NULL,
  -- changes when the element's placement or description moves
  content_hash   text NOT NULL,
  status         finding_status NOT NULL DEFAULT 'queued',
  risk           risk_level,
  confidence     numeric(4,3),
  summary        text,
  assessment     text,
  recommendation text,
  verification   jsonb,
  chains         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier           text,
  parallel_run_id text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_id, item_key)
);
CREATE INDEX IF NOT EXISTS findings_prod_idx ON findings (production_id, status);

-- Retry checkpoint. A job that dies mid-pipeline resumes at the next unfinished
-- stage instead of re-buying research it already paid for.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS stages_done text[] NOT NULL DEFAULT '{}';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS research_sources jsonb;

CREATE TABLE IF NOT EXISTS evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id   uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  url          text NOT NULL,
  title        text,
  domain       text NOT NULL,
  stance       text NOT NULL CHECK (stance IN ('supports', 'conflicts', 'context')),
  note         text NOT NULL DEFAULT '',
  publish_date date,
  -- excerpt captured at retrieval time so the report survives link rot
  snapshot_key text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  round        int NOT NULL DEFAULT 1,
  UNIQUE (finding_id, url)
);
CREATE INDEX IF NOT EXISTS evidence_finding_idx ON evidence (finding_id, retrieved_at);

CREATE TABLE IF NOT EXISTS decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id  uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('approved','licensed','replaced','rejected')),
  rationale   text NOT NULL DEFAULT '',
  actor_id    uuid REFERENCES users(id),
  actor_name  text NOT NULL,
  actor_role  user_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id   uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE UNIQUE,
  addressed_to text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  state        text NOT NULL DEFAULT 'draft' CHECK (state IN ('drafting','draft','approved','failed')),
  approved_by  uuid REFERENCES users(id),
  approved_name text,
  approved_at  timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id            bigserial PRIMARY KEY,
  production_id uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  finding_id    uuid REFERENCES findings(id) ON DELETE CASCADE,
  stage         text NOT NULL,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_prod_idx ON activity (production_id, id DESC);

-- ------------------------------------------------------------------ ledger
-- Append only. No UPDATE, no DELETE. seq is allocated under an advisory lock
-- so the hash chain can never fork.

CREATE TABLE IF NOT EXISTS ledger (
  production_id uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  event         jsonb NOT NULL,
  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  PRIMARY KEY (production_id, seq)
);

-- The ledger is append-only. UPDATE is never permitted. DELETE is permitted
-- only inside a transaction that has explicitly opted in, which is how a
-- data-retention purge of a whole production is carried out deliberately
-- rather than by an accidental cascade.
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('clearframe.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger is append-only (set clearframe.allow_purge to purge)';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_no_mutate ON ledger;
CREATE TRIGGER ledger_no_mutate
  BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- ------------------------------------------------------------------- money

CREATE TABLE IF NOT EXISTS cost_events (
  id            bigserial PRIMARY KEY,
  production_id uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  finding_id    uuid REFERENCES findings(id) ON DELETE SET NULL,
  stage         text NOT NULL,
  provider      text NOT NULL,
  detail        text,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  units         int NOT NULL DEFAULT 0,
  cost_micros   bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_prod_idx ON cost_events (production_id);

-- -------------------------------------------------------------------- jobs
-- Durable queue. Claimed with FOR UPDATE SKIP LOCKED so a pass survives a
-- worker dying, a deploy, or a closed laptop.

CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id uuid REFERENCES productions(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state         text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','running','done','failed')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (state, run_at) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS jobs_prod_idx ON jobs (production_id, state);

-- ---------------------------------------------------------------- watching

CREATE TABLE IF NOT EXISTS watches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE UNIQUE,
  provider        text NOT NULL DEFAULT 'internal',
  provider_watch_id text,
  state           text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  last_checked_at timestamptz,
  next_check_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watches_due_idx ON watches (next_check_at) WHERE state = 'active';

-- ----------------------------------------------------------------- reports

CREATE TABLE IF NOT EXISTS reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_id uuid NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  storage_key   text,
  ledger_head   text NOT NULL,
  ledger_length int NOT NULL,
  snapshot      jsonb NOT NULL,
  signed_by     uuid REFERENCES users(id),
  signed_name   text,
  signed_role   user_role,
  signed_at     timestamptz,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_prod_idx ON reports (production_id, generated_at DESC);
