const { query } = require('./pg');

/**
 * Loads all active tenants on startup.
 */
async function getActiveTenants() {
  const result = await query(
    `SELECT t.*, o.name as organization_name 
     FROM tenant_configs t
     JOIN organizations o ON t.organization_id = o.id
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
async function getTenantConfigBySessionId(waSessionId) {
  const result = await query(
    `SELECT t.*, o.name as organization_name 
     FROM tenant_configs t
     JOIN organizations o ON t.organization_id = o.id
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
async function recordLlmUsage(tenantId, agentName, provider, model, tokens, latency, costUsd, routingMode) {
  await query(
    `INSERT INTO llm_usage_events 
     (organization_id, agent_name, provider, model, input_tokens, output_tokens, total_tokens, latency_ms, estimated_cost_usd, routing_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId, 
      agentName, 
      provider, 
      model, 
      tokens.input || 0, 
      tokens.output || 0, 
      tokens.total || 0, 
      latency, 
      costUsd, 
      routingMode
    ]
  );
}

module.exports = {
  getActiveTenants,
  getTenantConfigBySessionId,
  recordLlmUsage
};
