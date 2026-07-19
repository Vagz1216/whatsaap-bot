import rateLimitTracker from './rate-limit-tracker.js';
import { callAzureOpenAI } from './providers/azure-openai.js';
import { callGroq } from './providers/groq.js';
import { callGemini } from './providers/gemini.js';
import { callOpenRouter } from './providers/openrouter.js';
import { callOpenAICompatible } from './providers/openai-compatible.js';
import { listActiveProviderCredentials } from './organization-credentials.js';
import { query } from '../db/pg.js';
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

const executeChain = async (chain, prompt, systemPrompt, isJson) => {
  const trace = langfuse.trace({
    name: isJson ? "classify_intent" : "draft_response",
    input: { systemPrompt, prompt }
  });

  for (const step of chain) {
    if (!rateLimitTracker.isAvailable(step.providerId)) {
      logger.debug(`[LLM Router] Skipping ${step.providerId} (in cooldown)`);
      continue;
    }

    const generation = trace.generation({
      name: step.providerId,
      model: step.model || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'default',
      modelParameters: {
        response_format: isJson ? 'json_object' : 'text',
        billing_source: step.billingSource || 'platform',
        provider_credential_id: step.providerCredentialId || null
      },
      input: { systemPrompt, prompt }
    });

    try {
      logger.info(`[LLM Router] Attempting with ${step.providerId}...`);
      const result = await step.fn(prompt, systemPrompt, isJson, step.model, step.credential || {});
      
      generation.end({
        output: result,
        level: "DEFAULT"
      });
      trace.update({ output: result });
      await updateCredentialLastUsed(step.providerCredentialId);
      
      await langfuse.flushAsync();
      return result;
    } catch (error) {
      logger.warn(`[LLM Router] ${step.providerId} failed: ${error.message}`);
      
      generation.end({
        level: "ERROR",
        statusMessage: error.message
      });

      if (error.message.includes('429') || error.message.toLowerCase().includes('rate limit')) {
        rateLimitTracker.recordFailure(step.providerId);
      }
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
      { providerId: 'azure', fn: callAzureOpenAI, model: 'gpt-5.5' }, // Premium JSON parsing
      { providerId: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' }, // Premium fallback
      { providerId: 'gemini', fn: callGemini, model: 'gemini-2.5-flash' }, // Excellent structured output
      { providerId: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }
    ];
  } else if (routingMode === 'balanced') {
    chain = [
      { providerId: 'gemini', fn: callGemini, model: 'gemini-2.5-flash-lite' }, // Very fast/cheap
      { providerId: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' },
      { providerId: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' } // Azure-hosted fallback
    ];
  } else {
    // cost_optimized
    chain = [
      { providerId: 'openrouter', fn: callOpenRouter, model: 'deepseek/deepseek-v4-flash' }, // Often free
      { providerId: 'openrouter', fn: callOpenRouter, model: 'google/gemma-4-31b-it' },
      { providerId: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }, // Fallback to avoid OpenRouter limits
      { providerId: 'gemini', fn: callGemini, model: 'gemini-2.5-flash-lite' }
    ];
  }

  return await executeChain(await mergeProviderChains(chain, tenantConfig), prompt, systemPrompt, true, tenantConfig);
};

export const draft = async (prompt, systemPrompt, tenantConfig = {}) => {
  const routingMode = tenantConfig.llm_routing_mode || 'cost_optimized';
  let chain = [];

  if (routingMode === 'quality_first') {
    chain = [
      { providerId: 'azure', fn: callAzureOpenAI, model: 'gpt-5.5' }, // Top tier human tone
      { providerId: 'azure', fn: callAzureOpenAI, model: 'deepseek-v4-pro' }, 
      { providerId: 'openrouter', fn: callOpenRouter, model: 'zhipu/glm-5.2' } // High reasoning score
    ];
  } else if (routingMode === 'balanced') {
    chain = [
      { providerId: 'openrouter', fn: callOpenRouter, model: 'zhipu/glm-5.2' },
      { providerId: 'groq', fn: callGroq, model: 'llama-3.3-70b-versatile' }, // Extremely fast drafting
      { providerId: 'openrouter', fn: callOpenRouter, model: 'qwen/qwen-3.5-a17b-instruct' } // Great for Swahili
    ];
  } else {
    // cost_optimized
    chain = [
      { providerId: 'openrouter', fn: callOpenRouter, model: 'deepseek/deepseek-v4-flash' }, // Free/cheap on OR
      { providerId: 'openrouter', fn: callOpenRouter, model: 'qwen/qwen-3.5-a17b-instruct' }, // Cheap multilingual
      { providerId: 'groq', fn: callGroq, model: 'llama-3.1-8b-instant' } // Fallback off OpenRouter network
    ];
  }

  return await executeChain(await mergeProviderChains(chain, tenantConfig), prompt, systemPrompt, false, tenantConfig);
};
