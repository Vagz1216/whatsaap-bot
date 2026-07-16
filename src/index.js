import { startMonitor } from './agents/monitor.js';
import { processMessage } from './pipeline/index.js';
import { validateEnv } from './config/env.js';
import { startWebhookServer } from './adapters/webhook-server.js';
import dotenv from 'dotenv';
import pino from 'pino';
import { fileURLToPath } from 'url';

dotenv.config();

// Ensure timezone is set properly for the entire application
process.env.TZ = process.env.TZ || 'Africa/Nairobi';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const isSaaSMode = !!process.env.DATABASE_URL;

const dispatchMessage = (msgData, tenantConfig = null) => {
  processMessage(msgData, tenantConfig).catch(err => {
    logger.error(
      { kind: 'pipeline_error', tenant: tenantConfig?.organization_name, error: err.message },
      'Pipeline failed to process message'
    );
  });
};

const initLocal = async () => {
  const config = validateEnv();
  logger.info({ kind: 'startup', mode: 'local', dataDir: config.dataDir }, 'Starting StayEZ WhatsApp Monitor (Local Mode)');

  await startMonitor(async (msgData) => dispatchMessage(msgData));
  startWebhookServer({
    dispatchMessage,
    resolveTenant: () => null
  });
};

const buildTenantResolver = (tenants) => {
  const bySessionId = new Map();
  const byOrgId = new Map();
  for (const tenant of tenants) {
    bySessionId.set(String(tenant.wa_session_id), tenant);
    byOrgId.set(String(tenant.organization_id), tenant);
  }

  return ({ tenantKey, organizationId }) => {
    if (tenantKey && bySessionId.has(String(tenantKey))) return bySessionId.get(String(tenantKey));
    if (organizationId && byOrgId.has(String(organizationId))) return byOrgId.get(String(organizationId));
    if (tenants.length === 1) return tenants[0];
    return null;
  };
};

const initSaaS = async () => {
  logger.info({ kind: 'startup', mode: 'saas' }, 'Starting StayEZ SaaS Platform (Multi-Tenant Mode)');

  // Dynamic import to avoid loading pg module when running locally
  const { getActiveTenants } = await import('./db/tenant.js');

  const tenants = await getActiveTenants();
  
  if (tenants.length === 0) {
    logger.warn({ kind: 'startup_warning' }, 'No active tenants found in database. Waiting for tenants to be onboarded...');
    startWebhookServer({
      dispatchMessage,
      resolveTenant: () => null
    });
    return;
  }

  logger.info({ kind: 'tenants_loaded', count: tenants.length }, `Found ${tenants.length} active tenant(s)`);
  const resolveTenant = buildTenantResolver(tenants);

  for (const tenantConfig of tenants) {
    logger.info({ kind: 'tenant_starting', tenant: tenantConfig.organization_name }, `Starting monitor for ${tenantConfig.organization_name}`);
    
    startMonitor(tenantConfig, async (msgData, config) => dispatchMessage(msgData, config));
  }

  startWebhookServer({
    dispatchMessage,
    resolveTenant
  });
};

export const init = async () => {
  try {
    if (isSaaSMode) {
      await initSaaS();
    } else {
      await initLocal();
    }
  } catch (error) {
    logger.error({ kind: 'startup_error', error: error.message }, 'Failed to start');
    process.exit(1);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  init();
}
