import { classify } from '../llm/router.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const systemPrompt = `You are an inbound lead classifier for a multi-tenant business messaging platform.
Your job is to determine if a message is an actionable customer lead (LEAD_REQUEST) or just noise/chat/listings (NOISE), using the tenant's business context when provided.
The messages may be in English, Swahili, or a mix of both (Sheng).

IMPORTANT: 
- Only classify as LEAD_REQUEST if someone is asking for, trying to buy, book, rent, subscribe to, or inquire about the tenant's product or service.
- If the message is unrelated spam, a job post, a casual greeting with no buying intent, or someone advertising their own offer, classify as NOISE.
- Budget is often missing. DO NOT mark a request as missing critical details if only budget is missing.

You must output valid JSON ONLY with the following schema:
{
  "type": "LEAD_REQUEST" | "STAY_REQUEST" | "NOISE",
  "confidence": number (0.0 to 1.0),
  "language": "en" | "sw" | "mixed",
  "extracted_data": {
    "intent": string | null,
    "product_or_service": string | null,
    "location": string | null,
    "date_or_timing": string | null,
    "budget": string | null,
    "quantity": string | null,
    "contact_preference": string | null,
    "special_notes": string | null
  },
  "missing_critical_details": string[] // Only include details truly needed before a human can respond. Do NOT include budget unless the user explicitly asks for pricing and gives no context.
}`;

const REQUIRED_FIELDS = ['type', 'confidence', 'language', 'extracted_data'];

/**
 * Attempt to parse and validate classifier JSON output.
 * Strips markdown fences and validates required fields.
 * @param {string|object} result - Raw LLM output
 * @returns {{ parsed: object|null, issues: string[] }}
 */
const parseClassifierOutput = (result) => {
  const issues = [];
  let parsed = null;

  try {
    if (typeof result === 'object' && result !== null) {
      parsed = result;
    } else {
      // Strip markdown code fences if the LLM wraps JSON in ```json ... ```
      let cleaned = String(result).trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      parsed = JSON.parse(cleaned);
    }
  } catch {
    issues.push('invalid_json');
    return { parsed: null, issues };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      issues.push(`missing_field:${field}`);
    }
  }

  if (parsed.type && !['LEAD_REQUEST', 'STAY_REQUEST', 'NOISE'].includes(parsed.type)) {
    issues.push(`invalid_type:${parsed.type}`);
  }

  if (parsed.confidence != null && (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1)) {
    issues.push(`invalid_confidence:${parsed.confidence}`);
  }

  return { parsed: issues.length > 0 ? null : parsed, issues };
};

/**
 * Classify a WhatsApp/social message as a stay request or noise.
 * Uses a retry-with-feedback loop (max 2 retries) if the LLM returns
 * malformed JSON, per SKILL.md §3.3.
 *
 * @param {string} messageText - The raw message text to classify
 * @param {object} [tenantConfig=null] - Per-tenant configuration (SaaS mode)
 * @param {object} [sourceContext={}] - Source metadata (platform, channel, name)
 * @returns {Promise<object|null>} Parsed classification result, or null if noise/failure
 */
export const runClassifier = async (messageText, tenantConfig = null, sourceContext = {}) => {
  const MAX_RETRIES = 2;
  const hasCustomPrompt = tenantConfig !== null && tenantConfig.classifier_system_prompt && tenantConfig.classifier_system_prompt.length > 50;
  const finalSystemPrompt = hasCustomPrompt ? tenantConfig.classifier_system_prompt : systemPrompt;

  const contextualMessage = [
    `[source_platform=${sourceContext.source_platform || 'whatsapp'}]`,
    `[source_channel=${sourceContext.source_channel || sourceContext.source_type || 'unknown'}]`,
    `[source_name=${sourceContext.source_name || 'unknown'}]`,
    messageText
  ].join('\n');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prompt = attempt === 0
        ? contextualMessage
        : `${contextualMessage}\n\n[SYSTEM FEEDBACK: Your previous response was invalid JSON or had missing fields. You MUST respond with valid JSON matching the schema exactly. No markdown, no explanation — only the JSON object.]`;

      const result = await classify(prompt, finalSystemPrompt, tenantConfig || {});
      const { parsed, issues } = parseClassifierOutput(result);

      if (issues.length > 0) {
        logger.warn(
          { kind: 'classifier_validation_failed', attempt: attempt + 1, issues },
          `Classifier output validation failed (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
        if (attempt < MAX_RETRIES) continue;
        return null;
      }

      if (!['LEAD_REQUEST', 'STAY_REQUEST'].includes(parsed.type) || parsed.confidence < 0.72) {
        return null;
      }

      return parsed;
    } catch (error) {
      logger.error(
        { kind: 'classifier_error', attempt: attempt + 1, error: error.message },
        `Classifier error (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
      if (attempt < MAX_RETRIES) continue;
      return null;
    }
  }

  return null;
};
