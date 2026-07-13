-- PostgreSQL schema for StayEZ SaaS Platform

CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','ARCHIVED')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Per-tenant configuration (the core SaaS feature)
CREATE TABLE IF NOT EXISTS tenant_configs (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

    -- WhatsApp session identity (path to auth state)
    wa_session_id TEXT NOT NULL UNIQUE,

    -- Telegram destination
    telegram_bot_token_secret TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,

    -- Inventory source (optional — only for accommodation tenants)
    wc_base_url TEXT,
    wc_consumer_key_secret TEXT,
    wc_consumer_secret_secret TEXT,

    -- Custom pipeline configuration
    classifier_system_prompt TEXT NOT NULL,
    keyword_whitelist TEXT NOT NULL,
    keyword_blacklist TEXT NOT NULL,
    drafter_persona TEXT NOT NULL,
    default_language TEXT NOT NULL DEFAULT 'en',

    -- Model routing preference
    llm_routing_mode TEXT NOT NULL DEFAULT 'cost_optimized',

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP
);

-- Leads now scoped to tenant
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_name TEXT,
    sender_number TEXT NOT NULL,
    sender_name TEXT,
    raw_message TEXT NOT NULL,
    detected_language TEXT,
    extracted_data JSONB,
    classifier_confidence REAL,
    matched_items JSONB,
    status TEXT DEFAULT 'pending',
    draft_to_client JSONB,
    draft_to_source JSONB,
    drafts_to_contacts JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Local contacts (generic version of local_hosts)
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    region TEXT,
    sub_area TEXT,
    tags TEXT,
    notes TEXT,
    source TEXT DEFAULT 'manual',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, whatsapp_number)
);

-- LLM usage tracking (borrowed from SDR)
CREATE TABLE IF NOT EXISTS llm_usage_events (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id TEXT,
    agent_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    routing_mode TEXT,
    fallback_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'success',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- AI Action Credits
CREATE TABLE IF NOT EXISTS ai_usage_actions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    credits_used INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','error')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Subscription plans (simplified from SDR)
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    max_monthly_ai_credits INTEGER,
    max_monthly_messages INTEGER,
    allowed_routing_modes TEXT NOT NULL DEFAULT 'cost_optimized',
    allow_byok BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Insert a default plan
INSERT INTO subscription_plans (name, slug, monthly_price_cents, allowed_routing_modes, max_monthly_ai_credits)
VALUES ('Starter', 'starter', 0, 'cost_optimized', 1000)
ON CONFLICT (slug) DO NOTHING;

-- Insert Tenant #1 (StayEZ) defaults
INSERT INTO organizations (id, name, slug) VALUES (1, 'StayEZ', 'stayez') ON CONFLICT (id) DO NOTHING;

-- Let's define index for wa_session_id since we will query by it often
CREATE INDEX IF NOT EXISTS idx_tenant_configs_wa_session_id ON tenant_configs(wa_session_id);
