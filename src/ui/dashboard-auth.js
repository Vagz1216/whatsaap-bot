import crypto from 'crypto';
import { query } from '../db/pg.js';

const JWKS_TTL_MS = 60 * 60 * 1000;
const READ_ROLES = new Set(['org_admin', 'sales_manager', 'sales_user', 'viewer']);
const MANAGER_ROLES = new Set(['org_admin', 'sales_manager']);
const WORKFLOW_ROLES = new Set(['org_admin', 'sales_manager', 'sales_user']);
const ADMIN_ROLES = new Set(['org_admin']);

let cachedJwks = null;
let jwksFetchedAt = 0;

const isSaaSMode = () => !!process.env.DATABASE_URL;

const ownerEmails = () => new Set(
  [
    process.env.PLATFORM_OWNER_EMAIL,
    ...(process.env.PLATFORM_OWNER_EMAILS || '').split(',')
  ]
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean)
);

const tokenFromRequest = (req) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return String(req.headers['x-dashboard-token'] || '').trim();
};

const decodeBase64UrlJson = (value) => {
  const json = Buffer.from(value, 'base64url').toString('utf8');
  return JSON.parse(json);
};

const getJwks = async () => {
  const now = Date.now();
  if (cachedJwks && now - jwksFetchedAt < JWKS_TTL_MS) return cachedJwks;
  if (!process.env.CLERK_JWKS_URL) {
    throw Object.assign(new Error('CLERK_JWKS_URL is not configured.'), { statusCode: 500 });
  }
  const response = await fetch(process.env.CLERK_JWKS_URL);
  if (!response.ok) {
    throw Object.assign(new Error('Could not fetch Clerk JWKS.'), { statusCode: 503 });
  }
  cachedJwks = await response.json();
  jwksFetchedAt = now;
  return cachedJwks;
};

const verifyJwt = async (token) => {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeBase64UrlJson(encodedHeader);
    const payload = decodeBase64UrlJson(encodedPayload);
    if (header.alg !== 'RS256') return null;

    const jwks = await getJwks();
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
    if (!jwk) return null;

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    const valid = verifier.verify(publicKey, Buffer.from(encodedSignature, 'base64url'));
    if (!valid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp <= now) return null;
    if (payload.nbf && payload.nbf > now) return null;
    if (process.env.CLERK_JWT_ISSUER && payload.iss !== process.env.CLERK_JWT_ISSUER) return null;

    return payload;
  } catch {
    return null;
  }
};

const identityFromClaims = (claims) => {
  const clerkUserId = String(claims.sub || claims.user_id || '').trim();
  const email = String(
    claims.email ||
    claims.primary_email_address ||
    claims.email_address ||
    ''
  ).trim().toLowerCase();
  const name = String(claims.name || claims.full_name || claims.username || '').trim();
  if (!clerkUserId) {
    throw Object.assign(new Error('Authenticated user is missing a subject.'), { statusCode: 401 });
  }
  return { clerkUserId, email: email || null, name: name || null };
};

const enrichClaims = async (claims) => {
  if ((claims.email || claims.primary_email_address || claims.email_address) || !process.env.CLERK_SECRET_KEY || !claims.sub) {
    return claims;
  }
  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(claims.sub)}`, {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` }
    });
    if (!response.ok) return claims;
    const user = await response.json();
    const primaryEmailId = user.primary_email_address_id;
    const emails = Array.isArray(user.email_addresses) ? user.email_addresses : [];
    const primaryEmail = emails.find((item) => item.id === primaryEmailId) || emails[0];
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return {
      ...claims,
      email: primaryEmail?.email_address || claims.email,
      name: name || claims.name
    };
  } catch {
    return claims;
  }
};

const ensureAppUser = async (claims) => {
  const identity = identityFromClaims(await enrichClaims(claims));
  const platformRole = identity.email && ownerEmails().has(identity.email) ? 'system_owner' : 'user';

  const existingByClerk = await query(
    'SELECT * FROM app_users WHERE clerk_user_id = $1',
    [identity.clerkUserId]
  );
  let existing = existingByClerk.rows[0];

  if (!existing && identity.email) {
    const existingByEmail = await query(
      'SELECT * FROM app_users WHERE lower(email) = lower($1)',
      [identity.email]
    );
    existing = existingByEmail.rows[0];
  }

  if (existing) {
    const nextRole = existing.platform_role === 'system_owner' || platformRole === 'system_owner'
      ? 'system_owner'
      : 'user';
    const updated = await query(
      `UPDATE app_users
          SET clerk_user_id = $1,
              email = COALESCE($2, email),
              name = COALESCE($3, name),
              platform_role = $4,
              last_seen_at = NOW()
        WHERE id = $5
        RETURNING *`,
      [identity.clerkUserId, identity.email, identity.name, nextRole, existing.id]
    );
    return updated.rows[0];
  }

  const inserted = await query(
    `INSERT INTO app_users (clerk_user_id, email, name, platform_role, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [identity.clerkUserId, identity.email, identity.name, platformRole]
  );
  return inserted.rows[0];
};

const roleCapabilities = (role) => {
  const normalized = role || 'viewer';
  const isSystemOwner = normalized === 'system_owner';
  const isAdmin = normalized === 'org_admin' || isSystemOwner;
  const isManager = MANAGER_ROLES.has(normalized) || isSystemOwner;
  const isWorkflow = WORKFLOW_ROLES.has(normalized) || isSystemOwner;
  return {
    can_access_admin: isSystemOwner,
    can_create_organizations: isSystemOwner,
    can_manage_subscription_plans: isSystemOwner,
    can_choose_subscription_plan: isSystemOwner || isAdmin,
    can_manage_organization: isAdmin,
    can_manage_users: isAdmin,
    can_manage_llm_credentials: isAdmin,
    can_view_compliance: isManager,
    can_manage_config: isAdmin,
    can_manage_contacts: isManager,
    can_review_leads: isWorkflow,
    can_update_lead_status: isWorkflow,
    can_view_tenant: READ_ROLES.has(normalized) || isSystemOwner
  };
};

const mapOrganization = (org) => ({
  id: org.id,
  name: org.name,
  slug: org.slug,
  status: org.status,
  timezone: org.timezone,
  current_user_role: org.current_user_role,
  subscription: {
    status: org.subscription_status || 'NONE',
    is_active: ['ACTIVE', 'TRIALING'].includes(org.subscription_status || ''),
    plan: org.plan_id ? {
      id: org.plan_id,
      name: org.plan_name,
      slug: org.plan_slug,
      monthly_price_cents: org.monthly_price_cents,
      currency_code: org.currency_code,
      max_monthly_ai_credits: org.max_monthly_ai_credits,
      max_monthly_messages: org.max_monthly_messages
    } : null
  },
  capabilities: roleCapabilities(org.current_user_role)
});

export const listAccessibleOrganizations = async (actor) => {
  if (!isSaaSMode()) {
    return [{
      id: 0,
      name: 'Local StayEZ',
      slug: 'local',
      status: 'ACTIVE',
      current_user_role: 'system_owner',
      subscription: {
        status: 'ACTIVE',
        is_active: true,
        plan: {
          id: 0,
          name: 'Local',
          slug: 'local',
          monthly_price_cents: 0,
          currency_code: 'USD',
          max_monthly_ai_credits: null,
          max_monthly_messages: null
        }
      },
      capabilities: roleCapabilities('system_owner')
    }];
  }

  if (actor.system_owner) {
    const result = await query(
      `SELECT o.id, o.name, o.slug, o.status, o.timezone, 'system_owner' AS current_user_role,
              s.status AS subscription_status,
              p.id AS plan_id,
              p.name AS plan_name,
              p.slug AS plan_slug,
              p.monthly_price_cents,
              p.currency_code,
              p.max_monthly_ai_credits,
              p.max_monthly_messages
         FROM organizations o
         LEFT JOIN organization_subscriptions s ON s.organization_id = o.id
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
        ORDER BY o.name ASC`
    );
    return result.rows.map(mapOrganization);
  }

  const result = await query(
    `SELECT o.id, o.name, o.slug, o.status, o.timezone, ou.role AS current_user_role,
            s.status AS subscription_status,
            p.id AS plan_id,
            p.name AS plan_name,
            p.slug AS plan_slug,
            p.monthly_price_cents,
            p.currency_code,
            p.max_monthly_ai_credits,
            p.max_monthly_messages
       FROM organizations o
       JOIN organization_users ou ON ou.organization_id = o.id
       LEFT JOIN organization_subscriptions s ON s.organization_id = o.id
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
      WHERE ou.user_id = $1
        AND ou.status = 'ACTIVE'
        AND o.status = 'ACTIVE'
      ORDER BY o.name ASC`,
    [actor.user.id]
  );
  return result.rows.map(mapOrganization);
};

const legacyActor = async (req) => {
  const expected = process.env.DASHBOARD_TOKEN;
  if (expected && tokenFromRequest(req) !== expected) {
    throw Object.assign(new Error('dashboard_token_required'), { statusCode: 401 });
  }
  return {
    auth_mode: 'legacy_token',
    system_owner: true,
    user: {
      id: 0,
      clerk_user_id: null,
      email: null,
      name: 'Dashboard Operator',
      platform_role: 'system_owner'
    }
  };
};

const clerkActor = async (req) => {
  const token = tokenFromRequest(req);
  if (!token) {
    throw Object.assign(new Error('authentication_required'), { statusCode: 401 });
  }
  const claims = await verifyJwt(token);
  if (!claims) {
    throw Object.assign(new Error('invalid_or_expired_token'), { statusCode: 401 });
  }
  if (!isSaaSMode()) {
    const identity = identityFromClaims(await enrichClaims(claims));
    return {
      auth_mode: 'clerk',
      system_owner: true,
      user: {
        id: 0,
        clerk_user_id: identity.clerkUserId,
        email: identity.email,
        name: identity.name || 'Dashboard Operator',
        platform_role: 'system_owner'
      }
    };
  }
  const user = await ensureAppUser(claims);
  return {
    auth_mode: 'clerk',
    system_owner: user.platform_role === 'system_owner',
    user: {
      id: user.id,
      clerk_user_id: user.clerk_user_id,
      email: user.email,
      name: user.name,
      platform_role: user.platform_role
    }
  };
};

export const getDashboardActor = async (req) => {
  if (process.env.CLERK_JWKS_URL) return clerkActor(req);
  if (process.env.DASHBOARD_REQUIRE_AUTH === 'true' && !process.env.DASHBOARD_TOKEN) {
    throw Object.assign(new Error('dashboard_auth_not_configured'), { statusCode: 500 });
  }
  return legacyActor(req);
};

export const requireSystemOwner = (actor) => {
  if (!actor?.system_owner) {
    throw Object.assign(new Error('system_owner_required'), { statusCode: 403 });
  }
};

export const requireOrganizationRole = async (actor, organizationId, allowedRoles = READ_ROLES) => {
  if (!isSaaSMode()) return { organization_id: 0, role: 'system_owner', system_owner: true };
  const orgId = Number(organizationId);
  if (!Number.isInteger(orgId) || orgId < 1) {
    throw Object.assign(new Error('organization_id_required'), { statusCode: 422 });
  }
  if (actor?.system_owner) {
    return { organization_id: orgId, role: 'system_owner', system_owner: true };
  }
  const result = await query(
    `SELECT role
       FROM organization_users
      WHERE user_id = $1
        AND organization_id = $2
        AND status = 'ACTIVE'`,
    [actor.user.id, orgId]
  );
  const role = result.rows[0]?.role;
  if (!role || !allowedRoles.has(role)) {
    throw Object.assign(new Error('organization_access_denied'), { statusCode: 403 });
  }
  return { organization_id: orgId, role, system_owner: false };
};

export const dashboardMe = async (actor) => {
  const organizations = await listAccessibleOrganizations(actor);
  return {
    user: actor.user,
    auth_mode: actor.auth_mode,
    system_owner: actor.system_owner,
    capabilities: roleCapabilities(actor.system_owner ? 'system_owner' : 'viewer'),
    organizations
  };
};

export { ADMIN_ROLES, MANAGER_ROLES, READ_ROLES, WORKFLOW_ROLES };
