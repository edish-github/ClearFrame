-- The rights-holder graph. Compounds across productions: the tenth picture
-- clears faster than the first because the counterparties are already known.

CREATE TABLE IF NOT EXISTS `${BQ_DATASET}.rights_holders` (
  holder_id     STRING NOT NULL,
  name          STRING NOT NULL,
  kind          STRING,          -- publisher|label|estate|trademark_owner|archive|artist
  parent_id     STRING,          -- corporate parent, discovered by FindAll
  aliases       ARRAY<STRING>,
  contacts      JSON,            -- only contacts a cited source carried
  watch_id      STRING,          -- the armed Parallel monitor
  source_urls   ARRAY<STRING>,
  first_seen    TIMESTAMP,
  last_verified TIMESTAMP
)
CLUSTER BY name;
