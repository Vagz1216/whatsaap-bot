import { query } from '../db/pg.js';
import { decryptSecret, secretFingerprint } from '../utils/secrets.js';

const SUPPORTED_PROVIDERS = new Set(['openai', 'azure_openai', 'gemini', 'groq', 'cerebras', 'openrouter']);
const PROVIDER_MODES = new Set(['platform_first', 'organization_first', 'organization_only']);

const isSaaSMode = () => !!process.env.DATABASE_URL;

const normalizeProvider = (value) => {
  const provider = String(value || '').trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw Object.assign(new Error('unsupported LLM provider'), { statusCode: 422 });
  }
  return provider;
};

export const providerDefaults = (providerValue, input = {}) => {
  const provider = normalizeProvider(providerValue);
  const fields = {
    base_url: String(input.base_url || '').trim() || null,
    azure_endpoint: String(input.azure_endpoint || '').trim() || null,
    azure_deployment: String(input.azure_deployment || '').trim() || null,
    azure_api_version: String(input.azure_api_version || '').trim() || null,
    default_model: String(input.default_model || '').trim() || null
  };

  if (provider === 'azure_openai') {
    if (!fields.azure_endpoint || !fields.azure_deployment) {
      throw Object.assign(new Error('Azure OpenAI credentials require endpoint and deployment.'), { statusCode: 422 });
    }
    fields.azure_api_version = fields.azure_api_version || process.env.AZURE_OPENAI_API_VERSION || '2023-12-01-preview';
    fields.default_model = fields.default_model || fields.azure_deployment;
  } else if (provider === 'openai') {
    fields.default_model = fields.default_model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  } else if (provider === 'gemini') {
    fields.default_model = fields.default_model || 'gemini-2.5-flash-lite';
  } else if (provider === 'groq') {
    fields.default_model = fields.default_model || 'llama-3.3-70b-versatile';
  } else if (provider === 'cerebras') {
    fields.base_url = fields.base_url || 'https://api.cerebras.ai/v1';
    fields.default_model = fields.default_model || 'llama3.1-8b';
  } else if (provider === 'openrouter') {
    fields.base_url = fields.base_url || 'https://openrouter.ai/api/v1';
    fields.default_model = fields.default_model || 'deepseek/deepseek-v4-flash';
  }

  return fields;
};

const cleanPolicyMode = (value) => PROVIDER_MODES.has(value) ? value : 'platform_first';

export const getByokPolicy = async (organizationId) => {
  if (!isSaaSMode() || !organizationId) {
    return {
      enabled: false,
      global_enabled: false,
      plan_allows_byok: false,
      provider_mode: cleanPolicyMode(process.env.ORGANIZATION_LLM_PROVIDER_MODE || 'platform_first'),
      max_credentials: null,
      supported_providers: [...SUPPORTED_PROVIDERS].sort()
    };
  }

  const result = await query(
    `SELECT p.*
       FROM organization_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.organization_id = $1
        AND s.status IN ('TRIALING', 'ACTIVE')
        AND p.active = 1
      LIMIT 1`,
    [Number(organizationId)]
  );
  const plan = result.rows[0] || null;
  const globalEnabled = process.env.ORGANIZATION_LLM_KEYS_ENABLED !== 'false';
  const planAllowsByok = Boolean(plan && plan.allow_byok);
  const mode = cleanPolicyMode(plan?.byok_provider_mode || process.env.ORGANIZATION_LLM_PROVIDER_MODE || 'platform_first');

  return {
    enabled: Boolean(globalEnabled && planAllowsByok),
    global_enabled: globalEnabled,
    plan_allows_byok: planAllowsByok,
    provider_mode: mode,
    max_credentials: plan?.max_llm_credentials ?? null,
    plan,
    supported_providers: [...SUPPORTED_PROVIDERS].sort(),
    security_note: 'Provider keys are encrypted when saved and are never returned by API responses.'
  };
};

export const sanitizeCredential = (row) => {
  const clean = { ...row };
  const secret = clean.api_key_secret;
  delete clean.api_key_secret;
  try {
    clean.api_key_fingerprint = secretFingerprint(decryptSecret(secret));
  } catch {
    clean.api_key_fingerprint = secretFingerprint(secret);
  }
  clean.has_api_key = Boolean(secret);
  return clean;
};

export const listActiveProviderCredentials = async (organizationId) => {
  const policy = await getByokPolicy(organizationId);
  if (!policy.enabled || !organizationId) return { credentials: [], policy };

  const result = await query(
    `SELECT *
       FROM organization_llm_credentials
      WHERE organization_id = $1
        AND status = 'ACTIVE'
      ORDER BY provider ASC, id ASC`,
    [Number(organizationId)]
  );

  const credentials = [];
  for (const row of result.rows) {
    try {
      const provider = normalizeProvider(row.provider);
      const fields = providerDefaults(provider, row);
      credentials.push({
        ...row,
        ...fields,
        provider,
        api_key: decryptSecret(row.api_key_secret)
      });
    } catch {
      continue;
    }
  }

  return { credentials, policy };
};

export const enforceCredentialCreatePolicy = async (organizationId) => {
  const policy = await getByokPolicy(organizationId);
  if (!policy.global_enabled) {
    throw Object.assign(new Error('organization LLM keys are disabled for this deployment.'), { statusCode: 403 });
  }
  if (!policy.plan_allows_byok) {
    throw Object.assign(new Error('the current plan does not include organization-managed LLM keys.'), { statusCode: 403 });
  }
  if (policy.max_credentials != null) {
    const count = await query(
      `SELECT COUNT(*)::int AS count
         FROM organization_llm_credentials
        WHERE organization_id = $1`,
      [Number(organizationId)]
    );
    if (Number(count.rows[0]?.count || 0) >= Number(policy.max_credentials)) {
      throw Object.assign(new Error('this plan has reached its LLM credential limit.'), { statusCode: 422 });
    }
  }
  return policy;
};

export const normalizeCredentialProvider = normalizeProvider;
