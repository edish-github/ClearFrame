-- Views the E&O report and the slate-level analytics read.
-- The report is a view over the ledger; nothing here stores anything twice.

-- Live findings only: a superseded finding never appears in a report.
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_findings_live` AS
SELECT * FROM `${BQ_DATASET}.findings`
WHERE superseded_by IS NULL;

-- Every claim with its citations, for section 3 and appendix A.
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_findings_detail` AS
SELECT
  f.project_id, f.item_id, f.finding_id, f.agent, f.confidence, f.claim,
  f.interaction_id, f.prev_interaction_id, f.tier, f.ts,
  ARRAY_AGG(STRUCT(c.url, c.title, c.authority, c.fetched_ts, c.published_date,
                   c.snapshot_uri, c.excerpt)) AS citations
FROM `${BQ_DATASET}.v_findings_live` f
LEFT JOIN `${BQ_DATASET}.citations` c USING (finding_id)
GROUP BY f.project_id, f.item_id, f.finding_id, f.agent, f.confidence, f.claim,
         f.interaction_id, f.prev_interaction_id, f.tier, f.ts;

-- The citation-required policy, as a query you can run rather than a claim you make.
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_uncited_findings` AS
SELECT f.project_id, f.finding_id, f.item_id, f.agent, f.ts
FROM `${BQ_DATASET}.v_findings_live` f
LEFT JOIN `${BQ_DATASET}.citations` c USING (finding_id)
WHERE c.citation_id IS NULL;

-- Cost by tier — §9.2's weekly check. If T3 exceeds ~5% of calls, tighten escalate().
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_cost_by_tier` AS
SELECT project_id, tier, COUNT(*) AS calls, SUM(cost_usd) AS usd,
       SAFE_DIVIDE(COUNT(*), SUM(COUNT(*)) OVER (PARTITION BY project_id)) AS share
FROM `${BQ_DATASET}.cost_events`
GROUP BY project_id, tier;

-- Who decided what, and on what grounds.
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_decision_log` AS
SELECT project_id, item_id, actor, iam_role, action, rationale, target_id, ts
FROM `${BQ_DATASET}.decisions`
ORDER BY ts;

-- The rights graph, with how many productions each counterparty has appeared in.
CREATE OR REPLACE VIEW `${BQ_DATASET}.v_rights_graph` AS
SELECT h.holder_id, h.name, h.kind, h.parent_id, h.watch_id, h.last_verified,
       ARRAY_LENGTH(h.source_urls) AS sources
FROM `${BQ_DATASET}.rights_holders` h;
