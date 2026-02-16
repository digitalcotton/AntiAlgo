-- ─────────────────────────────────────────────────────────
-- Migration: Add subscribers table + ensure predictions table
-- Curiosity Intel — Newsletter subscription & referral system
-- ─────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════
-- SUBSCRIBERS TABLE
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscribers (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT REFERENCES tenants(id) DEFAULT 1,

    -- Identity
    email               TEXT NOT NULL,
    name                TEXT,

    -- Status: pending_confirmation → active → unsubscribed | bounced
    status              TEXT NOT NULL DEFAULT 'pending_confirmation'
                        CHECK (status IN ('pending_confirmation', 'active', 'unsubscribed', 'bounced')),

    -- Double opt-in
    confirmation_token  TEXT UNIQUE,
    confirmed_at        TIMESTAMPTZ,

    -- Unsubscribe
    unsubscribe_token   TEXT UNIQUE,

    -- Referral system
    referral_code       TEXT UNIQUE,           -- this subscriber's unique code
    referred_by         TEXT,                  -- referral_code of who referred them
    referral_count      INT NOT NULL DEFAULT 0, -- how many people they've referred

    -- Tracking
    source              TEXT DEFAULT 'website', -- website | api | import | share
    subscribed_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    -- Unique email per tenant
    UNIQUE(email, tenant_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subscribers_referral_code ON subscribers(referral_code);
CREATE INDEX IF NOT EXISTS idx_subscribers_referred_by ON subscribers(referred_by);
CREATE INDEX IF NOT EXISTS idx_subscribers_confirmation_token ON subscribers(confirmation_token);
CREATE INDEX IF NOT EXISTS idx_subscribers_unsubscribe_token ON subscribers(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_subscribers_tenant ON subscribers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_subscribed_at ON subscribers(subscribed_at);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_subscribers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscribers_updated_at ON subscribers;
CREATE TRIGGER trg_subscribers_updated_at
    BEFORE UPDATE ON subscribers
    FOR EACH ROW
    EXECUTE FUNCTION update_subscribers_updated_at();

-- Row Level Security
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "service_role_all" ON subscribers
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- ═══════════════════════════════════════════════════════
-- PREDICTIONS TABLE (idempotent — may already exist)
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS predictions (
    id              BIGSERIAL PRIMARY KEY,
    week            TEXT NOT NULL,                    -- "2026-W06"
    issue_number    INT,
    prediction_text TEXT NOT NULL,
    confidence      TEXT DEFAULT 'medium',            -- low | medium | high
    grade           TEXT,                             -- hit | miss | too_early | null (ungraded)
    grade_explanation TEXT,
    graded_in_week  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    graded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_predictions_week ON predictions(week);
CREATE INDEX IF NOT EXISTS idx_predictions_ungraded ON predictions(grade) WHERE grade IS NULL;

-- ═══════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════

-- Get active subscriber count (for social proof endpoint)
CREATE OR REPLACE FUNCTION get_subscriber_count(p_tenant_id BIGINT DEFAULT 1)
RETURNS BIGINT AS $$
    SELECT COUNT(*) FROM subscribers
    WHERE tenant_id = p_tenant_id
    AND status = 'active';
$$ LANGUAGE sql STABLE;

-- Increment referral count when someone confirms via a referral
CREATE OR REPLACE FUNCTION increment_referral_count(p_referral_code TEXT)
RETURNS VOID AS $$
    UPDATE subscribers
    SET referral_count = referral_count + 1
    WHERE referral_code = p_referral_code;
$$ LANGUAGE sql;

-- ═══════════════════════════════════════════════════════
-- EXAMPLE USAGE
-- ═══════════════════════════════════════════════════════
--
-- Subscribe (step 1: pending):
--   INSERT INTO subscribers (email, name, confirmation_token, source, referred_by)
--   VALUES ('dev@example.com', 'Alex', 'tok_abc123', 'website', 'ref_xyz');
--
-- Confirm (step 2: activate + assign referral code):
--   UPDATE subscribers
--   SET status = 'active', confirmed_at = NOW(), referral_code = 'ref_' || substr(md5(random()::text), 1, 8)
--   WHERE confirmation_token = 'tok_abc123';
--
-- Count active:
--   SELECT get_subscriber_count();
--
-- Referral leaderboard:
--   SELECT name, email, referral_code, referral_count
--   FROM subscribers WHERE referral_count > 0
--   ORDER BY referral_count DESC LIMIT 20;
