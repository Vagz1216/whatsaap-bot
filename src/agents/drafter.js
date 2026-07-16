import { draft } from '../llm/router.js';
import { validateDraftMessage } from '../guardrails/index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Draft a message through the LLM and validate the output via guardrails.
 * @param {string} prompt - The drafting prompt
 * @param {string} systemPrompt - System instructions for the drafter
 * @param {object} [tenantConfig={}] - Per-tenant configuration
 * @returns {Promise<string>} Validated draft text
 */
const safeDraft = async (prompt, systemPrompt, tenantConfig = {}) => validateDraftMessage(await draft(prompt, systemPrompt, tenantConfig));

/**
 * Generate draft reply messages for a lead based on match results.
 * Produces up to 3 types of drafts:
 * - draft_to_client: The message to send to the person who asked
 * - draft_to_matched_host: The message to send to the property host (if direct match)
 * - drafts_to_nearby_hosts: Messages to nearby hosts (if no direct match)
 *
 * @param {object} lead - The lead record with raw_message, sender_name, detected_language, etc.
 * @param {object|null} matchResult - Matcher output: { matchType, properties?, hosts?, wooCommerceError? }
 * @param {object} [tenantConfig={}] - Per-tenant configuration
 * @returns {Promise<{draft_to_client: object|null, draft_to_matched_host: object|null, drafts_to_nearby_hosts: object[]}>}
 */
export const runDrafter = async (lead, matchResult, tenantConfig = {}) => {
  const isSaaS = tenantConfig && tenantConfig.drafter_persona;
  const persona = isSaaS ? tenantConfig.drafter_persona : 'You are an assistant for a property broker.';
  const sourcePlatform = lead.source_platform || 'whatsapp';
  const sourceChannel = lead.source_channel || lead.source_type || 'unknown';
  const channelContext = `This lead came from ${sourcePlatform} via ${sourceChannel}. Draft for human review only. If this is a public comment, avoid sharing private pricing or personal data in the public reply.`;

  const languageContext = lead.detected_language === 'sw' ? 'Write in warm, natural Swahili.' 
    : lead.detected_language === 'mixed' ? 'Write in a natural mix of English and Swahili (Sheng).' 
    : 'Write in warm, natural English.';

  const result = {
    draft_to_client: null,
    draft_to_matched_host: null,
    drafts_to_nearby_hosts: []
  };

  try {
    if (!matchResult && lead.missing_critical_details && lead.missing_critical_details.length > 0) {
      // Scenario: Incomplete Request
      const missingList = lead.missing_critical_details.join(' and ');
      const promptClient = `Draft a polite message to the client asking them to clarify their ${missingList}. 
      Their original request was: "${lead.raw_message}".
      Do not ask for budget. Just ask for the missing details naturally.`;
      const sysClient = `${persona} ${languageContext} ${channelContext} Keep it short, helpful, and friendly.`;

      result.draft_to_client = {
        to_name: lead.sender_name,
        to_number: lead.sender_number,
        message: await safeDraft(promptClient, sysClient, tenantConfig)
      };
      
    } else if (matchResult && matchResult.matchType === 'direct') {
      // Scenario A
      const prop = matchResult.properties[0]; // Take top match
      const propLink = prop.permalink || (tenantConfig.wc_base_url ? `${tenantConfig.wc_base_url}/product/${prop.id}` : `https://stayez.co.ke/product/${prop.id}`);

      // Draft to Client
      const promptClient = `Draft a message to the client proposing this property: ${prop.name}. Link: ${propLink}. 
      Their original request was: "${lead.raw_message}".`;
      const sysClient = `${persona} ${languageContext} ${channelContext} Keep it concise and friendly.`;
      
      result.draft_to_client = {
        to_name: lead.sender_name,
        to_number: lead.sender_number,
        message: await safeDraft(promptClient, sysClient, tenantConfig)
      };

      // Draft to Host
      const promptHost = `Draft a message to the host of property ${prop.name}. 
      We have a potential client looking for: ${lead.raw_message}. 
      Ask the host to confirm if the dates are still open.`;
      const sysHost = `${persona} Write in professional English or Swahili. Keep it short.`;

      result.draft_to_matched_host = {
        to_name: prop.vendor_name || 'Host',
        to_number: prop.vendor_phone || 'Unknown',
        message: await safeDraft(promptHost, sysHost, tenantConfig)
      };

    } else if (matchResult && matchResult.matchType === 'nearby' && matchResult.wooCommerceError) {
      // Scenario B1: WooCommerce API was unreachable — don't say "no properties", say we're checking
      const promptClient = `Draft a short, friendly message to the client saying we are currently checking availability for their request and will get back to them shortly.
      Their original request was: "${lead.raw_message}".
      Do NOT say we have no properties. Just say we are looking into it.`;
      const sysClient = `${persona} ${languageContext} ${channelContext} Keep it short and reassuring.`;

      result.draft_to_client = {
        to_name: lead.sender_name,
        to_number: lead.sender_number,
        message: await safeDraft(promptClient, sysClient, tenantConfig)
      };

      // Still contact any nearby hosts we found in SQLite
      for (const host of matchResult.hosts || []) {
        const promptHost = `Draft a personalized message to ${host.name}. 
        We have a client looking for: ${lead.raw_message}. 
        Ask if they have any availability that matches this.`;
        const sysHost = `${persona} Write naturally in English/Swahili.`;

        result.drafts_to_nearby_hosts.push({
          to_name: host.name,
          to_number: host.whatsapp_number,
          message: await safeDraft(promptHost, sysHost, tenantConfig)
        });
      }

    } else if (matchResult && matchResult.matchType === 'nearby' && matchResult.hosts.length > 0) {
      // Scenario B2: No WooCommerce results but we have local hosts to contact
      const promptClient = `Draft a message to the client saying we are checking with our hosts in ${lead.location || 'that area'} and will get back to them shortly.
      Their original request was: "${lead.raw_message}".`;
      const sysClient = `${persona} ${languageContext} ${channelContext} Keep it reassuring.`;

      result.draft_to_client = {
        to_name: lead.sender_name,
        to_number: lead.sender_number,
        message: await safeDraft(promptClient, sysClient, tenantConfig)
      };

      // Drafts to Nearby Hosts
      for (const host of matchResult.hosts) {
        const promptHost = `Draft a personalized message to ${host.name}. 
        We have a client looking for: ${lead.raw_message}. 
        Ask if they have any availability that matches this.`;
        const sysHost = `${persona} Write naturally in English/Swahili.`;

        result.drafts_to_nearby_hosts.push({
          to_name: host.name,
          to_number: host.whatsapp_number,
          message: await safeDraft(promptHost, sysHost, tenantConfig)
        });
      }
    } else {
      // No matches at all — genuinely confirmed no availability
      const promptClient = `Draft a message to the client saying we currently don't have available properties matching their request, but we will keep them in mind.
      Their original request was: "${lead.raw_message}".`;
      const sysClient = `${persona} ${languageContext} ${channelContext} Keep it polite.`;

      result.draft_to_client = {
        to_name: lead.sender_name,
        to_number: lead.sender_number,
        message: await safeDraft(promptClient, sysClient, tenantConfig)
      };
    }
  } catch (error) {
    logger.error({ kind: 'drafter_error', error: error.message }, 'Drafter failed to generate drafts');
  }

  return result;
};
