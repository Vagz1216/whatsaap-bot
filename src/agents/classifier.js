import { classify } from '../llm/router.js';

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

export const runClassifier = async (messageText, tenantConfig = null, sourceContext = {}) => {
  try {
    const hasCustomPrompt = tenantConfig !== null && tenantConfig.classifier_system_prompt && tenantConfig.classifier_system_prompt.length > 50;
    const finalSystemPrompt = hasCustomPrompt ? tenantConfig.classifier_system_prompt : systemPrompt;
    const contextualMessage = [
      `[source_platform=${sourceContext.source_platform || 'whatsapp'}]`,
      `[source_channel=${sourceContext.source_channel || sourceContext.source_type || 'unknown'}]`,
      `[source_name=${sourceContext.source_name || 'unknown'}]`,
      messageText
    ].join('\n');

    const result = await classify(contextualMessage, finalSystemPrompt, tenantConfig || {});
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;

    if (parsed.type !== 'STAY_REQUEST' || parsed.confidence < 0.72) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.error(`Classifier error: ${error.message}`);
    return null;
  }
};
