-- The catalogue sync's own history — one row per run, so "did today's sync work" is a query
-- rather than a scroll through container logs that a restart has already discarded.
--
-- The counters are written as the run progresses, not once at the end. A run that dies halfway
-- leaves its row saying how far it got, which is the difference between "the sync failed" and
-- "the sync fetched 194 products, wrote them to MySQL, and died indexing".
--
-- migrate:up

CREATE TABLE IF NOT EXISTS sync_runs (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- The day the run belongs to, denormalised out of started_at so a daily lookup is an index
    -- seek rather than a function call on every row.
    run_date            DATE            NOT NULL,
    -- VARCHAR rather than ENUM for both of these: the allowed values live in
    -- models/db/syncRun.model.ts, and adding a trigger source should be a code change, not a
    -- migration that rewrites the table.
    trigger_source      VARCHAR(16)     NOT NULL,
    status              VARCHAR(16)     NOT NULL,
    -- How far the run got. Meaningful while status is 'running', and kept afterwards because on
    -- a failure it is the first thing anyone wants to know.
    stage               VARCHAR(32)     NOT NULL,
    started_at          DATETIME        NOT NULL,
    finished_at         DATETIME        NULL,
    duration_ms         INT UNSIGNED    NULL,
    products_fetched    INT UNSIGNED    NOT NULL DEFAULT 0,
    categories_upserted INT UNSIGNED    NOT NULL DEFAULT 0,
    tags_upserted       INT UNSIGNED    NOT NULL DEFAULT 0,
    products_upserted   INT UNSIGNED    NOT NULL DEFAULT 0,
    products_indexed    INT UNSIGNED    NOT NULL DEFAULT 0,
    categories_indexed  INT UNSIGNED    NOT NULL DEFAULT 0,
    -- The failure message, not a stack: this is read by a human asking what went wrong.
    error               TEXT            NULL,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- The daily question — "did a run succeed on this date" — answered from the index alone.
    KEY idx_sync_runs_date_status (run_date, status),
    -- The listing's default order.
    KEY idx_sync_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

DROP TABLE IF EXISTS sync_runs;
