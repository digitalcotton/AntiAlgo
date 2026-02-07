-- ─────────────────────────────────────────────────────────
-- Predictions table for Curiosity Intel
-- Tracks weekly predictions and their grades for accountability
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS predictions (
    id              BIGSERIAL PRIMARY KEY,
    week            TEXT NOT NULL,                    -- "2026-W06"
    issue_number    INT,
    prediction_text TEXT NOT NULL,
    confidence      TEXT DEFAULT 'medium',            -- low | medium | high
    grade           TEXT,                             -- hit | miss | too_early | null (ungraded)
    grade_explanation TEXT,                           -- "We called it — agent frameworks dominated"
    graded_in_week  TEXT,                             -- which week we graded this prediction
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    graded_at       TIMESTAMPTZ
);

-- Index for quick lookups: "get latest ungraded prediction"
CREATE INDEX IF NOT EXISTS idx_predictions_week ON predictions(week);
CREATE INDEX IF NOT EXISTS idx_predictions_ungraded ON predictions(grade) WHERE grade IS NULL;

-- ─────────────────────────────────────────────────────────
-- Example usage:
--
-- INSERT: after newsletter publishes
--   INSERT INTO predictions (week, issue_number, prediction_text, confidence)
--   VALUES ('2026-W06', 1, 'Agent frameworks will dominate next week...', 'high');
--
-- GRADE: next week's editorial layer grades it
--   UPDATE predictions SET grade = 'hit', 
--     grade_explanation = 'Correct — agent questions rose 45%',
--     graded_in_week = '2026-W07', graded_at = NOW()
--   WHERE week = '2026-W06' AND grade IS NULL;
--
-- FETCH latest for newsletter:
--   SELECT * FROM predictions 
--   WHERE week = '2026-W06' 
--   ORDER BY created_at DESC LIMIT 1;
-- ─────────────────────────────────────────────────────────
