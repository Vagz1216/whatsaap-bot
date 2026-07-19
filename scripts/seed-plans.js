import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const plans = [
  {
    name: 'Trial Sandbox',
    slug: 'trial-sandbox',
    description: 'Short evaluation plan. Uses cost-optimized routing on platform keys to protect trial spend.',
    monthly_price_cents: 0,
    currency_code: 'USD',
    market_code: 'GLOBAL',
    trial_days: 14,
    max_users: 2,
    max_monthly_messages: 200,
    max_monthly_ai_tokens: null,
    max_monthly_ai_credits: 100,
    overage_allowed: 0,
    overage_price_cents_per_ai_credit: null,
    allow_byok: 0,
    byok_provider_mode: 'platform_first',
    max_llm_credentials: 0,
    allowed_llm_routing_modes: 'cost_optimized',
    default_llm_routing_mode: 'cost_optimized',
    trial_allowed_llm_routing_modes: 'cost_optimized',
    active: 1
  },
  {
    name: 'Starter',
    slug: 'starter',
    description: 'Entry plan for small teams. Uses cost-optimized routing on platform keys.',
    monthly_price_cents: 4900,
    currency_code: 'USD',
    market_code: 'GLOBAL',
    trial_days: 0,
    max_users: 3,
    max_monthly_messages: 1000,
    max_monthly_ai_tokens: null,
    max_monthly_ai_credits: 1000,
    overage_allowed: 1,
    overage_price_cents_per_ai_credit: 2,
    allow_byok: 0,
    byok_provider_mode: 'platform_first',
    max_llm_credentials: 0,
    allowed_llm_routing_modes: 'cost_optimized',
    default_llm_routing_mode: 'cost_optimized',
    trial_allowed_llm_routing_modes: 'cost_optimized',
    active: 1
  },
  {
    name: 'Growth',
    slug: 'growth',
    description: 'Production plan for growing teams with BYOK support and balanced routing by default.',
    monthly_price_cents: 14900,
    currency_code: 'USD',
    market_code: 'GLOBAL',
    trial_days: 0,
    max_users: 10,
    max_monthly_messages: 5000,
    max_monthly_ai_tokens: null,
    max_monthly_ai_credits: 5000,
    overage_allowed: 1,
    overage_price_cents_per_ai_credit: 2,
    allow_byok: 1,
    byok_provider_mode: 'organization_first',
    max_llm_credentials: 3,
    allowed_llm_routing_modes: 'cost_optimized,balanced,quality_first',
    default_llm_routing_mode: 'balanced',
    trial_allowed_llm_routing_modes: 'cost_optimized',
    active: 1
  },
  {
    name: 'Scale',
    slug: 'scale',
    description: 'Higher-volume plan with larger included credits, BYOK, and room for multiple model providers.',
    monthly_price_cents: 39900,
    currency_code: 'USD',
    market_code: 'GLOBAL',
    trial_days: 0,
    max_users: 25,
    max_monthly_messages: 20000,
    max_monthly_ai_tokens: null,
    max_monthly_ai_credits: 20000,
    overage_allowed: 1,
    overage_price_cents_per_ai_credit: 1,
    allow_byok: 1,
    byok_provider_mode: 'organization_first',
    max_llm_credentials: 10,
    allowed_llm_routing_modes: 'cost_optimized,balanced,quality_first',
    default_llm_routing_mode: 'balanced',
    trial_allowed_llm_routing_modes: 'cost_optimized',
    active: 1
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'Custom plan for high-volume teams needing custom limits, procurement controls, and BYOK-first routing.',
    monthly_price_cents: 0,
    currency_code: 'USD',
    market_code: 'GLOBAL',
    trial_days: 0,
    max_users: null,
    max_monthly_messages: null,
    max_monthly_ai_tokens: null,
    max_monthly_ai_credits: null,
    overage_allowed: 1,
    overage_price_cents_per_ai_credit: 1,
    allow_byok: 1,
    byok_provider_mode: 'organization_only',
    max_llm_credentials: 25,
    allowed_llm_routing_modes: 'cost_optimized,balanced,quality_first',
    default_llm_routing_mode: 'balanced',
    trial_allowed_llm_routing_modes: 'cost_optimized',
    active: 1
  }
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to seed SaaS plans.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('neon.tech') ? true : false
});

try {
  for (const plan of plans) {
    await pool.query(
      `INSERT INTO subscription_plans (
         name, slug, description, monthly_price_cents, currency_code, market_code, trial_days,
         max_users, max_monthly_messages, max_monthly_ai_tokens, max_monthly_ai_credits,
         overage_allowed, overage_price_cents_per_ai_credit, allow_byok, byok_provider_mode,
         max_llm_credentials, allowed_llm_routing_modes, default_llm_routing_mode,
         trial_allowed_llm_routing_modes, active, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,CURRENT_TIMESTAMP
       )
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         monthly_price_cents = EXCLUDED.monthly_price_cents,
         currency_code = EXCLUDED.currency_code,
         market_code = EXCLUDED.market_code,
         trial_days = EXCLUDED.trial_days,
         max_users = EXCLUDED.max_users,
         max_monthly_messages = EXCLUDED.max_monthly_messages,
         max_monthly_ai_tokens = EXCLUDED.max_monthly_ai_tokens,
         max_monthly_ai_credits = EXCLUDED.max_monthly_ai_credits,
         overage_allowed = EXCLUDED.overage_allowed,
         overage_price_cents_per_ai_credit = EXCLUDED.overage_price_cents_per_ai_credit,
         allow_byok = EXCLUDED.allow_byok,
         byok_provider_mode = EXCLUDED.byok_provider_mode,
         max_llm_credentials = EXCLUDED.max_llm_credentials,
         allowed_llm_routing_modes = EXCLUDED.allowed_llm_routing_modes,
         default_llm_routing_mode = EXCLUDED.default_llm_routing_mode,
         trial_allowed_llm_routing_modes = EXCLUDED.trial_allowed_llm_routing_modes,
         active = EXCLUDED.active,
         updated_at = CURRENT_TIMESTAMP`,
      [
        plan.name,
        plan.slug,
        plan.description,
        plan.monthly_price_cents,
        plan.currency_code,
        plan.market_code,
        plan.trial_days,
        plan.max_users,
        plan.max_monthly_messages,
        plan.max_monthly_ai_tokens,
        plan.max_monthly_ai_credits,
        plan.overage_allowed,
        plan.overage_price_cents_per_ai_credit,
        plan.allow_byok,
        plan.byok_provider_mode,
        plan.max_llm_credentials,
        plan.allowed_llm_routing_modes,
        plan.default_llm_routing_mode,
        plan.trial_allowed_llm_routing_modes,
        plan.active
      ]
    );
  }

  const result = await pool.query(
    `SELECT name, slug, monthly_price_cents, max_users, max_monthly_messages,
            max_monthly_ai_credits, allow_byok, byok_provider_mode,
            default_llm_routing_mode, active
       FROM subscription_plans
      WHERE slug = ANY($1)
      ORDER BY monthly_price_cents ASC, name ASC`,
    [plans.map((plan) => plan.slug)]
  );
  console.log(JSON.stringify({ status: 'ok', plans: result.rows }, null, 2));
} finally {
  await pool.end();
}
