-- Give the run timestamps millisecond precision.
--
-- DATETIME with no fractional part does not truncate on insert, it ROUNDS: a run started at
-- 06:11:42.871 is stored as 06:11:43. Every duration was then computed against a start in its own
-- future, and a sync that finished inside a second produced a negative number that INT UNSIGNED
-- refused outright — failing the write that was trying to record the run, and leaving the row
-- stuck at 'running'.
--
-- DATETIME(3) keeps the milliseconds the code already sends, so start and finish are comparable
-- at the precision they were measured. MODIFY COLUMN restates the column's full definition rather
-- than patching it, which is also what makes re-running this file a no-op.
--
-- migrate:up

ALTER TABLE sync_runs
    MODIFY COLUMN started_at  DATETIME(3) NOT NULL,
    MODIFY COLUMN finished_at DATETIME(3) NULL;

-- migrate:down

ALTER TABLE sync_runs
    MODIFY COLUMN started_at  DATETIME NOT NULL,
    MODIFY COLUMN finished_at DATETIME NULL;
