import { runClassifier } from '../agents/classifier.js';
import { runMatcher } from '../agents/matcher.js';
import { runDrafter } from '../agents/drafter.js';
import { sendCards } from '../telegram/index.js';
import db from '../db/index.js';
import { validateInboundMessage, GuardrailError } from '../guardrails/index.js';
import { randomUUID } from 'crypto';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Robust keyword and heuristic filter to save LLM tokens
const isLikelyLeadRequest = (text) => {
  const lower = text.toLowerCase();
  
  // 1. Hard limits (too short or too long are unlikely to be genuine stay requests)
  // Short messages are already filtered in monitor.js (< 15 chars)
  if (lower.length > 600) return false; // Long forwards, news, or spam

  // 2. Negative Keywords (Blacklist) - drop obvious non-requests
  const blacklist = [
    'http', 'www', '.com', '.co.ke', // Links are usually spam or promotions
    'job', 'vacancy', 'hiring', 'cv', 'interview', // Job postings
    'news', 'breaking', 'politics', 'update', // News forwards
    'subscribe', 'youtube', 'tiktok', 'instagram', 'follow', // Social media spam
    'fully furnished', 'kes/night', 'kes / night', 'kes per night', 'ksh/night', 'kshs/night', // Listing indicators
    'for sale', 'acre', 'plot', 'title deed', 'buy', 'buying', // Real estate sales
    'data bundles', 'sofa', 'curtains', 'shoes', 'clothes', 'delivery', 'wholesale' // Selling other items
  ];
  if (blacklist.some(k => lower.includes(k))) return false;

  // 3. Positive Keywords (Whitelist) - require at least one strong intent indicator
  const keywords = [
    'book', 'stay', 'room', 'bedroom', 'guest', 'night', 
    'budget', 'kes', 'ksh', 'shilling', 'apartment', 'place', 
    'house', 'rent', 'looking for', 'airbnb', 'bnb', 
    'natafuta', 'need a', 'needs a', 'client needs', 'any', 'vacant',
    'chumba', 'nyumba', 'keja', 'hostel', 'studio', // Swahili/Sheng and property types
    'check in', 'check out', 'check-in', 'check-out', // Dates
    'available', 'availability', 'reservation', 'reserve', // Status
    '1b', '2b', '3b', '1br', '2br', '3br', '1 bed', '2 bed', '3 bed' // Abbreviations
  ];
  
  // Return true if at least one positive keyword is found
  return keywords.some(k => lower.includes(k));
};

export const processMessage = async (msgData, tenantConfig = null) => {
  const requestId = randomUUID();
  const isSaaS = tenantConfig !== null;
  const logPrefix = isSaaS ? `[Tenant: ${tenantConfig.organization_name}]` : '[Local StayEZ]';
  logger.info({ request_id: requestId, kind: 'request_start', sender_number: msgData.sender_number }, `${logPrefix} Processing new message`);
  
  try {
    const safeMessage = validateInboundMessage(msgData.raw_message);
    const safeMsgData = { ...msgData, raw_message: safeMessage };
    const lower = safeMsgData.raw_message.toLowerCase();

    // 0. Pre-filter
    if (isSaaS) {
      if (tenantConfig.keyword_blacklist && tenantConfig.keyword_blacklist.some(k => lower.includes(k.toLowerCase()))) {
        logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'blacklist_filter' }, `${logPrefix} Message ignored by tenant blacklist`);
        return;
      }
      if (tenantConfig.keyword_whitelist && tenantConfig.keyword_whitelist.length > 0) {
        if (!tenantConfig.keyword_whitelist.some(k => lower.includes(k.toLowerCase()))) {
          logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'whitelist_filter' }, `${logPrefix} Message ignored (no whitelist match)`);
          return;
        }
      }
    } else {
      if (!isLikelyLeadRequest(safeMsgData.raw_message)) {
        logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'keyword_filter' }, `${logPrefix} Message ignored by keyword filter`);
        return;
      }
    }

    // 1. Classify
    const classification = await runClassifier(safeMsgData.raw_message, tenantConfig || {});
    if (!classification) {
      logger.debug({ request_id: requestId, kind: 'message_ignored', reason: 'classification' }, `${logPrefix} Message ignored by classifier`);
      return;
    }

    const { language, extracted_data, confidence } = classification;
    logger.info({ request_id: requestId, kind: 'classification_complete', confidence }, `${logPrefix} Valid request detected`);

    // 2. Insert Lead (Handle Postgres vs SQLite)
    let leadId;
    let finalLead;

    if (isSaaS) {
      const { query } = require('../db/pg');
      const insertQuery = `
        INSERT INTO leads (
          organization_id, source_type, source_id, source_name, sender_number, sender_name,
          raw_message, detected_language, extracted_data, classifier_confidence, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'processing')
        RETURNING id
      `;
      const result = await query(insertQuery, [
        tenantConfig.organization_id,
        safeMsgData.source_type, safeMsgData.source_id, safeMsgData.source_name, safeMsgData.sender_number, safeMsgData.sender_name,
        safeMsgData.raw_message, language, 
        JSON.stringify(extracted_data), confidence
      ]);
      leadId = result.rows[0].id;
    } else {
      const missingDetailsJson = classification.missing_critical_details && classification.missing_critical_details.length > 0 
        ? JSON.stringify(classification.missing_critical_details) : null;
      
      const insertStmt = db.prepare(`
        INSERT INTO leads (
          source_type, source_id, source_name, sender_number, sender_name,
          raw_message, detected_language, location, check_in, check_out, guests, budget,
          special_notes, missing_details, classifier_confidence, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')
      `);
      
      const result = insertStmt.run(
        safeMsgData.source_type, safeMsgData.source_id, safeMsgData.source_name, safeMsgData.sender_number, safeMsgData.sender_name,
        safeMsgData.raw_message, language, extracted_data.location, extracted_data.check_in, extracted_data.check_out,
        extracted_data.guests ? String(extracted_data.guests) : null, extracted_data.budget,
        extracted_data.special_notes, missingDetailsJson, confidence
      );
      leadId = result.lastInsertRowid;
    }

    const lead = {
      id: leadId,
      ...safeMsgData,
      detected_language: language,
      missing_critical_details: classification.missing_critical_details,
      ...extracted_data
    };

    // 3. Match & Draft
    let matchResult = null;
    let drafts = { draft_to_client: null, draft_to_matched_host: null, drafts_to_nearby_hosts: null };
    const hasInventoryApi = isSaaS ? (tenantConfig.wc_base_url && tenantConfig.wc_consumer_key_secret) : !!process.env.WC_BASE_URL;
    
    if (lead.missing_critical_details && lead.missing_critical_details.length > 0) {
      logger.info({ request_id: requestId, kind: 'matcher_skipped', missing_details: lead.missing_critical_details }, `${logPrefix} Lead missing details`);
      drafts = await runDrafter(lead, null, tenantConfig || {}); 
    } else if (hasInventoryApi) {
      matchResult = await runMatcher(extracted_data, tenantConfig || {});
      logger.info({ request_id: requestId, kind: 'matcher_complete', match_type: matchResult.matchType }, `${logPrefix} Match result`);
      drafts = await runDrafter(lead, matchResult, tenantConfig || {});
    } else {
      logger.info({ request_id: requestId, kind: 'matcher_skipped', reason: 'no_inventory_api' }, `${logPrefix} Matcher skipped (no inventory API)`);
      drafts = await runDrafter(lead, { matchType: 'no_api', properties: [] }, tenantConfig || {});
    }

    // 4. Update DB
    if (isSaaS) {
      const { query } = require('../db/pg');
      const matchedItems = (matchResult && matchResult.matchType === 'direct') ? JSON.stringify(matchResult.properties) : null;
      await query(`
        UPDATE leads SET status = 'ready', matched_items = $1, draft_to_client = $2, draft_to_source = $3, drafts_to_contacts = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5
      `, [
        matchedItems,
        drafts.draft_to_client ? JSON.stringify(drafts.draft_to_client) : null,
        drafts.draft_to_matched_host ? JSON.stringify(drafts.draft_to_matched_host) : null,
        drafts.drafts_to_nearby_hosts ? JSON.stringify(drafts.drafts_to_nearby_hosts) : null,
        leadId
      ]);
      const finalLeadResult = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
      finalLead = finalLeadResult.rows[0];
    } else {
      const propertyIds = (matchResult && matchResult.matchType === 'direct') ? JSON.stringify(matchResult.properties.map(p => p.id)) : null;
      db.prepare(`
        UPDATE leads SET status = 'ready', matched_property_ids = ?, draft_to_client = ?, draft_to_matched_host = ?, drafts_to_nearby_hosts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(
        propertyIds,
        drafts.draft_to_client ? JSON.stringify(drafts.draft_to_client) : null,
        drafts.draft_to_matched_host ? JSON.stringify(drafts.draft_to_matched_host) : null,
        drafts.drafts_to_nearby_hosts ? JSON.stringify(drafts.drafts_to_nearby_hosts) : null,
        leadId
      );
      finalLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    }

    // 5. Notify Telegram
    if (isSaaS) {
      await sendCards(finalLead, tenantConfig);
    } else {
      await sendCards(finalLead); // Legacy local uses process.env
    }
    logger.info({ request_id: requestId, kind: 'telegram_sent', lead_id: leadId }, `${logPrefix} Successfully processed and sent to Telegram`);

    // 6. Finalize DB
    if (isSaaS) {
      const { query } = require('../db/pg');
      await query("UPDATE leads SET status = 'delivered' WHERE id = $1", [leadId]);
      logger.info({ request_id: requestId, kind: 'request_complete', lead_id: leadId }, `${logPrefix} Marked lead as delivered in DB`);
    } else {
      db.prepare('DELETE FROM leads WHERE id = ?').run(leadId);
      logger.info({ request_id: requestId, kind: 'request_complete', lead_id: leadId }, `${logPrefix} Auto-deleted lead from SQLite database`);
    }

  } catch (error) {
    if (error instanceof GuardrailError) {
      logger.warn({ request_id: requestId, kind: 'guardrail_blocked', reason: error.reason }, `${logPrefix} Message blocked by guardrail`);
      return;
    }
    logger.error({ request_id: requestId, kind: 'request_error', error: error.message }, `${logPrefix} Error processing message`);
  }
};

