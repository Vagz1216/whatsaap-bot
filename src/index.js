import { startMonitor } from './agents/monitor.js';
import { processMessage } from './pipeline/index.js';
import { validateEnv } from './config/env.js';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

// Ensure timezone is set properly for the entire application
process.env.TZ = process.env.TZ || 'Africa/Nairobi';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const isSaaSMode = !!process.env.DATABASE_URL;

const initLocal = async () => {
  const config = validateEnv();
  logger.info({ kind: 'startup', mode: 'local', dataDir: config.dataDir }, 'Starting StayEZ WhatsApp Monitor (Local Mode)');

  await startMonitor(async (msgData) => {
    processMessage(msgData).catch(err => {
      logger.error({ kind: 'pipeline_error', error: err.message }, 'Pipeline failed to process message');
    });
  });
};

const initSaaS = async () => {
  logger.info({ kind: 'startup', mode: 'saas' }, 'Starting StayEZ SaaS Platform (Multi-Tenant Mode)');

  // Dynamic import to avoid loading pg module when running locally
  const { getActiveTenants } = await import('./db/tenant.js');

  const tenants = await getActiveTenants();
  
  if (tenants.length === 0) {
    logger.warn({ kind: 'startup_warning' }, 'No active tenants found in database. Waiting for tenants to be onboarded...');
    return;
  }

  logger.info({ kind: 'tenants_loaded', count: tenants.length }, `Found ${tenants.length} active tenant(s)`);

  for (const tenantConfig of tenants) {
    logger.info({ kind: 'tenant_starting', tenant: tenantConfig.organization_name }, `Starting monitor for ${tenantConfig.organization_name}`);
    
    startMonitor(tenantConfig, async (msgData, config) => {
      processMessage(msgData, config).catch(err => {
        logger.error({ kind: 'pipeline_error', tenant: config.organization_name, error: err.message }, 'Pipeline failed to process message');
      });
    });
  }
};

const init = async () => {
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

init();

