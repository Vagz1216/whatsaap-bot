import rateLimitTracker from './rate-limit-tracker.js';
import { callAzureOpenAI } from './providers/azure-openai.js';
import { callGroq } from './providers/groq.js';
import { callGemini } from './providers/gemini.js';
import { callOpenRouter } from './providers/openrouter.js';
import { callOpenAICompatible } from './providers/openai-compatible.js';
import { listActiveProviderCredentials } from './organization-credentials.js';
import { query } from '../db/pg.js';
import { recordLlmUsage } from '../db/tenant.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const noopTrace = {
  generation: () => ({ end: () => {} }),
  update: () => {}
};

const createLangfuseClient = async () => {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    return { trace: () => noopTrace, flushAsync: async () => {} };
  }
  try {
    const { Langfuse } = await import('langfuse');
    return new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
      enabled: true
    });
  } catch (error) {
    logger.warn({ kind: 'langfuse_disabled', error: error.message }, 'Langfuse package is not installed; tracing disabled');
    return { trace: () => noopTrace, flushAsync: async () => {} };
  }
};

const langfuse = await createLangfuseClient();

const pricingVersion = '2026-07-static-estimate';
const usdPerMillionTokens = {
  azure: {
    'gpt-5.5': { input: 5.00, output: 15.00 },
    'deepseek-v4-pro': { input: 1.00, output: 3.00 }
  },
  azure_openai: {
    'gpt-5.5': { input: 5.00, output: 15.00 },
    'deepseek-v4-pro': { input: 1.00, output: 3.00 }
  },
  gemini: {
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.5-flash': { input: 0.30, output: 2.50 }
  },
  groq: {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08 }
  },
  openrouter: {
    'deepseek/deepseek-v4-flash': { input: 0.00, output: 0.00 },
    'google/gemma-4-31b-it': { input: 0.00, output: 0.00 },
    'zhipu/glm-5.2': { input: 0.50, output: 1.50 },
    'qwen/qwen-3.5-a17b-instruct': { input: 0.20, output: 0.60 }
  },
  openai: {
    'gpt-4o-mini': { input: 0.15, output: 0.60 }
  },
  cerebras: {
    'gpt-oss-120b': { input: 0.60, output: 1.20 }
  }
};

const providerName = (step) => step.provider || String(step.providerId || '').split(':')[0] || 'unknown';

const normalizeUsage = (provider, usage = {}) => {
  if (!usage) return { input: 0, output: 0, cached_input: 0, reasoning_output: 0, total: 0 };

  const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0;
  const cachedInput = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cachedContentTokenCount ?? 0;
  const reasoningOutput = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? usage.thoughtsTokenCount ?? 0;
  const total = usage.total_tokens ?? usage.totalTokens ?? (Number(input) + Number(output));

  return {
    input: Number(input || 0),
    output: Number(output || 0),
    cached_input: Number(cachedInput || 0),
    reasoning_output: Number(reasoningOutput || 0),
    total: Number(total || 0)
  };
};

const estimateCostUsd = (provider, model, tokens) => {
  const pricing = usdPerMillionTokens[provider]?.[model];
  if (!pricing) return { costUsd: 0, pricingSource: 'unpriced_model_static_zero' };
  const billableInput = Math.max(0, Number(tokens.input || 0) - Number(tokens.cached_input || 0));
  const inputCost = (billableInput / 1_000_000) * pricing.input;
  const outputCost = (Number(tokens.output || 0) / 1_000_000) * pricing.output;
  return { costUsd: Number((inputCost + outputCost).toFixed(8)), pricingSource: 'static_estimate' };
};

const normalizeProviderResult = (result, fallbackModel) => {
  if (result && typeof result === 'object' && 'text' in result) {
    return {
      text: result.text || '',
      model: result.model || fallbackModel,
      usage: result.usage || null
    };
  }
  return {
    text: result || '',
    model: fallbackModel,
    usage: null
  };
};

const recordAttempt = async ({
  tenantConfig,
  agentName,
  step,
  model,
  usage,
  latencyMs,
  routingMode,
  attemptCount,
  fallbackTriggered,
  status,
  error = null
}) => {
  if (!process.env.DATABASE_URL || !tenantConfig?.organization_id) return;
  const provider = providerName(step);
  const tokens = normalizeUsage(provider, usage);
  const { costUsd, pricingSource } = estimateCostUsd(provider, model, tokens);
  try {
    await recordLlmUsage(
      tenantConfig.organization_id,
      agentName,
      provider,
      model || 'unknown',
      tokens,
      latencyMs,
      costUsd,
      routingMode,
      {
        requestId: tenantConfig.__audit?.requestId || null,
        sourceObjectType: tenantConfig.__audit?.sourceObjectType || null,
        sourceObjectId: tenantConfig.__audit?.sourceObjectId || null,
        billingSource: step.billingSource || 'platform',
        providerCredentialId: step.providerCredentialId || null,
        fallbackTriggered,
        attemptCount,
        status,
        error,
        pricingSource,
        pricingVersion,
        metadata: {
          provider_id: step.providerId,
          agent_name: agentName,
          model_requested: step.model || null
        }
      }
    );
  } catch (recordError) {
    logger.warn({ kind: 'llm_usage_record_failed', error: recordError.message }, 'Could not record LLM usage');
  }
};

const updateCredentialLastUsed = async (credentialId) => {
  if (!credentialId || !process.env.DATABASE_URL) return;
  try {
    await query(
      `UPDATE organization_llm_credentials
          SET last_used_at = CURRENT_TIMESTAMP,
              last_error = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [Number(credentialId)]
    );
  } catch (error) {
    logger.warn({ kind: 'byok_last_used_update_failed', credential_id: credentialId, error: error.message }, 'Could not update BYOK credential usage');
  }
};

const executeChain = async (chain, prompt, systemPrompt, isJson, tenantConfig = {}) => {
  const agentName = isJson ? 'classify_intent' : 'draft_response';
  const routingMode = tenantConfig.llm_routing_mode || 'cost_optimized';
  const trace = langfuse.trace({
    name: agentName,
    input: { systemPrompt, prompt }
  });

  let attemptCount = 0;
  for (const step of chain) {
    if (!rateLimitTracker.isAvailable(step.providerId)) {
      logger.debug(`[LLM Router] Skipping ${step.providerId} (in cooldown)`);
      continue;
    }
    attemptCount += 1;

    const generation = trace.generation({
      name: step.providerId,
      model: step.model || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT || 'default',
      modelParameters: {
        response_format: isJson ? 'json_object' : 'text',
        billing_source: step.billingSource || 'platform',
        provider_credential_id: step.providerCredentialId || null
      },
      input: { systemPrompt, prompt }
    });

    try {
      logger.info(`[LLM Router] Attempting with ${step.providerId}...`);
      const started = Date.now();
      const result = await step.fn(prompt, systemPrompt, isJson, step.model, {
        ...(step.credential || {}),
        __return_metadata: true
      });
      const latencyMs = Date.now() - started;
      const normalized = normalizeProviderResult(result, step.model);
      
      generation.end({
        output: normalized.text,
        level: "DEFAULT"
      });
      trace.update({ output: normalized.text });
      await updateCredentialLastUsed(step.providerCredentialId);
      await recordAttempt({
        tenantConfig,
        agentName,
        step,
        model: normalized.model,
        usage: normalized.usage,
        latencyMs,
        routingMode,
        attemptCount,
        fallbackTriggered: attemptCount > 1,
        status: 'success'
      });
      
      await langfuse.flushAsync();
      return normalized.text;
    } catch (error) {
      logger.warn(`[LLM Router] ${step.providerId} failed: ${error.message}`);
      
      generation.end({
        level: "ERROR",
        statusMessage: error.message
      });

      if (error.message.includes('429') || error.message.toLowerCase().includes('rate limit')) {
        rateLimitTracker.recordFailure(step.providerId);
      }
      await recordAttempt({
        tenantConfig,
        agentName,
        step,
        model: step.model || 'unknown',
        usage: null,
        latencyMs: 0,
        routingMode,
        attemptCount,
        fallbackTriggered: attemptCount > 1,
        status: 'error',
        error: error.message
      });
    }
  }
  
  const errorMsg = "All LLM providers in the fallback chain failed.";
  trace.update({ level: "ERROR", statusMessage: errorMsg });
  await langfuse.flushAsync();
  throw new Error(errorMsg);
};

const orgProviderFn = (provider) => {
  if (provider === 'azure_openai') return callAzureOpenAI;
  if (provider === 'gemini') return callGemini;
  if (provider === 'groq') return callGroq;
  if (provider === 'openrouter') return callOpenRouter;
  if (provider === 'openai' || provider === 'cerebras') return callOpenAICompatible;
  return null;
};

const buildOrganizationChain = async (tenantConfig = {}) => {
  const organizationId = tenantConfig.organization_id;
  const { credentials, policy } = await listActiveProviderCredentials(organizationId);
  const chain = credentials
    .map((credential) => {
      const fn = orgProviderFn(credential.provider);
      if (!fn) return null;
      return {
        providerId: `org:${credential.provider}:${credential.id}`,
        provider: credential.provider,
        fn,
        model: credential.default_model,
        credential,
        billingSource: 'organization',
        providerCredentialId: credential.id
      };
    })
    .filter(Boolean);
  return { chain, policy };
};

const mergeProviderChains = async (platformChain, tenantConfig = {}) => {
  const { chain: orgChain, policy } = await buildOrganizationChain(tenantConfig);
  const mode = policy.provider_mode || 'platform_first';
  if (mode === 'organization_only') return orgChain;
  if (mode === 'organization_first') return [...orgChain, ...platformChain];
  return [...platformChain, ...orgChain];
};

export const classify = async (prompt, systemPrompt, tenantConfig = {}) => {
  const routingMode = tenantConfig.llm_routing_mode || 'cost_optimized';
  let chain = [];

  if (routingMode === 'quality_first') {
    chain = [
      { providerId: 'azure', provider: 'azure', fn: callAzureOpenAI, model: 'gpt-5.5' }, // Premium JSON parsing
      { providerId: 'azure', provider: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' }, // Premium fallback
      { providerId: 'gemini', provider: 'gemini', fn: callGemini, model: 'gemini-2.5-flash' }, // Excellent structured output
      { providerId: 'groq', provider: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }
    ];
  } else if (routingMode === 'balanced') {
    chain = [
      { providerId: 'gemini', provider: 'gemini', fn: callGemini, model: 'gemini-2.5-flash-lite' }, // Very fast/cheap
      { providerId: 'groq', provider: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' },
      { providerId: 'azure', provider: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' } // Azure-hosted fallback
    ];
  } else {
    // cost_optimized
    chain = [
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'deepseek/deepseek-v4-flash' }, // Often free
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'google/gemma-4-31b-it' },
      { providerId: 'groq', provider: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }, // Fallback to avoid OpenRouter limits
      { providerId: 'gemini', provider: 'gemini', fn: callGemini, model: 'gemini-2.5-flash-lite' }
    ];
  }

  return await executeChain(await mergeProviderChains(chain, tenantConfig), prompt, systemPrompt, true, tenantConfig);
};

export const draft = async (prompt, systemPrompt, tenantConfig = {}) => {
  const routingMode = tenantConfig.llm_routing_mode || 'cost_optimized';
  let chain = [];

  if (routingMode === 'quality_first') {
    chain = [
      { providerId: 'azure', provider: 'azure', fn: callAzureOpenAI, model: 'gpt-5.5' }, // Top tier human tone
      { providerId: 'azure', provider: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' },
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'zhipu/glm-5.2' } // High reasoning score
    ];
  } else if (routingMode === 'balanced') {
    chain = [
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'zhipu/glm-5.2' },
      { providerId: 'groq', provider: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }, // Extremely fast drafting
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'qwen/qwen-3.5-a17b-instruct' } // Great for Swahili
    ];
  } else {
    // cost_optimized
    chain = [
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'deepseek/deepseek-v4-flash' }, // Free/cheap on OR
      { providerId: 'openrouter', provider: 'openrouter', fn: callOpenRouter, model: 'qwen/qwen-3.5-a17b-instruct' }, // Cheap multilingual
      { providerId: 'groq', provider: 'groq', fn: callGroq, model: 'llama-3.1-8b-instant' } // Fallback off OpenRouter network
    ];
  }

  return await executeChain(await mergeProviderChains(chain, tenantConfig), prompt, systemPrompt, false, tenantConfig);
};
