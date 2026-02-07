-- Curiosity Intelligence Database Schema
-- Designed for Supabase (PostgreSQL + pgvector)
-- Multi-tenant with Row Level Security

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =====================================================
-- TENANTS TABLE
-- Organizations/users in the system
-- =====================================================
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    external_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    
    plan VARCHAR(50) DEFAULT 'free',
    plan_expires_at TIMESTAMPTZ,
    
    settings JSONB DEFAULT '{}',
    
    max_runs_per_week INTEGER DEFAULT 1,
    max_signals_per_run INTEGER DEFAULT 10,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_tenants_external_id ON tenants(external_id);
CREATE INDEX IF NOT EXISTS ix_tenants_slug ON tenants(slug);

-- =====================================================
-- API KEYS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    key_hash VARCHAR(100) NOT NULL,
    name VARCHAR(100),
    scopes JSONB DEFAULT '["read"]',
    
    last_used_at TIMESTAMPTZ,
    request_count INTEGER DEFAULT 0,
    
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS ix_api_keys_tenant_id ON api_keys(tenant_id);

-- =====================================================
-- RUNS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS runs (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    week VARCHAR(10) NOT NULL,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    
    questions_ingested INTEGER DEFAULT 0,
    clusters_created INTEGER DEFAULT 0,
    signals_detected INTEGER DEFAULT 0,
    
    status VARCHAR(20) DEFAULT 'running',
    error_message TEXT,
    experiment_assignments JSONB DEFAULT '{}',
    
    CONSTRAINT valid_status CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_runs_tenant_id ON runs(tenant_id);
CREATE INDEX IF NOT EXISTS ix_runs_week ON runs(week);
CREATE INDEX IF NOT EXISTS ix_runs_tenant_week ON runs(tenant_id, week);

-- =====================================================
-- QUESTIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    
    external_id VARCHAR(100) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    source_url TEXT,
    
    raw_text TEXT NOT NULL,
    normalized_text TEXT,
    embedding vector(1536),
    
    upvotes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    
    external_created_at TIMESTAMPTZ,
    ingested_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    
    cluster_id INTEGER
);

CREATE INDEX IF NOT EXISTS ix_questions_tenant_id ON questions(tenant_id);
CREATE INDEX IF NOT EXISTS ix_questions_run_id ON questions(run_id);
CREATE INDEX IF NOT EXISTS ix_questions_platform ON questions(platform);

CREATE INDEX IF NOT EXISTS ix_questions_embedding ON questions 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- =====================================================
-- CLUSTERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS clusters (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    
    cluster_index INTEGER,
    canonical_question TEXT NOT NULL,
    centroid vector(1536),
    
    question_count INTEGER DEFAULT 0,
    cross_platform_count INTEGER DEFAULT 0,
    total_engagement INTEGER DEFAULT 0,
    platform_counts JSONB DEFAULT '{}',
    
    earliest_seen TIMESTAMPTZ,
    latest_seen TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_clusters_tenant_id ON clusters(tenant_id);
CREATE INDEX IF NOT EXISTS ix_clusters_run_id ON clusters(run_id);

ALTER TABLE questions 
ADD CONSTRAINT fk_questions_cluster 
FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL;

-- =====================================================
-- SIGNALS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
    
    canonical_question TEXT NOT NULL,
    
    velocity_score FLOAT DEFAULT 0.0,
    cross_platform_score FLOAT DEFAULT 0.0,
    engagement_score FLOAT DEFAULT 0.0,
    novelty_score FLOAT DEFAULT 0.0,
    weirdness_bonus FLOAT DEFAULT 0.0,
    final_score FLOAT DEFAULT 0.0,
    
    tier VARCHAR(20),
    is_signal BOOLEAN DEFAULT FALSE,
    
    velocity_pct FLOAT DEFAULT 0.0,
    question_count INTEGER DEFAULT 0,
    platform_count INTEGER DEFAULT 0,
    
    news_trigger JSONB,
    
    CONSTRAINT valid_tier CHECK (tier IN ('breakout', 'strong', 'signal', 'noise'))
);

CREATE INDEX IF NOT EXISTS ix_signals_tenant_id ON signals(tenant_id);
CREATE INDEX IF NOT EXISTS ix_signals_run_id ON signals(run_id);
CREATE INDEX IF NOT EXISTS ix_signals_tier ON signals(tier);
CREATE INDEX IF NOT EXISTS ix_signals_final_score ON signals(final_score DESC);

-- =====================================================
-- EXPERIMENT TRACKING
-- =====================================================
CREATE TABLE IF NOT EXISTS experiment_assignments (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    experiment_name VARCHAR(100) NOT NULL,
    variant_name VARCHAR(100) NOT NULL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, experiment_name)
);

CREATE TABLE IF NOT EXISTS experiment_events (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    experiment_name VARCHAR(100) NOT NULL,
    variant_name VARCHAR(100) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    value FLOAT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_events ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies
CREATE POLICY "tenant_isolation_runs" ON runs
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

CREATE POLICY "tenant_isolation_questions" ON questions
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

CREATE POLICY "tenant_isolation_clusters" ON clusters
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

CREATE POLICY "tenant_isolation_signals" ON signals
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

CREATE POLICY "tenant_isolation_experiments" ON experiment_assignments
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

CREATE POLICY "tenant_isolation_events" ON experiment_events
    USING (tenant_id IN (SELECT id FROM tenants WHERE external_id = auth.uid()::text));

-- Service role bypass
CREATE POLICY "service_role_runs" ON runs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_questions" ON questions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_clusters" ON clusters FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_signals" ON signals FOR ALL USING (auth.role() = 'service_role');

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================
CREATE OR REPLACE FUNCTION get_tenant_id(ext_id TEXT)
RETURNS INTEGER AS $$
    SELECT id FROM tenants WHERE external_id = ext_id LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION check_run_limit(p_tenant_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
    run_count INTEGER;
    max_runs INTEGER;
BEGIN
    SELECT COUNT(*) INTO run_count FROM runs 
    WHERE tenant_id = p_tenant_id AND week = TO_CHAR(NOW(), 'IYYY-"W"IW');
    
    SELECT max_runs_per_week INTO max_runs FROM tenants WHERE id = p_tenant_id;
    RETURN run_count < max_runs;
END;
$$ LANGUAGE plpgsql STABLE;
