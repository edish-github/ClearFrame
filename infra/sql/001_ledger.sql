-- ClearFrame ledger: append-only and hash-chained.
-- Run once per environment:  bq query --use_legacy_sql=false < infra/sql/001_ledger.sql
-- Substitute ${BQ_DATASET} before running (infra/scripts/bootstrap.sh does this).

CREATE SCHEMA IF NOT EXISTS `${BQ_DATASET}`
OPTIONS (description = "ClearFrame clearance ledger. Append-only. No UPDATE, no DELETE.");

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.ledger_events` (
  seq        INT64     NOT NULL,
  ts         TIMESTAMP NOT NULL,
  actor      STRING    NOT NULL,   -- agent role or human principal
  event      JSON      NOT NULL,   -- finding.added | challenge.filed | decision.made | ...
  prev_hash  STRING,               -- base64(sha256) of the previous event
  event_hash STRING    NOT NULL,   -- base64(sha256(prev_hash || canonical(event)))
  project_id STRING    NOT NULL
)
PARTITION BY DATE(ts)
CLUSTER BY project_id, seq
OPTIONS (description = "The spine of auditability. Sequence is allocated transactionally "
                       "in Firestore, never by reading this table back.");

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.cost_events` (
  project_id STRING, pass_id STRING, item_id STRING,
  tier       INT64,  cost_usd FLOAT64, surface STRING,
  ts         TIMESTAMP
)
PARTITION BY DATE(ts)
CLUSTER BY project_id, tier
OPTIONS (description = "Every billable tool call, so the tier policy can be audited "
                       "against real spend.");
