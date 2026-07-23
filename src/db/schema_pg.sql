-- PostgreSQL schema for StayEZ SaaS Platform

CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','ARCHIVED')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
    id SERIAL PRIMARY KEY,
    clerk_user_id TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    platform_role TEXT NOT NULL DEFAULT 'user' CHECK(platform_role IN ('system_owner','user')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_users (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('org_admin','sales_manager','sales_user','viewer')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INVITED','DISABLED')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, user_id)
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

    -- Meta (Facebook/Instagram) destination
    meta_access_token_secret TEXT,

    -- WhatsApp Cloud API (official Business API) destination
    whatsapp_cloud_enabled INTEGER DEFAULT 0,
    whatsapp_cloud_phone_number_id TEXT,
    whatsapp_cloud_waba_id TEXT,
    whatsapp_cloud_display_number TEXT,
    whatsapp_cloud_access_token_secret TEXT,

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
    source_platform TEXT DEFAULT 'whatsapp',
    source_channel TEXT,
    source_group_name TEXT,
    external_message_id TEXT,
    sender_external_id TEXT,
    received_at TIMESTAMP,
    contactability_status TEXT DEFAULT 'direct_contact_available',
    metadata JSONB,
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

CREATE TABLE IF NOT EXISTS inbound_message_events (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_platform TEXT NOT NULL,
    source_channel TEXT,
    external_message_id TEXT NOT NULL,
    source_id TEXT,
    sender_external_id TEXT,
    raw_message_hash TEXT,
    status TEXT NOT NULL DEFAULT 'received',
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    last_error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, source_platform, external_message_id)
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

-- Platform Usage Tracking
CREATE TABLE IF NOT EXISTS platform_usage_events (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    source_object_type TEXT,
    source_object_id TEXT,
    idempotency_key TEXT UNIQUE,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_cost_allocations (
    id SERIAL PRIMARY KEY,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    category TEXT NOT NULL,
    provider TEXT,
    total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    allocation_method TEXT NOT NULL DEFAULT 'manual',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- LLM Credentials (BYOK)
CREATE TABLE IF NOT EXISTS organization_llm_credentials (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('openai','azure_openai','gemini','groq','cerebras','openrouter')),
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
    api_key_secret TEXT NOT NULL,
    base_url TEXT,
    azure_endpoint TEXT,
    azure_deployment TEXT,
    azure_api_version TEXT,
    default_model TEXT,
    created_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    last_used_at TIMESTAMP,
    last_tested_at TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP,
    UNIQUE (organization_id, provider, label)
);

-- Subscription plans
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL DEFAULT 'USD',
    market_code TEXT NOT NULL DEFAULT 'GLOBAL',
    trial_days INTEGER NOT NULL DEFAULT 14,
    max_users INTEGER,
    max_monthly_messages INTEGER,
    max_monthly_ai_tokens INTEGER,
    max_monthly_ai_credits INTEGER,
    overage_allowed INTEGER NOT NULL DEFAULT 0 CHECK(overage_allowed IN (0,1)),
    overage_price_cents_per_ai_credit INTEGER,
    allow_byok INTEGER NOT NULL DEFAULT 0 CHECK(allow_byok IN (0,1)),
    byok_provider_mode TEXT NOT NULL DEFAULT 'platform_first' CHECK(byok_provider_mode IN ('platform_first','organization_first','organization_only')),
    max_llm_credentials INTEGER,
    allowed_llm_routing_modes TEXT NOT NULL DEFAULT 'cost_optimized,balanced,quality_first',
    default_llm_routing_mode TEXT NOT NULL DEFAULT 'balanced' CHECK(default_llm_routing_mode IN ('cost_optimized','balanced','quality_first')),
    trial_allowed_llm_routing_modes TEXT NOT NULL DEFAULT 'cost_optimized',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP
);

-- Organization Subscriptions
CREATE TABLE IF NOT EXISTS organization_subscriptions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'TRIALING' CHECK(status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELED','EXPIRED')),
    trial_ends_at TIMESTAMP,
    current_period_started_at TIMESTAMP,
    current_period_ends_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP
);

-- Billing Periods
CREATE TABLE IF NOT EXISTS organization_billing_periods (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES organization_subscriptions(id) ON DELETE SET NULL,
    plan_id INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    included_ai_credits INTEGER,
    included_messages INTEGER,
    included_users INTEGER,
    overage_allowed INTEGER NOT NULL DEFAULT 0 CHECK(overage_allowed IN (0,1)),
    overage_price_cents_per_ai_credit INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','VOID')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP,
    UNIQUE (organization_id, period_start, period_end)
);

-- AI Action Credits
CREATE TABLE IF NOT EXISTS ai_usage_actions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    request_id TEXT,
    action_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    credits_used INTEGER NOT NULL DEFAULT 0,
    billing_period_start TIMESTAMP,
    billing_period_end TIMESTAMP,
    source_object_type TEXT,
    source_object_id TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','error','void')),
    idempotency_key TEXT UNIQUE,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- LLM usage tracking
CREATE TABLE IF NOT EXISTS llm_usage_events (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT 1,
    user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    ai_usage_action_id INTEGER REFERENCES ai_usage_actions(id) ON DELETE SET NULL,
    request_id TEXT,
    agent_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 1,
    latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    pricing_source TEXT,
    pricing_version TEXT,
    routing_mode TEXT,
    billing_source TEXT NOT NULL DEFAULT 'platform' CHECK(billing_source IN ('platform','organization')),
    provider_credential_id INTEGER REFERENCES organization_llm_credentials(id) ON DELETE SET NULL,
    fallback_triggered INTEGER NOT NULL DEFAULT 0 CHECK(fallback_triggered IN (0,1)),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','error')),
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Insert a default plan
INSERT INTO subscription_plans (name, slug, monthly_price_cents, default_llm_routing_mode, allowed_llm_routing_modes, max_monthly_ai_credits)
VALUES ('Starter', 'starter', 0, 'cost_optimized', 'cost_optimized', 1000)
ON CONFLICT (slug) DO NOTHING;

-- Insert Tenant #1 (StayEZ) defaults
INSERT INTO organizations (id, name, slug) VALUES (1, 'StayEZ', 'stayez') ON CONFLICT (id) DO NOTHING;

-- Let's define index for wa_session_id since we will query by it often
CREATE INDEX IF NOT EXISTS idx_tenant_configs_wa_session_id ON tenant_configs(wa_session_id);
CREATE INDEX IF NOT EXISTS idx_inbound_message_events_org_status ON inbound_message_events(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_whatsapp_cloud_phone ON tenant_configs(whatsapp_cloud_phone_number_id);

-- SaaS Performance Indices
CREATE INDEX IF NOT EXISTS idx_app_users_clerk_user_id ON app_users(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
CREATE INDEX IF NOT EXISTS idx_organization_users_user_id ON organization_users(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_users_user_status_org ON organization_users(user_id, status, organization_id, role);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_active ON subscription_plans(active);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_market_currency ON subscription_plans(market_code, currency_code, active);
CREATE INDEX IF NOT EXISTS idx_organization_subscriptions_org ON organization_subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_subscriptions_plan ON organization_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_organization_subscriptions_status ON organization_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_billing_periods_org ON organization_billing_periods(organization_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_created ON ai_usage_actions(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON ai_usage_actions(organization_id, billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_actions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_usage_org_created ON platform_usage_events(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_cost_period ON platform_cost_allocations(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_org_llm_credentials_org_status ON organization_llm_credentials(organization_id, status);

-- Ensure meta_access_token_secret exists in case the table was created before
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS meta_access_token_secret TEXT;
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS whatsapp_cloud_enabled INTEGER DEFAULT 0;
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS whatsapp_cloud_phone_number_id TEXT;
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS whatsapp_cloud_waba_id TEXT;
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS whatsapp_cloud_display_number TEXT;
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS whatsapp_cloud_access_token_secret TEXT;

CREATE TABLE IF NOT EXISTS channel_runtime_status (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL,
    channel_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    worker_id TEXT,
    metadata TEXT,
    last_error TEXT,
    last_seen_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, channel_type, channel_key)
);
CREATE INDEX IF NOT EXISTS idx_channel_runtime_org ON channel_runtime_status(organization_id, channel_type, updated_at);
