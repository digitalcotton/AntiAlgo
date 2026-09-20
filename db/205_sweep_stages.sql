-- 205_sweep_stages.sql: the sweep's own stage clock, when it logs one.
--
-- WHY. The Desk's LAST NIGHT'S SWEEP panel is drawn as a timeline (a time per
-- line) and the sweep records one instant, swept_at. The site prints no clock
-- it did not measure, so the panel has shown the finish time alone. This column
-- holds the per-stage instants the nightly sweep writes into jobs.json _meta
-- .stages ({ "read": iso, "verify": iso, "kill": iso, "save": iso }), once it
-- does; scripts/ingest-jobs.mjs copies them here verbatim. NULL until the sweep
-- emits them, and the panel draws no time column while it is NULL.
--
-- ADDITIVE, RE-RUNNABLE, REVERSIBLE (ALTER TABLE board_stats DROP COLUMN stage_log).

ALTER TABLE board_stats ADD COLUMN IF NOT EXISTS stage_log JSONB;
