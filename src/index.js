import './config/load-env.js';
import { startMonitor } from './agents/monitor.js';
import { processMessage } from './pipeline/index.js';
import { validateEnv } from './config/env.js';
import { startWebhookServer } from './adapters/webhook-server.js';
import pino from 'pino';
import { fileURLToPath } from 'url';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const isSaaSMode = !!process.env.DATABASE_URL;
const appRole = process.env.APP_ROLE || process.env.SERVICE_ROLE || 'all';
const validAppRoles = new Set(['all', 'web', 'whatsapp-worker']);

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
  const byWhatsAppCloudPhone = new Map();
  for (const tenant of tenants) {
    if (tenant.wa_session_id) bySessionId.set(String(tenant.wa_session_id), tenant);
    byOrgId.set(String(tenant.organization_id), tenant);
    if (tenant.whatsapp_cloud_phone_number_id) {
      byWhatsAppCloudPhone.set(String(tenant.whatsapp_cloud_phone_number_id), tenant);
    }
  }

  return ({ tenantKey, organizationId, channelKey }) => {
    if (tenantKey && bySessionId.has(String(tenantKey))) return bySessionId.get(String(tenantKey));
    if (tenantKey && byWhatsAppCloudPhone.has(String(tenantKey))) return byWhatsAppCloudPhone.get(String(tenantKey));
    if (channelKey && byWhatsAppCloudPhone.has(String(channelKey))) return byWhatsAppCloudPhone.get(String(channelKey));
    if (organizationId && byOrgId.has(String(organizationId))) return byOrgId.get(String(organizationId));
    if (tenants.length === 1) return tenants[0];
    return null;
  };
};

const hashString = (value) => {
  let hash = 0;
  for (const char of String(value || '')) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
};

const tenantBelongsToWorker = (tenantConfig) => {
  const total = Math.max(1, Number(process.env.WHATSAPP_WORKER_TOTAL || 1));
  const index = Math.max(0, Number(process.env.WHATSAPP_WORKER_INDEX || 0));
  if (total === 1) return true;
  return hashString(tenantConfig.wa_session_id || tenantConfig.organization_id) % total === index;
};

const initSaaS = async () => {
  if (!validAppRoles.has(appRole)) {
    throw new Error(`Unsupported APP_ROLE "${appRole}". Use all, web, or whatsapp-worker.`);
  }
  const startWeb = appRole === 'all' || appRole === 'web';
  const startWhatsApp = appRole === 'all' || appRole === 'whatsapp-worker';
  logger.info({ kind: 'startup', mode: 'saas', app_role: appRole }, 'Starting StayEZ SaaS Platform (Multi-Tenant Mode)');

  // Dynamic import to avoid loading pg module when running locally
  const { getActiveTenants } = await import('./db/tenant.js');

  const tenants = await getActiveTenants();
  
  if (tenants.length === 0) {
    logger.warn({ kind: 'startup_warning' }, 'No active tenants found in database. Waiting for tenants to be onboarded...');
    if (startWeb) {
      startWebhookServer({
        dispatchMessage,
        resolveTenant: () => null
      });
    } else {
      setInterval(() => {}, 60 * 60 * 1000);
    }
    return;
  }

  logger.info({ kind: 'tenants_loaded', count: tenants.length }, `Found ${tenants.length} active tenant(s)`);
  const resolveTenant = buildTenantResolver(tenants);

  if (startWhatsApp) {
    const workerTenants = tenants.filter(tenantBelongsToWorker);
    logger.info(
      {
        kind: 'whatsapp_worker_scope',
        total_tenants: tenants.length,
        worker_tenants: workerTenants.length,
        worker_index: Number(process.env.WHATSAPP_WORKER_INDEX || 0),
        worker_total: Number(process.env.WHATSAPP_WORKER_TOTAL || 1)
      },
      'Starting WhatsApp Web worker scope'
    );

    if (workerTenants.length === 0 && !startWeb) {
      logger.warn({ kind: 'whatsapp_worker_idle' }, 'No tenants assigned to this WhatsApp worker shard; staying idle');
      setInterval(() => {}, 60 * 60 * 1000);
    }

    for (const tenantConfig of workerTenants) {
      logger.info({ kind: 'tenant_starting', tenant: tenantConfig.organization_name }, `Starting monitor for ${tenantConfig.organization_name}`);
      startMonitor(tenantConfig, async (msgData, config) => dispatchMessage(msgData, config));
    }
  }

  if (startWeb) {
    startWebhookServer({
      dispatchMessage,
      resolveTenant
    });
  }
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
