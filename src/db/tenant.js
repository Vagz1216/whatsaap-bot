import { query } from './pg.js';

let tenantChannelColumnsEnsured = false;

export async function ensureTenantChannelColumns() {
  if (tenantChannelColumnsEnsured || !process.env.DATABASE_URL) return;
  await query(`
    ALTER TABLE tenant_configs
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_enabled INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_phone_number_id TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_waba_id TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_display_number TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_access_token_secret TEXT
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_tenant_configs_whatsapp_cloud_phone ON tenant_configs(whatsapp_cloud_phone_number_id)');
  tenantChannelColumnsEnsured = true;
}

/**
 * Loads all active tenants on startup.
 */
export async function getActiveTenants() {
  await ensureTenantChannelColumns();
  const result = await query(
    `SELECT t.*, o.name as organization_name,
            s.status AS subscription_status,
            p.id AS plan_id,
            p.name AS plan_name,
            p.slug AS plan_slug,
            p.allow_byok AS plan_allow_byok,
            p.byok_provider_mode AS plan_byok_provider_mode,
            p.max_llm_credentials AS plan_max_llm_credentials,
            p.allowed_llm_routing_modes AS plan_allowed_llm_routing_modes,
            p.default_llm_routing_mode AS plan_default_llm_routing_mode
     FROM tenant_configs t
     JOIN organizations o ON t.organization_id = o.id
     LEFT JOIN organization_subscriptions s
       ON s.organization_id = o.id
      AND s.status IN ('TRIALING', 'ACTIVE')
     LEFT JOIN subscription_plans p
       ON p.id = s.plan_id
      AND p.active = 1
     WHERE o.status = 'ACTIVE'`
  );

  return result.rows.map(config => {
    try {
      config.keyword_whitelist = JSON.parse(config.keyword_whitelist || '[]');
      config.keyword_blacklist = JSON.parse(config.keyword_blacklist || '[]');
    } catch (e) {
      config.keyword_whitelist = [];
      config.keyword_blacklist = [];
    }
    return config;
  });
}

/**
 * Loads the configuration for a specific tenant based on their WhatsApp session ID.
 */
export async function getTenantConfigBySessionId(waSessionId) {
  await ensureTenantChannelColumns();
  const result = await query(
    `SELECT t.*, o.name as organization_name,
            s.status AS subscription_status,
            p.id AS plan_id,
            p.name AS plan_name,
            p.slug AS plan_slug,
            p.allow_byok AS plan_allow_byok,
            p.byok_provider_mode AS plan_byok_provider_mode,
            p.max_llm_credentials AS plan_max_llm_credentials,
            p.allowed_llm_routing_modes AS plan_allowed_llm_routing_modes,
            p.default_llm_routing_mode AS plan_default_llm_routing_mode
     FROM tenant_configs t
     JOIN organizations o ON t.organization_id = o.id
     LEFT JOIN organization_subscriptions s
       ON s.organization_id = o.id
      AND s.status IN ('TRIALING', 'ACTIVE')
     LEFT JOIN subscription_plans p
       ON p.id = s.plan_id
      AND p.active = 1
     WHERE t.wa_session_id = $1 AND o.status = 'ACTIVE'`,
    [waSessionId]
  );

  if (result.rowCount === 0) {
    throw new Error(`No active tenant found for WhatsApp session: ${waSessionId}`);
  }

  const config = result.rows[0];

  try {
    config.keyword_whitelist = JSON.parse(config.keyword_whitelist || '[]');
    config.keyword_blacklist = JSON.parse(config.keyword_blacklist || '[]');
  } catch (e) {
    console.error(`Failed to parse keywords for tenant ${config.organization_id}`, e);
    config.keyword_whitelist = [];
    config.keyword_blacklist = [];
  }

  return config;
}

/**
 * Updates LLM usage for metering
 */
export async function recordLlmUsage(tenantId, agentName, provider, model, tokens, latency, costUsd, routingMode, extra = {}) {
  await query(
    `INSERT INTO llm_usage_events 
     (organization_id, agent_name, provider, model, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens, latency_ms, estimated_cost_usd, routing_mode, fallback_triggered, attempt_count, tool_call_count, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      tenantId, 
      agentName, 
      provider, 
      model, 
      tokens.input || 0, 
      tokens.output || 0, 
      tokens.cached_input || 0,
      tokens.reasoning_output || 0,
      tokens.total || 0, 
      latency, 
      costUsd, 
      routingMode,
      extra.fallbackTriggered ? 1 : 0,
      extra.attemptCount || 1,
      extra.toolCallCount || 0,
      extra.status || 'success',
      extra.error || null
    ]
  );
}

/**
 * Records an AI usage action (e.g. generating a draft) for credit metering
 */
export async function recordAiUsage(tenantId, actionType, creditsUsed, userId = null, sourceObjectType = null, sourceObjectId = null, status = 'success') {
  await query(
    `INSERT INTO ai_usage_actions 
     (organization_id, user_id, action_type, credits_used, source_object_type, source_object_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, userId, actionType, creditsUsed, sourceObjectType, sourceObjectId, status]
  );
}

/**
 * Records platform usage events for billing and analytics
 */
export async function recordPlatformUsage(tenantId, eventType, quantity = 1, userId = null, sourceObjectType = null, sourceObjectId = null, metadata = null) {
  await query(
    `INSERT INTO platform_usage_events 
     (organization_id, user_id, event_type, quantity, source_object_type, source_object_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, userId, eventType, quantity, sourceObjectType, sourceObjectId, metadata ? JSON.stringify(metadata) : null]
  );
}
