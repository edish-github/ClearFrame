-- Findings, citations, and risk assessments.

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.findings` (
  finding_id          STRING NOT NULL,
  item_id             STRING NOT NULL,
  project_id          STRING NOT NULL,
  pass_id             STRING,
  agent               STRING,
  claim               JSON,
  confidence          FLOAT64,
  interaction_id      STRING,     -- Parallel run id
  prev_interaction_id STRING,     -- provenance chain: challenge re-runs and reopens
  superseded_by       STRING,     -- set when a challenge replaces a finding
  tier                INT64,
  cost_usd            FLOAT64,
  ts                  TIMESTAMP
)
PARTITION BY DATE(ts)
CLUSTER BY project_id, item_id;

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.citations` (
  citation_id    STRING NOT NULL,
  finding_id     STRING NOT NULL,
  project_id     STRING,
  url            STRING,
  title          STRING,
  excerpt        STRING,
  snapshot_uri   STRING,     -- GCS copy, so evidence survives link rot
  fetched_ts     TIMESTAMP,
  published_date STRING,
  authority      STRING,     -- registry|court|corporate|trade|reference|other
  field          STRING      -- which output field this citation supports
)
CLUSTER BY project_id, finding_id;

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.assessments` (
  assessment_id    STRING NOT NULL,
  item_id          STRING NOT NULL,
  project_id       STRING NOT NULL,
  pass_id          STRING,
  risk_state       STRING,          -- green | amber | red
  rationale        STRING,
  grounding_refs   ARRAY<STRING>,   -- handbook passages relied on
  mitigations      JSON,
  requires_approval BOOL,
  agent            STRING,
  ts               TIMESTAMP
)
PARTITION BY DATE(ts)
CLUSTER BY project_id, item_id;

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.decisions` (
  decision_id STRING NOT NULL,
  project_id  STRING NOT NULL,
  item_id     STRING,
  actor       STRING NOT NULL,   -- a human principal, always
  iam_role    STRING NOT NULL,
  action      STRING NOT NULL,
  rationale   STRING NOT NULL,
  target_id   STRING,
  ts          TIMESTAMP
)
PARTITION BY DATE(ts)
CLUSTER BY project_id;
