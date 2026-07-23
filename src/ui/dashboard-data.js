import db from '../db/index.js';
import { query } from '../db/pg.js';
import {
  enforceCredentialCreatePolicy,
  getByokPolicy,
  normalizeCredentialProvider,
  providerDefaults,
  sanitizeCredential
} from '../llm/organization-credentials.js';
import { callAzureOpenAI } from '../llm/providers/azure-openai.js';
import { callGemini } from '../llm/providers/gemini.js';
import { callGroq } from '../llm/providers/groq.js';
import { callOpenAICompatible } from '../llm/providers/openai-compatible.js';
import { callOpenRouter } from '../llm/providers/openrouter.js';
import { decryptSecret, encryptSecret } from '../utils/secrets.js';
import { getWhatsAppSessionStatus } from '../agents/monitor.js';
import { listChannelRuntime } from '../db/channel-runtime.js';
import { ensureTenantChannelColumns } from '../db/tenant.js';

const isSaaSMode = () => !!process.env.DATABASE_URL;
const DEFAULT_CLASSIFIER_SYSTEM_PROMPT = 'Classify inbound messages for this tenant. Treat a message as a lead only when it shows real buying, booking, inquiry, support, or service intent for this tenant business. Return valid JSON using the required schema.';
const DEFAULT_KEYWORD_WHITELIST = ['quote', 'demo', 'booking', 'looking for', 'need', 'interested', 'price'];
const DEFAULT_KEYWORD_BLACKLIST = ['job', 'vacancy', 'spam', 'unrelated', 'http'];

const parseJson = (value, fallback = null) => {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const firstRow = (rows, fallback = {}) => rows?.[0] || fallback;

const mapLead = (lead) => ({
  id: lead.id,
  organization_id: lead.organization_id || 0,
  organization_name: lead.organization_name || 'Local StayEZ',
  source_type: lead.source_type,
  source_platform: lead.source_platform || 'whatsapp',
  source_channel: lead.source_channel || null,
  source_name: lead.source_name || lead.source_group_name || null,
  sender_name: lead.sender_name || 'Unknown',
  sender_number: lead.sender_number,
  raw_message: lead.raw_message,
  detected_language: lead.detected_language || null,
  extracted_data: parseJson(lead.extracted_data, null) || {
    location: lead.location,
    check_in: lead.check_in,
    check_out: lead.check_out,
    guests: lead.guests,
    budget: lead.budget,
    special_notes: lead.special_notes
  },
  classifier_confidence: Number(lead.classifier_confidence || 0),
  contactability_status: lead.contactability_status || 'unknown',
  status: lead.status || 'pending',
  matched_items: parseJson(lead.matched_items, null) || parseJson(lead.matched_property_ids, []),
  draft_to_client: parseJson(lead.draft_to_client, null),
  draft_to_source: parseJson(lead.draft_to_source, null) || parseJson(lead.draft_to_matched_host, null),
  drafts_to_contacts: parseJson(lead.drafts_to_contacts, null) || parseJson(lead.drafts_to_nearby_hosts, []),
  created_at: lead.created_at,
  updated_at: lead.updated_at
});

const emptyUsage = {
  ai_credits: 0,
  llm_cost_usd: 0,
  llm_tokens: 0,
  requests: 0,
  avg_latency_ms: 0,
  fallback_count: 0
};

const ensureSaaSMode = (message = 'This feature requires DATABASE_URL SaaS mode.') => {
  if (!isSaaSMode()) {
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
};

const boolToInt = (value) => value === true || value === 'true' || value === 1 || value === '1' ? 1 : 0;

const optionalInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const cleanSlug = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const emitPlatformEvent = async (eventType, actor, metadata = {}, organizationId = null) => {
  if (!isSaaSMode()) return;
  await query(
    `INSERT INTO platform_usage_events (organization_id, user_id, event_type, quantity, metadata)
     VALUES ($1, $2, $3, 1, $4)`,
    [
      organizationId,
      actor?.user?.id && actor.user.id !== 0 ? actor.user.id : null,
      eventType,
      JSON.stringify(metadata)
    ]
  );
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const isoForDb = (date) => date.toISOString();

const getPlanById = async (planId) => {
  const result = await query('SELECT * FROM subscription_plans WHERE id = $1', [Number(planId)]);
  if (result.rowCount === 0) {
    throw Object.assign(new Error('Subscription plan not found.'), { statusCode: 404 });
  }
  return mapPlan(result.rows[0]);
};

const getDefaultPlan = async () => {
  const result = await query(
    `SELECT * FROM subscription_plans
      WHERE active = 1
      ORDER BY CASE WHEN slug = 'starter' THEN 0 ELSE 1 END, monthly_price_cents ASC, id ASC
      LIMIT 1`
  );
  return result.rows[0] ? mapPlan(result.rows[0]) : null;
};

const ensureBillingPeriodSnapshot = async (organizationId, subscription, plan) => {
  const periodStart = subscription.current_period_started_at || isoForDb(new Date());
  const periodEnd = subscription.current_period_ends_at || isoForDb(addDays(new Date(periodStart), 30));
  const result = await query(
    `INSERT INTO organization_billing_periods (
       organization_id, subscription_id, plan_id, period_start, period_end,
       included_ai_credits, included_messages, included_users,
       overage_allowed, overage_price_cents_per_ai_credit, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id, period_start, period_end) DO UPDATE SET
       subscription_id = EXCLUDED.subscription_id,
       plan_id = EXCLUDED.plan_id,
       included_ai_credits = EXCLUDED.included_ai_credits,
       included_messages = EXCLUDED.included_messages,
       included_users = EXCLUDED.included_users,
       overage_allowed = EXCLUDED.overage_allowed,
       overage_price_cents_per_ai_credit = EXCLUDED.overage_price_cents_per_ai_credit,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      Number(organizationId),
      subscription.id || null,
      plan.id,
      periodStart,
      periodEnd,
      plan.max_monthly_ai_credits,
      plan.max_monthly_messages,
      plan.max_users,
      boolToInt(plan.overage_allowed),
      plan.overage_price_cents_per_ai_credit || null
    ]
  );
  return result.rows[0];
};

const mapPlan = (plan) => ({
  ...plan,
  active: Boolean(plan.active),
  overage_allowed: Boolean(plan.overage_allowed),
  allow_byok: Boolean(plan.allow_byok),
  allowed_llm_routing_modes: String(plan.allowed_llm_routing_modes || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  trial_allowed_llm_routing_modes: String(plan.trial_allowed_llm_routing_modes || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
});

const subscriptionSelect = `
  s.*,
  p.name AS plan_name,
  p.slug AS plan_slug,
  p.description AS plan_description,
  p.monthly_price_cents AS plan_monthly_price_cents,
  p.currency_code AS plan_currency_code,
  p.market_code AS plan_market_code,
  p.trial_days AS plan_trial_days,
  p.max_users AS plan_max_users,
  p.max_monthly_messages AS plan_max_monthly_messages,
  p.max_monthly_ai_tokens AS plan_max_monthly_ai_tokens,
  p.max_monthly_ai_credits AS plan_max_monthly_ai_credits,
  p.overage_allowed AS plan_overage_allowed,
  p.allow_byok AS plan_allow_byok,
  p.byok_provider_mode AS plan_byok_provider_mode,
  p.max_llm_credentials AS plan_max_llm_credentials,
  p.allowed_llm_routing_modes AS plan_allowed_llm_routing_modes,
  p.default_llm_routing_mode AS plan_default_llm_routing_mode,
  p.trial_allowed_llm_routing_modes AS plan_trial_allowed_llm_routing_modes
`;

const mapSubscription = (row) => {
  if (!row) {
    return { status: 'NONE', is_active: false, plan: null };
  }
  return {
    id: row.id,
    organization_id: row.organization_id,
    status: row.status,
    is_active: ['ACTIVE', 'TRIALING'].includes(row.status),
    trial_ends_at: row.trial_ends_at,
    current_period_started_at: row.current_period_started_at,
    current_period_ends_at: row.current_period_ends_at,
    plan: row.plan_id ? mapPlan({
      id: row.plan_id,
      name: row.plan_name,
      slug: row.plan_slug,
      description: row.plan_description,
      monthly_price_cents: row.plan_monthly_price_cents,
      currency_code: row.plan_currency_code,
      market_code: row.plan_market_code,
      trial_days: row.plan_trial_days,
      max_users: row.plan_max_users,
      max_monthly_messages: row.plan_max_monthly_messages,
      max_monthly_ai_tokens: row.plan_max_monthly_ai_tokens,
      max_monthly_ai_credits: row.plan_max_monthly_ai_credits,
      overage_allowed: row.plan_overage_allowed,
      allow_byok: row.plan_allow_byok,
      byok_provider_mode: row.plan_byok_provider_mode,
      max_llm_credentials: row.plan_max_llm_credentials,
      allowed_llm_routing_modes: row.plan_allowed_llm_routing_modes,
      default_llm_routing_mode: row.plan_default_llm_routing_mode,
      trial_allowed_llm_routing_modes: row.plan_trial_allowed_llm_routing_modes,
      active: 1
    }) : null
  };
};

export async function getAdminOverview() {
  if (!isSaaSMode()) {
    const leadStats = db.prepare(`
      SELECT
        COUNT(*) AS total_leads,
        SUM(CASE WHEN status IN ('ready','delivered') THEN 1 ELSE 0 END) AS ready_leads,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_leads,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_leads
      FROM leads
    `).get();
    const contacts = db.prepare('SELECT COUNT(*) AS total_contacts FROM local_hosts').get();
    const recentLeads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 12').all().map(mapLead);

    return {
      mode: 'local',
      organizations: { total: 1, active: 1, suspended: 0 },
      leads: leadStats,
      contacts,
      usage: emptyUsage,
      recent_leads: recentLeads,
      organizations_table: [{
        id: 0,
        name: 'Local StayEZ',
        slug: 'local',
        status: 'ACTIVE',
        plan_name: 'Local',
        lead_count: Number(leadStats.total_leads || 0),
        created_at: null
      }]
    };
  }

  const [orgs, leads, contacts, usage, recent, orgTable] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                  COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended
           FROM organizations`),
    query(`SELECT COUNT(*)::int AS total_leads,
                  COUNT(*) FILTER (WHERE status IN ('ready','delivered'))::int AS ready_leads,
                  COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_leads,
                  COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_leads
           FROM leads`),
    query('SELECT COUNT(*)::int AS total_contacts FROM contacts'),
    query(`SELECT
             COALESCE(SUM(a.credits_used), 0)::int AS ai_credits,
             COALESCE(SUM(l.estimated_cost_usd), 0)::float AS llm_cost_usd,
             COALESCE(SUM(l.total_tokens), 0)::int AS llm_tokens,
             COALESCE(SUM(l.request_count), 0)::int AS requests,
             COALESCE(AVG(NULLIF(l.latency_ms, 0)), 0)::float AS avg_latency_ms,
             COALESCE(SUM(l.fallback_triggered), 0)::int AS fallback_count
           FROM llm_usage_events l
           FULL OUTER JOIN ai_usage_actions a
             ON a.organization_id = l.organization_id
            AND a.created_at::date = l.created_at::date
           WHERE COALESCE(l.created_at, a.created_at) >= NOW() - INTERVAL '30 days'`),
    query(`SELECT l.*, o.name AS organization_name
           FROM leads l
           JOIN organizations o ON o.id = l.organization_id
           ORDER BY l.created_at DESC
           LIMIT 12`),
    query(`SELECT o.id, o.name, o.slug, o.status, o.created_at,
                  p.name AS plan_name,
                  COUNT(l.id)::int AS lead_count
           FROM organizations o
           LEFT JOIN organization_subscriptions s ON s.organization_id = o.id
           LEFT JOIN subscription_plans p ON p.id = s.plan_id
           LEFT JOIN leads l ON l.organization_id = o.id
           GROUP BY o.id, p.name
           ORDER BY o.created_at DESC`)
  ]);

  return {
    mode: 'saas',
    organizations: firstRow(orgs.rows, { total: 0, active: 0, suspended: 0 }),
    leads: firstRow(leads.rows, { total_leads: 0, ready_leads: 0, processing_leads: 0, pending_leads: 0 }),
    contacts: firstRow(contacts.rows, { total_contacts: 0 }),
    usage: firstRow(usage.rows, emptyUsage),
    recent_leads: recent.rows.map(mapLead),
    organizations_table: orgTable.rows
  };
}

export async function listOrganizations() {
  if (!isSaaSMode()) {
    return [{ id: 0, name: 'Local StayEZ', slug: 'local', status: 'ACTIVE' }];
  }
  const result = await query('SELECT id, name, slug, status, timezone, created_at FROM organizations ORDER BY name ASC');
  return result.rows;
}

export async function listSubscriptionPlans(actor) {
  if (!isSaaSMode()) {
    return [{
      id: 0,
      name: 'Local',
      slug: 'local',
      description: 'Local SQLite development mode',
      monthly_price_cents: 0,
      currency_code: 'USD',
      market_code: 'LOCAL',
      trial_days: 0,
      max_users: null,
      max_monthly_messages: null,
      max_monthly_ai_tokens: null,
      max_monthly_ai_credits: null,
      overage_allowed: false,
      allow_byok: false,
      byok_provider_mode: 'platform_first',
      max_llm_credentials: null,
      allowed_llm_routing_modes: ['environment'],
      default_llm_routing_mode: 'environment',
      trial_allowed_llm_routing_modes: [],
      active: true
    }];
  }
  const ownerFilter = actor?.system_owner ? '' : 'WHERE active = 1';
  const result = await query(`SELECT * FROM subscription_plans ${ownerFilter} ORDER BY monthly_price_cents ASC, id ASC`);
  return result.rows.map(mapPlan);
}

export async function createSubscriptionPlan(input, actor) {
  ensureSaaSMode('Subscription plans require DATABASE_URL SaaS mode.');
  if (!actor?.system_owner) {
    throw Object.assign(new Error('system_owner_required'), { statusCode: 403 });
  }
  const name = String(input.name || '').trim();
  const slug = cleanSlug(input.slug || name);
  if (!name || !slug) {
    throw Object.assign(new Error('name and slug are required.'), { statusCode: 422 });
  }
  const result = await query(
    `INSERT INTO subscription_plans (
       name, slug, description, monthly_price_cents, currency_code, market_code, trial_days,
       max_users, max_monthly_messages, max_monthly_ai_tokens, max_monthly_ai_credits,
       overage_allowed, overage_price_cents_per_ai_credit, allow_byok, byok_provider_mode,
       max_llm_credentials, allowed_llm_routing_modes, default_llm_routing_mode,
       trial_allowed_llm_routing_modes, active, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      name,
      slug,
      input.description || null,
      Number(input.monthly_price_cents || 0),
      String(input.currency_code || 'USD').toUpperCase(),
      String(input.market_code || 'GLOBAL').toUpperCase(),
      Number(input.trial_days || 14),
      optionalInt(input.max_users),
      optionalInt(input.max_monthly_messages),
      optionalInt(input.max_monthly_ai_tokens),
      optionalInt(input.max_monthly_ai_credits),
      boolToInt(input.overage_allowed),
      optionalInt(input.overage_price_cents_per_ai_credit),
      boolToInt(input.allow_byok),
      input.byok_provider_mode || 'platform_first',
      optionalInt(input.max_llm_credentials),
      Array.isArray(input.allowed_llm_routing_modes) ? input.allowed_llm_routing_modes.join(',') : input.allowed_llm_routing_modes || 'cost_optimized,balanced,quality_first',
      input.default_llm_routing_mode || 'balanced',
      Array.isArray(input.trial_allowed_llm_routing_modes) ? input.trial_allowed_llm_routing_modes.join(',') : input.trial_allowed_llm_routing_modes || 'cost_optimized',
      boolToInt(input.active ?? true)
    ]
  );
  await emitPlatformEvent('subscription_plan_created', actor, { plan_id: result.rows[0].id, slug });
  return mapPlan(result.rows[0]);
}

export async function updateSubscriptionPlan(planId, input, actor) {
  ensureSaaSMode('Subscription plans require DATABASE_URL SaaS mode.');
  if (!actor?.system_owner) {
    throw Object.assign(new Error('system_owner_required'), { statusCode: 403 });
  }
  const result = await query(
    `UPDATE subscription_plans
        SET name = COALESCE($2, name),
            description = $3,
            monthly_price_cents = COALESCE($4, monthly_price_cents),
            active = COALESCE($5, active),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
    [
      Number(planId),
      input.name ? String(input.name).trim() : null,
      input.description ?? null,
      input.monthly_price_cents !== undefined ? Number(input.monthly_price_cents || 0) : null,
      input.active !== undefined ? boolToInt(input.active) : null
    ]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error('Subscription plan not found.'), { statusCode: 404 });
  }
  await emitPlatformEvent('subscription_plan_updated', actor, { plan_id: Number(planId), fields: Object.keys(input || {}) });
  return mapPlan(result.rows[0]);
}

export async function getOrganizationSubscription(organizationId) {
  ensureSaaSMode('Organization subscriptions require DATABASE_URL SaaS mode.');
  const result = await query(
    `SELECT ${subscriptionSelect}
       FROM organization_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.organization_id = $1`,
    [Number(organizationId)]
  );
  return mapSubscription(result.rows[0]);
}

export async function upsertOrganizationSubscription(organizationId, input, actor) {
  ensureSaaSMode('Organization subscriptions require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  const planId = Number(input.plan_id);
  if (!planId) {
    throw Object.assign(new Error('plan_id is required.'), { statusCode: 422 });
  }
  const plan = await getPlanById(planId);
  const status = input.status || 'ACTIVE';
  const currentPeriodStartedAt = input.current_period_started_at || isoForDb(new Date());
  const currentPeriodEndsAt = input.current_period_ends_at || isoForDb(addDays(new Date(currentPeriodStartedAt), 30));
  await query(
    `INSERT INTO organization_subscriptions (
       organization_id, plan_id, status, trial_ends_at, current_period_started_at, current_period_ends_at, updated_at
     ) VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_TIMESTAMP),$6,CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       status = EXCLUDED.status,
       trial_ends_at = EXCLUDED.trial_ends_at,
       current_period_started_at = COALESCE(EXCLUDED.current_period_started_at, organization_subscriptions.current_period_started_at),
       current_period_ends_at = EXCLUDED.current_period_ends_at,
       updated_at = CURRENT_TIMESTAMP`,
    [
      orgId,
      planId,
      status,
      input.trial_ends_at || null,
      currentPeriodStartedAt,
      currentPeriodEndsAt
    ]
  );
  await emitPlatformEvent('organization_subscription_updated', actor, { organization_id: orgId, plan_id: planId, status }, orgId);
  const subscription = await getOrganizationSubscription(orgId);
  const billingPeriod = await ensureBillingPeriodSnapshot(orgId, {
    ...subscription,
    current_period_started_at: currentPeriodStartedAt,
    current_period_ends_at: currentPeriodEndsAt
  }, plan);
  return { ...subscription, billing_period: billingPeriod };
}

export async function createOrganization(input, actor = null) {
  if (!isSaaSMode()) {
    throw Object.assign(new Error('Organizations require DATABASE_URL SaaS mode.'), { statusCode: 400 });
  }
  await ensureTenantChannelColumns();

  const name = String(input.name || '').trim();
  const slug = cleanSlug(input.slug || name);
  const waSessionId = String(input.wa_session_id || slug || '').trim();
  const telegramToken = String(input.telegram_bot_token_secret || '').trim();
  const telegramChatId = String(input.telegram_chat_id || '').trim();
  const ownerEmail = String(input.owner_email || '').trim().toLowerCase();
  const planId = Number(input.plan_id);

  if (!name || !slug || !waSessionId || !telegramToken || !telegramChatId || !ownerEmail || !planId) {
    throw Object.assign(new Error('name, slug, owner_email, plan_id, wa_session_id, telegram_bot_token_secret, and telegram_chat_id are required.'), { statusCode: 422 });
  }

  const plan = await getPlanById(planId);
  const now = new Date();
  const trialDays = Number(plan?.trial_days || 0);
  const status = input.subscription_status || (trialDays > 0 ? 'TRIALING' : 'ACTIVE');
  const currentPeriodStartedAt = isoForDb(now);
  const currentPeriodEndsAt = isoForDb(addDays(now, 30));
  const trialEndsAt = status === 'TRIALING' ? isoForDb(addDays(now, trialDays || 14)) : null;

  const org = await query(
    `INSERT INTO organizations (name, slug, timezone, status)
     VALUES ($1, $2, $3, 'ACTIVE')
     RETURNING id, name, slug, status, timezone, created_at`,
    [name, slug, input.timezone || 'Africa/Nairobi']
  );
  const orgId = org.rows[0].id;

  await query(
    `INSERT INTO tenant_configs (
       organization_id, wa_session_id, telegram_bot_token_secret, telegram_chat_id,
       meta_access_token_secret, wc_base_url, wc_consumer_key_secret, wc_consumer_secret_secret,
       whatsapp_cloud_enabled, whatsapp_cloud_phone_number_id, whatsapp_cloud_waba_id,
       whatsapp_cloud_display_number, whatsapp_cloud_access_token_secret,
       classifier_system_prompt, keyword_whitelist, keyword_blacklist, drafter_persona,
       default_language, llm_routing_mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      orgId,
      waSessionId,
      telegramToken,
      telegramChatId,
      input.meta_access_token_secret || null,
      input.wc_base_url || null,
      input.wc_consumer_key_secret || null,
      input.wc_consumer_secret_secret || null,
      boolToInt(input.whatsapp_cloud_enabled),
      input.whatsapp_cloud_phone_number_id || null,
      input.whatsapp_cloud_waba_id || null,
      input.whatsapp_cloud_display_number || null,
      input.whatsapp_cloud_access_token_secret || null,
      input.classifier_system_prompt || DEFAULT_CLASSIFIER_SYSTEM_PROMPT,
      JSON.stringify(input.keyword_whitelist?.length ? input.keyword_whitelist : DEFAULT_KEYWORD_WHITELIST),
      JSON.stringify(input.keyword_blacklist?.length ? input.keyword_blacklist : DEFAULT_KEYWORD_BLACKLIST),
      input.drafter_persona || 'You are a concise, helpful sales assistant.',
      input.default_language || 'en',
      input.llm_routing_mode || 'balanced'
    ]
  );

  const ownerUsers = await upsertOrganizationUser(orgId, {
    email: ownerEmail,
    role: 'org_admin',
    status: 'ACTIVE'
  }, actor);

  await query(
    `INSERT INTO organization_subscriptions (
       organization_id, plan_id, status, trial_ends_at, current_period_started_at, current_period_ends_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       status = EXCLUDED.status,
       trial_ends_at = EXCLUDED.trial_ends_at,
       current_period_started_at = EXCLUDED.current_period_started_at,
       current_period_ends_at = EXCLUDED.current_period_ends_at,
       updated_at = CURRENT_TIMESTAMP`,
    [orgId, plan.id, status, trialEndsAt, currentPeriodStartedAt, currentPeriodEndsAt]
  );
  const subscription = await getOrganizationSubscription(orgId);
  const billingPeriod = await ensureBillingPeriodSnapshot(orgId, {
    ...subscription,
    current_period_started_at: currentPeriodStartedAt,
    current_period_ends_at: currentPeriodEndsAt
  }, plan);

  await emitPlatformEvent('organization_created', actor, {
    organization_id: orgId,
    slug,
    owner_email: ownerEmail,
    plan_id: plan.id,
    subscription_status: status,
    billing_period_id: billingPeriod.id,
    telegram_configured: Boolean(telegramToken && telegramChatId),
    meta_configured: Boolean(input.meta_access_token_secret),
    wc_configured: Boolean(input.wc_base_url && input.wc_consumer_key_secret && input.wc_consumer_secret_secret)
  }, orgId);

  return {
    ...org.rows[0],
    owner_user: ownerUsers.find((user) => String(user.email).toLowerCase() === ownerEmail) || null,
    subscription,
    billing_period: billingPeriod
  };
}

export async function updateOrganization(organizationId, input, actor) {
  ensureSaaSMode('Organization updates require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  const allowedStatuses = new Set(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
  const status = input.status && allowedStatuses.has(input.status) ? input.status : null;
  const result = await query(
    `UPDATE organizations
        SET name = COALESCE($2, name),
            slug = COALESCE($3, slug),
            timezone = COALESCE($4, timezone),
            status = COALESCE($5, status)
      WHERE id = $1
      RETURNING id, name, slug, status, timezone, created_at`,
    [
      orgId,
      input.name ? String(input.name).trim() : null,
      input.slug ? cleanSlug(input.slug) : null,
      input.timezone || null,
      status
    ]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error('Organization not found.'), { statusCode: 404 });
  }
  await emitPlatformEvent('organization_updated', actor, { organization_id: orgId, fields: Object.keys(input || {}) }, orgId);
  return result.rows[0];
}

export async function listOrganizationUsers(organizationId) {
  ensureSaaSMode('Organization users require DATABASE_URL SaaS mode.');
  const result = await query(
    `SELECT u.id, u.email, u.name, u.platform_role, ou.organization_id, ou.role, ou.status, ou.created_at
       FROM organization_users ou
       JOIN app_users u ON u.id = ou.user_id
      WHERE ou.organization_id = $1
      ORDER BY ou.created_at DESC`,
    [Number(organizationId)]
  );
  return result.rows;
}

export async function upsertOrganizationUser(organizationId, input, actor) {
  ensureSaaSMode('Organization users require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  const email = String(input.email || '').trim().toLowerCase();
  const role = input.role || 'viewer';
  const status = input.status || 'ACTIVE';
  const allowedRoles = new Set(['org_admin', 'sales_manager', 'sales_user', 'viewer']);
  const allowedStatuses = new Set(['ACTIVE', 'INVITED', 'DISABLED']);
  if (!email || !allowedRoles.has(role) || !allowedStatuses.has(status)) {
    throw Object.assign(new Error('email, valid role, and valid status are required.'), { statusCode: 422 });
  }

  let userResult = await query('SELECT * FROM app_users WHERE lower(email) = lower($1)', [email]);
  if (userResult.rowCount === 0) {
    userResult = await query(
      `INSERT INTO app_users (clerk_user_id, email, name, platform_role)
       VALUES ($1, $2, $3, 'user')
       RETURNING *`,
      [`pending:${email}`, email, input.name || null]
    );
  }
  const user = userResult.rows[0];
  await query(
    `INSERT INTO organization_users (organization_id, user_id, role, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       status = EXCLUDED.status`,
    [orgId, user.id, role, status]
  );
  await emitPlatformEvent('organization_user_upserted', actor, { organization_id: orgId, email, role, status }, orgId);
  return listOrganizationUsers(orgId);
}

export async function listOrganizationLlmCredentials(organizationId) {
  ensureSaaSMode('Organization LLM credentials require DATABASE_URL SaaS mode.');
  const result = await query(
    `SELECT id, organization_id, provider, label, status, api_key_secret, base_url, azure_endpoint,
            azure_deployment, azure_api_version, default_model, created_by_user_id,
            last_used_at, last_tested_at, last_error, created_at, updated_at
       FROM organization_llm_credentials
      WHERE organization_id = $1
      ORDER BY created_at DESC`,
    [Number(organizationId)]
  );
  const policy = await getByokPolicy(Number(organizationId));
  return { policy, credentials: result.rows.map(sanitizeCredential) };
}

export async function createOrganizationLlmCredential(organizationId, input, actor) {
  ensureSaaSMode('Organization LLM credentials require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  await enforceCredentialCreatePolicy(orgId);
  const provider = normalizeCredentialProvider(input.provider);
  const label = String(input.label || provider.replace('_', ' ')).trim().slice(0, 120);
  const apiKey = String(input.api_key_secret || '').trim();
  if (!provider || !label || !apiKey) {
    throw Object.assign(new Error('provider, label, and api_key_secret are required.'), { statusCode: 422 });
  }
  const fields = providerDefaults(provider, input);
  const result = await query(
    `INSERT INTO organization_llm_credentials (
       organization_id, provider, label, api_key_secret, base_url, azure_endpoint,
       azure_deployment, azure_api_version, default_model, created_by_user_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
     RETURNING id`,
    [
      orgId,
      provider,
      label,
      encryptSecret(apiKey),
      fields.base_url,
      fields.azure_endpoint,
      fields.azure_deployment,
      fields.azure_api_version,
      fields.default_model,
      actor?.user?.id && actor.user.id !== 0 ? actor.user.id : null
    ]
  );
  await emitPlatformEvent('organization_llm_credential_created', actor, { organization_id: orgId, credential_id: result.rows[0].id, provider, label }, orgId);
  return listOrganizationLlmCredentials(orgId);
}

export async function updateOrganizationLlmCredential(organizationId, credentialId, input, actor) {
  ensureSaaSMode('Organization LLM credentials require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  const existingResult = await query(
    `SELECT * FROM organization_llm_credentials WHERE organization_id = $1 AND id = $2`,
    [orgId, Number(credentialId)]
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    throw Object.assign(new Error('LLM credential not found.'), { statusCode: 404 });
  }
  const fields = providerDefaults(existing.provider, { ...existing, ...input });
  const result = await query(
    `UPDATE organization_llm_credentials
        SET status = COALESCE($3, status),
            label = COALESCE($4, label),
            api_key_secret = COALESCE($5, api_key_secret),
            default_model = COALESCE($6, default_model),
            base_url = COALESCE($7, base_url),
            azure_endpoint = COALESCE($8, azure_endpoint),
            azure_deployment = COALESCE($9, azure_deployment),
            azure_api_version = COALESCE($10, azure_api_version),
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = $1 AND id = $2
      RETURNING id`,
    [
      orgId,
      Number(credentialId),
      input.status || null,
      input.label || null,
      input.api_key_secret ? encryptSecret(input.api_key_secret) : null,
      input.default_model ? fields.default_model : null,
      Object.prototype.hasOwnProperty.call(input, 'base_url') ? fields.base_url : null,
      Object.prototype.hasOwnProperty.call(input, 'azure_endpoint') ? fields.azure_endpoint : null,
      Object.prototype.hasOwnProperty.call(input, 'azure_deployment') ? fields.azure_deployment : null,
      Object.prototype.hasOwnProperty.call(input, 'azure_api_version') ? fields.azure_api_version : null
    ]
  );
  if (result.rowCount === 0) {
    throw Object.assign(new Error('LLM credential not found.'), { statusCode: 404 });
  }
  await emitPlatformEvent('organization_llm_credential_updated', actor, { organization_id: orgId, credential_id: Number(credentialId), fields: Object.keys(input || {}) }, orgId);
  return listOrganizationLlmCredentials(orgId);
}

const credentialProviderFn = (provider) => {
  if (provider === 'azure_openai') return callAzureOpenAI;
  if (provider === 'gemini') return callGemini;
  if (provider === 'groq') return callGroq;
  if (provider === 'openrouter') return callOpenRouter;
  if (provider === 'openai' || provider === 'cerebras') return callOpenAICompatible;
  return null;
};

const friendlyCredentialError = (error) => {
  const message = String(error?.message || error || 'Unknown provider error');
  const lowered = message.toLowerCase();
  if (lowered.includes('quota') || lowered.includes('billing') || lowered.includes('insufficient')) {
    return `Provider quota/billing issue: ${message}`;
  }
  if (lowered.includes('invalid') || lowered.includes('auth') || lowered.includes('unauthorized') || lowered.includes('401')) {
    return `Authentication failed: ${message}`;
  }
  if (lowered.includes('rate') || lowered.includes('429') || lowered.includes('too many requests')) {
    return `Provider rate limit reached: ${message}`;
  }
  if (lowered.includes('model') && (lowered.includes('not found') || lowered.includes('does not exist') || lowered.includes('unsupported'))) {
    return `Model is not available for this credential: ${message}`;
  }
  return message;
};

export async function testOrganizationLlmCredential(organizationId, credentialId, actor) {
  ensureSaaSMode('Organization LLM credentials require DATABASE_URL SaaS mode.');
  const orgId = Number(organizationId);
  const id = Number(credentialId);
  const existingResult = await query(
    `SELECT * FROM organization_llm_credentials WHERE organization_id = $1 AND id = $2`,
    [orgId, id]
  );
  const credential = existingResult.rows[0];
  if (!credential) {
    throw Object.assign(new Error('LLM credential not found.'), { statusCode: 404 });
  }

  const provider = normalizeCredentialProvider(credential.provider);
  const fields = providerDefaults(provider, credential);
  const fn = credentialProviderFn(provider);
  if (!fn) {
    throw Object.assign(new Error('Unsupported LLM provider.'), { statusCode: 422 });
  }

  const started = Date.now();
  let status = 'passed';
  let message = '';
  let sample = null;
  let lastError = null;
  let latencyMs = null;

  try {
    const text = await fn(
      'Reply with exactly OK.',
      'You are validating API connectivity for a tenant LLM credential.',
      false,
      fields.default_model,
      { ...fields, api_key: decryptSecret(credential.api_key_secret) }
    );
    latencyMs = Date.now() - started;
    sample = String(text || '').trim().slice(0, 120);
    if (!sample) {
      throw new Error('provider returned an empty response during the test');
    }
    message = `Credential test succeeded via ${provider} model ${fields.default_model}.`;
  } catch (error) {
    status = 'failed';
    latencyMs = Date.now() - started;
    lastError = friendlyCredentialError(error);
    message = `Credential test failed: ${lastError}`;
  }

  await query(
    `UPDATE organization_llm_credentials
        SET last_tested_at = CURRENT_TIMESTAMP,
            last_error = $3,
            updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = $1 AND id = $2`,
    [orgId, id, lastError]
  );
  await emitPlatformEvent('organization_llm_credential_tested', actor, {
    organization_id: orgId,
    credential_id: id,
    provider,
    status,
    latency_ms: latencyMs
  }, orgId);

  return {
    status,
    message,
    latency_ms: latencyMs,
    sample,
    credentials: await listOrganizationLlmCredentials(orgId)
  };
}

export async function listComplianceEvents(input = {}) {
  if (!isSaaSMode()) {
    return [];
  }
  const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
  const organizationId = input.organization_id ? Number(input.organization_id) : null;
  const params = [];
  const where = [];
  if (organizationId) {
    params.push(organizationId);
    where.push(`e.organization_id = $${params.length}`);
  }
  params.push(limit);
  const result = await query(
    `SELECT e.id, e.organization_id, o.name AS organization_name, e.user_id, u.email AS user_email,
            e.event_type, e.quantity, e.source_object_type, e.source_object_id,
            e.metadata, e.created_at
       FROM platform_usage_events e
       LEFT JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN app_users u ON u.id = e.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((event) => ({
    ...event,
    metadata: parseJson(event.metadata, {})
  }));
}

export async function getTenantDashboard(organizationId) {
  const orgId = Number(organizationId || 0);

  if (!isSaaSMode()) {
    const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 50').all().map(mapLead);
    const contacts = db.prepare('SELECT id, name, whatsapp_number, region, sub_area, unit_types AS tags, notes, source, created_at FROM local_hosts ORDER BY created_at DESC LIMIT 50').all();
    return {
      mode: 'local',
      organization: { id: 0, name: 'Local StayEZ', slug: 'local', status: 'ACTIVE' },
      config: { llm_routing_mode: 'environment', default_language: 'en' },
      stats: {
        total_leads: leads.length,
        ready_leads: leads.filter((lead) => ['ready', 'delivered'].includes(lead.status)).length,
        contacts: contacts.length,
        manual_required: leads.filter((lead) => lead.contactability_status !== 'direct_contact_available').length
      },
      usage: emptyUsage,
      leads,
      contacts
    };
  }

  await ensureTenantChannelColumns();
  const [org, config, stats, usage, leads, contacts] = await Promise.all([
    query('SELECT id, name, slug, status, timezone, created_at FROM organizations WHERE id = $1', [orgId]),
    query(`SELECT wa_session_id, telegram_chat_id, wc_base_url,
                  whatsapp_cloud_enabled, whatsapp_cloud_phone_number_id,
                  whatsapp_cloud_waba_id, whatsapp_cloud_display_number,
                  CASE WHEN telegram_bot_token_secret IS NULL OR telegram_bot_token_secret = '' THEN false ELSE true END AS telegram_bot_token_configured,
                  CASE WHEN wc_consumer_key_secret IS NULL OR wc_consumer_key_secret = '' THEN false ELSE true END AS wc_consumer_key_configured,
                  CASE WHEN wc_consumer_secret_secret IS NULL OR wc_consumer_secret_secret = '' THEN false ELSE true END AS wc_consumer_secret_configured,
                  CASE WHEN meta_access_token_secret IS NULL OR meta_access_token_secret = '' THEN false ELSE true END AS meta_access_token_configured,
                  CASE WHEN whatsapp_cloud_access_token_secret IS NULL OR whatsapp_cloud_access_token_secret = '' THEN false ELSE true END AS whatsapp_cloud_access_token_configured,
                  default_language, llm_routing_mode,
                  classifier_system_prompt, keyword_whitelist, keyword_blacklist, drafter_persona, updated_at
           FROM tenant_configs WHERE organization_id = $1`, [orgId]),
    query(`SELECT COUNT(*)::int AS total_leads,
                  COUNT(*) FILTER (WHERE status IN ('ready','delivered'))::int AS ready_leads,
                  COUNT(*) FILTER (WHERE contactability_status <> 'direct_contact_available')::int AS manual_required
           FROM leads WHERE organization_id = $1`, [orgId]),
    query(`SELECT COALESCE(SUM(a.credits_used), 0)::int AS ai_credits,
                  COALESCE(SUM(l.estimated_cost_usd), 0)::float AS llm_cost_usd,
                  COALESCE(SUM(l.total_tokens), 0)::int AS llm_tokens,
                  COALESCE(SUM(l.request_count), 0)::int AS requests,
                  COALESCE(AVG(NULLIF(l.latency_ms, 0)), 0)::float AS avg_latency_ms,
                  COALESCE(SUM(l.fallback_triggered), 0)::int AS fallback_count
           FROM llm_usage_events l
           FULL OUTER JOIN ai_usage_actions a
             ON a.organization_id = l.organization_id
            AND a.created_at::date = l.created_at::date
           WHERE COALESCE(l.organization_id, a.organization_id) = $1
             AND COALESCE(l.created_at, a.created_at) >= NOW() - INTERVAL '30 days'`, [orgId]),
    query('SELECT * FROM leads WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50', [orgId]),
    query('SELECT id, name, whatsapp_number, region, sub_area, tags, notes, source, created_at FROM contacts WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50', [orgId])
  ]);

  if (org.rowCount === 0) {
    throw Object.assign(new Error('Organization not found.'), { statusCode: 404 });
  }

  return {
    mode: 'saas',
    organization: org.rows[0],
    config: {
      ...firstRow(config.rows, {}),
      keyword_whitelist: parseJson(firstRow(config.rows, {}).keyword_whitelist, []),
      keyword_blacklist: parseJson(firstRow(config.rows, {}).keyword_blacklist, [])
    },
    stats: {
      ...firstRow(stats.rows, { total_leads: 0, ready_leads: 0, manual_required: 0 }),
      contacts: contacts.rowCount
    },
    usage: firstRow(usage.rows, emptyUsage),
    leads: leads.rows.map(mapLead),
    contacts: contacts.rows
  };
}

const channelHealth = (configured, runtimeStatus = null) => {
  if (!configured) return 'not_configured';
  if (runtimeStatus) return runtimeStatus;
  return 'configured';
};

export async function getTenantChannels(organizationId, { includeQr = false } = {}) {
  ensureSaaSMode('Tenant channels require DATABASE_URL SaaS mode.');
  await ensureTenantChannelColumns();
  const orgId = Number(organizationId);
  const [config, recent, runtimeRows] = await Promise.all([
    query(
      `SELECT t.wa_session_id,
              t.telegram_chat_id,
              t.wc_base_url,
              t.llm_routing_mode,
              t.whatsapp_cloud_enabled,
              t.whatsapp_cloud_phone_number_id,
              t.whatsapp_cloud_waba_id,
              t.whatsapp_cloud_display_number,
              CASE WHEN t.telegram_bot_token_secret IS NULL OR t.telegram_bot_token_secret = '' THEN false ELSE true END AS telegram_bot_token_configured,
              CASE WHEN t.meta_access_token_secret IS NULL OR t.meta_access_token_secret = '' THEN false ELSE true END AS meta_access_token_configured,
              CASE WHEN t.whatsapp_cloud_access_token_secret IS NULL OR t.whatsapp_cloud_access_token_secret = '' THEN false ELSE true END AS whatsapp_cloud_access_token_configured,
              CASE WHEN t.wc_consumer_key_secret IS NULL OR t.wc_consumer_key_secret = '' THEN false ELSE true END AS wc_consumer_key_configured,
              CASE WHEN t.wc_consumer_secret_secret IS NULL OR t.wc_consumer_secret_secret = '' THEN false ELSE true END AS wc_consumer_secret_configured
         FROM tenant_configs t
        WHERE t.organization_id = $1`,
      [orgId]
    ),
    query(
      `SELECT source_platform,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS messages_24h,
              MAX(created_at) AS last_received_at,
              MAX(updated_at) AS last_status_at,
              COUNT(*) FILTER (WHERE status = 'error')::int AS errors_24h
         FROM inbound_message_events
        WHERE organization_id = $1
        GROUP BY source_platform`,
      [orgId]
    ).catch((error) => {
      if (error?.code === '42P01') return { rows: [] };
      throw error;
    }),
    listChannelRuntime(orgId).catch(() => [])
  ]);

  if (config.rowCount === 0) {
    throw Object.assign(new Error('Tenant configuration not found.'), { statusCode: 404 });
  }

  const cfg = config.rows[0];
  const activityByPlatform = Object.fromEntries(recent.rows.map((row) => [row.source_platform, row]));
  const runtimeByChannel = Object.fromEntries(runtimeRows.map((row) => [`${row.channel_type}:${row.channel_key}`, row]));
  const persistedWhatsApp = runtimeByChannel[`whatsapp_web:${cfg.wa_session_id}`];
  const memoryWhatsAppRuntime = getWhatsAppSessionStatus(cfg.wa_session_id, { includeQr });
  const persistedWhatsAppRuntime = persistedWhatsApp ? {
    ...(persistedWhatsApp.metadata || {}),
    status: persistedWhatsApp.status,
    worker_id: persistedWhatsApp.worker_id,
    last_error: persistedWhatsApp.last_error,
    updated_at: persistedWhatsApp.updated_at
  } : null;
  if (persistedWhatsAppRuntime?.qr_data_url && !(includeQr && persistedWhatsAppRuntime.status === 'qr_required')) {
    delete persistedWhatsAppRuntime.qr_data_url;
  }
  const whatsappRuntime = persistedWhatsAppRuntime && (!memoryWhatsAppRuntime.updated_at || memoryWhatsAppRuntime.status === 'not_started')
    ? persistedWhatsAppRuntime
    : { ...(persistedWhatsAppRuntime || {}), ...memoryWhatsAppRuntime };
  const wooConfigured = Boolean(cfg.wc_base_url && cfg.wc_consumer_key_configured && cfg.wc_consumer_secret_configured);
  const telegramConfigured = Boolean(cfg.telegram_bot_token_configured && cfg.telegram_chat_id);
  const whatsappCloudConfigured = Boolean(
    Number(cfg.whatsapp_cloud_enabled || 0) &&
    cfg.whatsapp_cloud_phone_number_id &&
    cfg.whatsapp_cloud_access_token_configured
  );

  return {
    channels: [
      {
        id: 'whatsapp',
        name: 'WhatsApp group listener',
        type: 'inbound',
        status: channelHealth(Boolean(cfg.wa_session_id), whatsappRuntime.status),
        configured: Boolean(cfg.wa_session_id),
        details: [
          cfg.wa_session_id ? `Session: ${cfg.wa_session_id}` : 'Session missing',
          whatsappRuntime.worker_id ? `Worker: ${whatsappRuntime.worker_id}` : null,
          whatsappRuntime.status === 'qr_required' ? 'QR scan required' : null,
          whatsappRuntime.should_reconnect === false ? 'Automatic reconnect stopped' : null
        ].filter(Boolean),
        runtime: whatsappRuntime,
        activity: activityByPlatform.whatsapp || null
      },
      {
        id: 'whatsapp-cloud',
        name: 'WhatsApp Business API',
        type: 'inbound',
        status: channelHealth(whatsappCloudConfigured, 'ready'),
        configured: whatsappCloudConfigured,
        details: [
          Number(cfg.whatsapp_cloud_enabled || 0) ? 'Cloud API enabled' : 'Cloud API disabled',
          cfg.whatsapp_cloud_phone_number_id ? `Phone number ID: ${cfg.whatsapp_cloud_phone_number_id}` : 'Phone number ID missing',
          cfg.whatsapp_cloud_display_number ? `Display number: ${cfg.whatsapp_cloud_display_number}` : null,
          cfg.whatsapp_cloud_access_token_configured ? 'Cloud access token configured' : 'Cloud access token missing',
          process.env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN
            ? 'Webhook verification token configured'
            : 'Webhook verification token missing'
        ].filter(Boolean),
        webhook_path: '/webhooks/whatsapp-cloud',
        activity: activityByPlatform.whatsapp_cloud || null
      },
      {
        id: 'meta',
        name: 'Facebook / Instagram webhook',
        type: 'inbound',
        status: channelHealth(Boolean(cfg.meta_access_token_configured), 'ready'),
        configured: Boolean(cfg.meta_access_token_configured),
        details: [
          cfg.meta_access_token_configured ? 'Tenant Meta token configured' : 'Tenant Meta token missing',
          process.env.META_WEBHOOK_VERIFY_TOKEN ? 'Webhook verification token configured' : 'Webhook verification token missing'
        ],
        webhook_path: '/webhooks/meta?tenant=' + encodeURIComponent(cfg.wa_session_id || String(orgId)),
        activity: activityByPlatform.facebook || activityByPlatform.instagram || null
      },
      {
        id: 'tiktok',
        name: 'TikTok webhook',
        type: 'inbound',
        status: 'available',
        configured: true,
        details: ['Webhook adapter available; configure the tenant URL in TikTok if used.'],
        webhook_path: '/webhooks/tiktok?tenant=' + encodeURIComponent(cfg.wa_session_id || String(orgId)),
        activity: activityByPlatform.tiktok || null
      },
      {
        id: 'test',
        name: 'Test webhook',
        type: 'inbound',
        status: 'available',
        configured: true,
        details: ['Use this to test the full pipeline without external platforms.'],
        webhook_path: '/webhooks/test?tenant=' + encodeURIComponent(cfg.wa_session_id || String(orgId)),
        activity: activityByPlatform.test || null
      },
      {
        id: 'telegram',
        name: 'Telegram delivery',
        type: 'outbound',
        status: channelHealth(telegramConfigured),
        configured: telegramConfigured,
        details: [
          cfg.telegram_bot_token_configured ? 'Bot token configured' : 'Bot token missing',
          cfg.telegram_chat_id ? `Chat ID: ${cfg.telegram_chat_id}` : 'Chat ID missing'
        ]
      },
      {
        id: 'woocommerce',
        name: 'WooCommerce inventory',
        type: 'integration',
        status: channelHealth(wooConfigured),
        configured: wooConfigured,
        details: [
          cfg.wc_base_url ? `URL: ${cfg.wc_base_url}` : 'URL missing',
          cfg.wc_consumer_key_configured ? 'Consumer key configured' : 'Consumer key missing',
          cfg.wc_consumer_secret_configured ? 'Consumer secret configured' : 'Consumer secret missing'
        ]
      },
      {
        id: 'llm',
        name: 'LLM routing',
        type: 'pipeline',
        status: 'configured',
        configured: true,
        details: [`Routing mode: ${cfg.llm_routing_mode || 'cost_optimized'}`]
      }
    ]
  };
}

export async function createContact(input) {
  const name = String(input.name || '').trim();
  const whatsapp = String(input.whatsapp_number || '').trim();
  if (!name || !whatsapp) {
    throw Object.assign(new Error('name and whatsapp_number are required.'), { statusCode: 422 });
  }

  if (!isSaaSMode()) {
    const result = db.prepare(`
      INSERT INTO local_hosts (name, whatsapp_number, region, sub_area, unit_types, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, 'dashboard')
    `).run(name, whatsapp, input.region || '', input.sub_area || '', input.tags || '', input.notes || '');
    return db.prepare('SELECT id, name, whatsapp_number, region, sub_area, unit_types AS tags, notes, source, created_at FROM local_hosts WHERE id = ?').get(result.lastInsertRowid);
  }

  const organizationId = Number(input.organization_id);
  if (!organizationId) {
    throw Object.assign(new Error('organization_id is required.'), { statusCode: 422 });
  }

  const result = await query(
    `INSERT INTO contacts (organization_id, name, whatsapp_number, region, sub_area, tags, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'dashboard')
     ON CONFLICT (organization_id, whatsapp_number)
     DO UPDATE SET name = EXCLUDED.name, region = EXCLUDED.region, sub_area = EXCLUDED.sub_area,
                   tags = EXCLUDED.tags, notes = EXCLUDED.notes
     RETURNING id, name, whatsapp_number, region, sub_area, tags, notes, source, created_at`,
    [organizationId, name, whatsapp, input.region || null, input.sub_area || null, input.tags || null, input.notes || null]
  );
  return result.rows[0];
}

export async function updateTenantConfig(organizationId, input) {
  if (!isSaaSMode()) {
    throw Object.assign(new Error('Tenant configuration requires DATABASE_URL SaaS mode.'), { statusCode: 400 });
  }
  await ensureTenantChannelColumns();

  const waSessionId = String(input.wa_session_id || '').trim();
  const telegramChatId = String(input.telegram_chat_id || '').trim();
  if (!waSessionId || !telegramChatId) {
    throw Object.assign(new Error('wa_session_id and telegram_chat_id are required.'), { statusCode: 422 });
  }

  const result = await query(
    `UPDATE tenant_configs
        SET wa_session_id = $2,
            telegram_chat_id = $3,
            wc_base_url = $4,
            default_language = $5,
            llm_routing_mode = $6,
            keyword_whitelist = $7,
            keyword_blacklist = $8,
            classifier_system_prompt = $9,
            drafter_persona = $10,
            wc_consumer_key_secret = COALESCE($11, wc_consumer_key_secret),
            wc_consumer_secret_secret = COALESCE($12, wc_consumer_secret_secret),
            meta_access_token_secret = COALESCE($13, meta_access_token_secret),
            telegram_bot_token_secret = COALESCE($14, telegram_bot_token_secret),
            whatsapp_cloud_enabled = $15,
            whatsapp_cloud_phone_number_id = $16,
            whatsapp_cloud_waba_id = $17,
            whatsapp_cloud_display_number = $18,
            whatsapp_cloud_access_token_secret = COALESCE($19, whatsapp_cloud_access_token_secret),
            updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = $1
      RETURNING wa_session_id, telegram_chat_id, wc_base_url,
                whatsapp_cloud_enabled, whatsapp_cloud_phone_number_id,
                whatsapp_cloud_waba_id, whatsapp_cloud_display_number,
                CASE WHEN telegram_bot_token_secret IS NULL OR telegram_bot_token_secret = '' THEN false ELSE true END AS telegram_bot_token_configured,
                CASE WHEN wc_consumer_key_secret IS NULL OR wc_consumer_key_secret = '' THEN false ELSE true END AS wc_consumer_key_configured,
                CASE WHEN wc_consumer_secret_secret IS NULL OR wc_consumer_secret_secret = '' THEN false ELSE true END AS wc_consumer_secret_configured,
                CASE WHEN meta_access_token_secret IS NULL OR meta_access_token_secret = '' THEN false ELSE true END AS meta_access_token_configured,
                CASE WHEN whatsapp_cloud_access_token_secret IS NULL OR whatsapp_cloud_access_token_secret = '' THEN false ELSE true END AS whatsapp_cloud_access_token_configured,
                default_language, llm_routing_mode,
                classifier_system_prompt, keyword_whitelist, keyword_blacklist, drafter_persona, updated_at`,
    [
      Number(organizationId),
      waSessionId,
      telegramChatId,
      input.wc_base_url || null,
      input.default_language || 'en',
      input.llm_routing_mode || 'balanced',
      JSON.stringify(input.keyword_whitelist || []),
      JSON.stringify(input.keyword_blacklist || []),
      input.classifier_system_prompt || DEFAULT_CLASSIFIER_SYSTEM_PROMPT,
      input.drafter_persona || 'You are a concise, helpful sales assistant.',
      input.wc_consumer_key_secret ? String(input.wc_consumer_key_secret).trim() : null,
      input.wc_consumer_secret_secret ? String(input.wc_consumer_secret_secret).trim() : null,
      input.meta_access_token_secret ? String(input.meta_access_token_secret).trim() : null,
      input.telegram_bot_token_secret ? String(input.telegram_bot_token_secret).trim() : null,
      boolToInt(input.whatsapp_cloud_enabled),
      input.whatsapp_cloud_phone_number_id ? String(input.whatsapp_cloud_phone_number_id).trim() : null,
      input.whatsapp_cloud_waba_id ? String(input.whatsapp_cloud_waba_id).trim() : null,
      input.whatsapp_cloud_display_number ? String(input.whatsapp_cloud_display_number).trim() : null,
      input.whatsapp_cloud_access_token_secret ? String(input.whatsapp_cloud_access_token_secret).trim() : null
    ]
  );

  if (result.rowCount === 0) {
    throw Object.assign(new Error('Tenant configuration not found.'), { statusCode: 404 });
  }
  return result.rows[0];
}

export async function updateLeadStatus(leadId, status, organizationId = null) {
  const allowed = new Set(['pending', 'processing', 'ready', 'delivered', 'approved', 'rejected', 'archived']);
  if (!allowed.has(status)) {
    throw Object.assign(new Error('Unsupported lead status.'), { statusCode: 422 });
  }

  if (!isSaaSMode()) {
    db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, Number(leadId));
    return mapLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)));
  }

  const params = [status, Number(leadId)];
  let sql = 'UPDATE leads SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
  if (organizationId != null) {
    params.push(Number(organizationId));
    sql += ' AND organization_id = $3';
  }
  sql += ' RETURNING *';
  const result = await query(sql, params);
  if (result.rowCount === 0) {
    throw Object.assign(new Error('Lead not found.'), { statusCode: 404 });
  }
  return mapLead(result.rows[0]);
}
