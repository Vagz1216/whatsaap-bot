import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createContact,
  createOrganizationLlmCredential,
  createOrganization,
  createSubscriptionPlan,
  getAdminOverview,
  getOrganizationSubscription,
  getTenantChannels,
  getTenantDashboard,
  listComplianceEvents,
  listOrganizationLlmCredentials,
  listOrganizationUsers,
  listSubscriptionPlans,
  testOrganizationLlmCredential,
  updateOrganization,
  updateOrganizationLlmCredential,
  updateSubscriptionPlan,
  updateLeadStatus,
  updateTenantConfig,
  upsertOrganizationSubscription,
  upsertOrganizationUser
} from './dashboard-data.js';
import {
  ADMIN_ROLES,
  MANAGER_ROLES,
  READ_ROLES,
  WORKFLOW_ROLES,
  dashboardMe,
  getDashboardActor,
  listAccessibleOrganizations,
  requireOrganizationRole,
  requireSystemOwner
} from './dashboard-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public/dashboard');
const MAX_DASHBOARD_BODY_BYTES = 512 * 1024;
const requestBuckets = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

export const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  let raw = '';
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_DASHBOARD_BODY_BYTES) {
      reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
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
    } catch {
      reject(Object.assign(new Error('invalid_json_body'), { statusCode: 400 }));
    }
  });
  req.on('error', reject);
});

const clientKey = (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

const checkRateLimit = (req) => {
  const limit = Number(process.env.DASHBOARD_RATE_LIMIT_PER_MINUTE || 120);
  const key = clientKey(req);
  const now = Date.now();
  const current = requestBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + 60_000;
  }
  current.count += 1;
  requestBuckets.set(key, current);
  return current.count <= limit;
};

const serveStatic = (res, pathname) => {
  if (pathname === '/favicon.ico') {
    res.writeHead(204, {
      'Cache-Control': 'public, max-age=86400'
    });
    res.end();
    return true;
  }

  const shellRoutes = new Set([
    '/admin',
    '/tenant',
    '/channels',
    '/tenant/leads',
    '/tenant/settings',
    '/dashboard',
    '/sign-in',
    '/sign-up',
    '/plans',
    '/usage',
    '/organization',
    '/llm-credentials',
    '/compliance'
  ]);
  const requested = shellRoutes.has(pathname)
    ? 'index.html'
    : pathname.replace(/^\/dashboard\//, '');
  const filePath = path.resolve(publicDir, requested);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'forbidden' });
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
};

const handleApi = async (req, res, url) => {
  if (!checkRateLimit(req)) {
    sendJson(res, 429, { error: 'rate_limited' });
    return true;
  }

  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/auth/config') {
    sendJson(res, 200, {
      clerk_publishable_key: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || null,
      clerk_enabled: Boolean(process.env.CLERK_JWKS_URL)
    });
    return true;
  }

  try {
    const actor = await getDashboardActor(req);

    if (req.method === 'GET' && pathname === '/api/me') {
      sendJson(res, 200, await dashboardMe(actor));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/admin/overview') {
      requireSystemOwner(actor);
      sendJson(res, 200, await getAdminOverview());
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/plans') {
      sendJson(res, 200, { plans: await listSubscriptionPlans(actor) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/plans') {
      requireSystemOwner(actor);
      const body = await readBody(req);
      sendJson(res, 201, { plan: await createSubscriptionPlan(body, actor) });
      return true;
    }

    const planMatch = pathname.match(/^\/api\/plans\/(\d+)$/);
    if (req.method === 'PATCH' && planMatch) {
      requireSystemOwner(actor);
      const body = await readBody(req);
      sendJson(res, 200, { plan: await updateSubscriptionPlan(Number(planMatch[1]), body, actor) });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/organizations') {
      sendJson(res, 200, { organizations: await listAccessibleOrganizations(actor) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/admin/organizations') {
      requireSystemOwner(actor);
      const body = await readBody(req);
      sendJson(res, 201, { organization: await createOrganization(body, actor) });
      return true;
    }

    const organizationMatch = pathname.match(/^\/api\/organizations\/(\d+)$/);
    if (req.method === 'PATCH' && organizationMatch) {
      const orgId = Number(organizationMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      const body = await readBody(req);
      sendJson(res, 200, { organization: await updateOrganization(orgId, body, actor) });
      return true;
    }

    const orgUsersMatch = pathname.match(/^\/api\/organizations\/(\d+)\/users$/);
    if (req.method === 'GET' && orgUsersMatch) {
      const orgId = Number(orgUsersMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      sendJson(res, 200, { users: await listOrganizationUsers(orgId) });
      return true;
    }

    if (req.method === 'POST' && orgUsersMatch) {
      const orgId = Number(orgUsersMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      const body = await readBody(req);
      sendJson(res, 200, { users: await upsertOrganizationUser(orgId, body, actor) });
      return true;
    }

    const orgSubscriptionMatch = pathname.match(/^\/api\/organizations\/(\d+)\/subscription$/);
    if (req.method === 'GET' && orgSubscriptionMatch) {
      const orgId = Number(orgSubscriptionMatch[1]);
      await requireOrganizationRole(actor, orgId, READ_ROLES);
      sendJson(res, 200, { subscription: await getOrganizationSubscription(orgId) });
      return true;
    }

    if (req.method === 'POST' && orgSubscriptionMatch) {
      const orgId = Number(orgSubscriptionMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      const body = await readBody(req);
      sendJson(res, 200, { subscription: await upsertOrganizationSubscription(orgId, body, actor) });
      return true;
    }

    const orgCredentialsMatch = pathname.match(/^\/api\/organizations\/(\d+)\/llm-credentials$/);
    if (req.method === 'GET' && orgCredentialsMatch) {
      const orgId = Number(orgCredentialsMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      sendJson(res, 200, await listOrganizationLlmCredentials(orgId));
      return true;
    }

    if (req.method === 'POST' && orgCredentialsMatch) {
      const orgId = Number(orgCredentialsMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      const body = await readBody(req);
      sendJson(res, 201, await createOrganizationLlmCredential(orgId, body, actor));
      return true;
    }

    const orgCredentialMatch = pathname.match(/^\/api\/organizations\/(\d+)\/llm-credentials\/(\d+)$/);
    const orgCredentialTestMatch = pathname.match(/^\/api\/organizations\/(\d+)\/llm-credentials\/(\d+)\/test$/);
    if (req.method === 'POST' && orgCredentialTestMatch) {
      const orgId = Number(orgCredentialTestMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      sendJson(res, 200, await testOrganizationLlmCredential(orgId, Number(orgCredentialTestMatch[2]), actor));
      return true;
    }

    if (req.method === 'PATCH' && orgCredentialMatch) {
      const orgId = Number(orgCredentialMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      const body = await readBody(req);
      sendJson(res, 200, await updateOrganizationLlmCredential(orgId, Number(orgCredentialMatch[2]), body, actor));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/compliance/events') {
      const organizationId = url.searchParams.get('organization_id');
      if (organizationId) {
        await requireOrganizationRole(actor, Number(organizationId), MANAGER_ROLES);
      } else {
        requireSystemOwner(actor);
      }
      sendJson(res, 200, {
        events: await listComplianceEvents({
          organization_id: organizationId,
          limit: url.searchParams.get('limit')
        })
      });
      return true;
    }

    const tenantMatch = pathname.match(/^\/api\/tenants\/(\d+)$/);
    if (req.method === 'GET' && tenantMatch) {
      const orgId = Number(tenantMatch[1]);
      await requireOrganizationRole(actor, orgId, READ_ROLES);
      sendJson(res, 200, await getTenantDashboard(orgId));
      return true;
    }

    const tenantChannelsMatch = pathname.match(/^\/api\/tenants\/(\d+)\/channels$/);
    if (req.method === 'GET' && tenantChannelsMatch) {
      const orgId = Number(tenantChannelsMatch[1]);
      await requireOrganizationRole(actor, orgId, READ_ROLES);
      sendJson(res, 200, await getTenantChannels(orgId));
      return true;
    }

    const tenantConfigMatch = pathname.match(/^\/api\/tenants\/(\d+)\/config$/);
    if (req.method === 'PATCH' && tenantConfigMatch) {
      const body = await readBody(req);
      const orgId = Number(tenantConfigMatch[1]);
      await requireOrganizationRole(actor, orgId, ADMIN_ROLES);
      sendJson(res, 200, { config: await updateTenantConfig(orgId, body) });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/contacts') {
      const body = await readBody(req);
      const orgId = Number(body.organization_id);
      await requireOrganizationRole(actor, orgId, MANAGER_ROLES);
      sendJson(res, 201, { contact: await createContact({ ...body, organization_id: orgId }) });
      return true;
    }

    const leadStatusMatch = pathname.match(/^\/api\/leads\/(\d+)\/status$/);
    if (req.method === 'PATCH' && leadStatusMatch) {
      const body = await readBody(req);
      const orgId = Number(body.organization_id);
      await requireOrganizationRole(actor, orgId, WORKFLOW_ROLES);
      sendJson(res, 200, {
        lead: await updateLeadStatus(Number(leadStatusMatch[1]), body.status, orgId)
      });
      return true;
    }

    return false;
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'dashboard_error' });
    return true;
  }
};

export const handleDashboardRoute = async (req, res, url) => {
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  if (
    url.pathname === '/' ||
    url.pathname === '/admin' ||
    url.pathname === '/tenant' ||
    url.pathname === '/tenant/leads' ||
    url.pathname === '/tenant/settings' ||
    url.pathname === '/sign-in' ||
    url.pathname === '/sign-up' ||
    url.pathname === '/plans' ||
    url.pathname === '/usage' ||
    url.pathname === '/organization' ||
    url.pathname === '/llm-credentials' ||
    url.pathname === '/compliance' ||
    url.pathname.startsWith('/dashboard/')
  ) {
    return serveStatic(res, url.pathname === '/' ? '/admin' : url.pathname);
  }

  return false;
};
