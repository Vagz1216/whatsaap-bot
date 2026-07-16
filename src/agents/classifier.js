import { classify } from '../llm/router.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const systemPrompt = `You are a WhatsApp message classifier for a Kenyan short-stay property broker.
Your job is to determine if a message is a request for accommodation (STAY_REQUEST) or just noise/chat/listings (NOISE).
The messages will often be in English, Swahili, or a mix of both (Sheng).

IMPORTANT: 
- Only classify as STAY_REQUEST if someone is actively LOOKING FOR accommodation. 
- If the message is advertising an available property, classify as NOISE.
- Budget is rarely mentioned (only ~15% of the time). DO NOT mark a request as missing critical details if only the budget is missing.

You must output valid JSON ONLY with the following schema:
{
  "type": "STAY_REQUEST" | "NOISE",
  "confidence": number (0.0 to 1.0),
  "language": "en" | "sw" | "mixed",
  "extracted_data": {
    "location": string | null, // e.g., "Kilimani", "Westlands"
    "check_in": string | null, // YYYY-MM-DD or relative like "today", "tomorrow"
    "check_out": string | null, // YYYY-MM-DD
    "guests": number | null,
    "bedrooms": number | null,
    "budget": string | null,
    "special_notes": string | null // e.g., "needs wifi", "natafuta chumba"
  },
  "missing_critical_details": string[] // Only include: "location", "check_in", or "bedrooms" if they are entirely missing. Do NOT include budget here.
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

  if (parsed.type && !['STAY_REQUEST', 'NOISE'].includes(parsed.type)) {
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

      if (parsed.type !== 'STAY_REQUEST' || parsed.confidence < 0.72) {
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
