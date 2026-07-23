import http from 'http';
import { URL } from 'url';
import { extractMetaMessages, verifyMetaWebhook } from './meta.js';
import { extractTikTokMessages, verifyTikTokWebhook } from './tiktok.js';
import { extractTestMessages } from './test.js';
import { extractWhatsAppCloudMessages, verifyWhatsAppCloudWebhook } from './whatsapp-cloud.js';
import { handleDashboardRoute } from '../ui/dashboard-routes.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const MAX_BODY_BYTES = 1024 * 1024;

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  let raw = '';
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('request_body_too_large'));
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on('end', () => {
    if (!raw.trim()) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(raw));
    } catch (error) {
      reject(new Error('invalid_json_body'));
    }
  });
  req.on('error', reject);
});

const routeConfig = {
  '/webhooks/meta': {
    name: 'meta',
    verify: verifyMetaWebhook,
    extract: extractMetaMessages
  },
  '/webhooks/tiktok': {
    name: 'tiktok',
    verify: verifyTikTokWebhook,
    extract: extractTikTokMessages
  },
  '/webhooks/test': {
    name: 'test',
    verify: () => ({ ok: true, challenge: 'ok' }),
    extract: extractTestMessages
  },
  '/webhooks/whatsapp-cloud': {
    name: 'whatsapp_cloud',
    verify: verifyWhatsAppCloudWebhook,
    extract: extractWhatsAppCloudMessages
  }
};

export const startWebhookServer = ({ dispatchMessage, resolveTenant }) => {
  const port = Number(process.env.WEBHOOK_PORT || process.env.PORT || 3100);
  const enabled = process.env.ENABLE_WEBHOOK_SERVER !== 'false';
  if (!enabled) {
    logger.info({ kind: 'webhook_server_disabled' }, 'Webhook server disabled');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = routeConfig[url.pathname];

    if (await handleDashboardRoute(req, res, url)) {
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', component: 'social-listener-webhook', dashboard: 'enabled' });
      return;
    }

    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      const verification = route.verify(query);
      if (!verification.ok) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(String(verification.challenge || 'ok'));
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const extractedMessages = route.extract(payload);
      const tenantKeyFromMessage = extractedMessages.find((message) => message.metadata?.phone_number_id)?.metadata?.phone_number_id;
      const tenant = resolveTenant({
        tenantKey: url.searchParams.get('tenant') || payload.tenant || payload.wa_session_id,
        organizationId: url.searchParams.get('organization_id') || payload.organization_id,
        channelKey: tenantKeyFromMessage || null
      });
      const messages = extractedMessages.map((message) => ({
        ...message,
        organization_id: tenant?.organization_id || message.organization_id || null,
        metadata: {
          ...(message.metadata || {}),
          webhook_adapter: route.name,
          webhook_tenant_key: url.searchParams.get('tenant') || payload.tenant || tenantKeyFromMessage || null
        }
      }));

      for (const message of messages) {
        dispatchMessage(message, tenant);
      }

      logger.info(
        { kind: 'webhook_received', adapter: route.name, count: messages.length, tenant: tenant?.organization_name },
        'Webhook payload accepted'
      );
      sendJson(res, 202, { status: 'accepted', adapter: route.name, messages: messages.length });
    } catch (error) {
      logger.error({ kind: 'webhook_error', adapter: route.name, error: error.message }, 'Webhook payload failed');
      sendJson(res, 400, { error: error.message });
    }
  });

  server.on('error', (error) => {
    logger.error(
      { kind: 'webhook_server_error', port, error: error.message, code: error.code },
      'Social listener webhook server failed'
    );
  });

  server.listen(port, () => {
    logger.info({ kind: 'webhook_server_started', port }, `Social listener webhook server listening on ${port}`);
  });

  return server;
};
