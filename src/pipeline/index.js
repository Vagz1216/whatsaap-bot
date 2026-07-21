import { runClassifier } from '../agents/classifier.js';
import { runMatcher } from '../agents/matcher.js';
import { runDrafter } from '../agents/drafter.js';
import { fetchMetaProfile } from '../agents/meta-sender.js';
import { sendCards } from '../telegram/index.js';
import db from '../db/index.js';
import { query } from '../db/pg.js';
import { claimInboundMessage, markInboundMessageStatus } from '../db/listener-state.js';
import { validateInboundMessage, GuardrailError } from '../guardrails/index.js';
import { normalizeInboundMessage } from '../schema/inbound-message.js';
import { randomUUID } from 'crypto';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const isUndefinedPostgresColumn = (error) => error?.code === '42703';

const insertSaasLead = async (safeMsgData, classification, tenantConfig) => {
  const { language, extracted_data, confidence } = classification;
  const extendedInsert = `
    INSERT INTO leads (
      organization_id, source_type, source_id, source_name, source_platform, source_channel,
      source_group_name, external_message_id, sender_external_id, received_at, contactability_status,
      metadata, sender_number, sender_name, raw_message, detected_language, extracted_data,
      classifier_confidence, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'processing')
    RETURNING id
  `;
  const extendedParams = [
    tenantConfig.organization_id,
    safeMsgData.source_type,
    safeMsgData.source_id,
    safeMsgData.source_name,
    safeMsgData.source_platform,
    safeMsgData.source_channel,
    safeMsgData.source_group_name,
    safeMsgData.external_message_id,
    safeMsgData.sender_external_id,
    safeMsgData.received_at,
    safeMsgData.contactability_status,
    JSON.stringify(safeMsgData.metadata || {}),
    safeMsgData.sender_number,
    safeMsgData.sender_name,
    safeMsgData.raw_message,
    language,
    JSON.stringify(extracted_data),
    confidence
  ];

  try {
    const result = await query(extendedInsert, extendedParams);
    return result.rows[0].id;
  } catch (error) {
    if (!isUndefinedPostgresColumn(error)) throw error;
    logger.warn(
      { kind: 'schema_fallback', table: 'leads', missing: 'social_listener_columns' },
      'Postgres leads table is missing social listener columns; using legacy insert'
    );
  }

  const legacyInsert = `
    INSERT INTO leads (
      organization_id, source_type, source_id, source_name, sender_number, sender_name,
      raw_message, detected_language, extracted_data, classifier_confidence, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'processing')
    RETURNING id
  `;
  const result = await query(legacyInsert, [
    tenantConfig.organization_id,
    safeMsgData.source_type,
    safeMsgData.source_id,
    safeMsgData.source_name,
    safeMsgData.sender_number,
    safeMsgData.sender_name,
    safeMsgData.raw_message,
    language,
    JSON.stringify(extracted_data),
    confidence
  ]);
  return result.rows[0].id;
};

const insertLocalLead = (safeMsgData, classification) => {
  const { language, extracted_data, confidence } = classification;
  const missingDetailsJson = classification.missing_critical_details && classification.missing_critical_details.length > 0
    ? JSON.stringify(classification.missing_critical_details) : null;

  const insertStmt = db.prepare(`
    INSERT INTO leads (
      source_type, source_id, source_name, source_platform, source_channel, source_group_name,
      external_message_id, sender_external_id, received_at, contactability_status, metadata,
      sender_number, sender_name, raw_message, detected_language, location, check_in, check_out,
      guests, budget, special_notes, missing_details, classifier_confidence, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')
  `);

  const result = insertStmt.run(
    safeMsgData.source_type,
    safeMsgData.source_id,
    safeMsgData.source_name,
    safeMsgData.source_platform,
    safeMsgData.source_channel,
    safeMsgData.source_group_name,
    safeMsgData.external_message_id,
    safeMsgData.sender_external_id,
    safeMsgData.received_at,
    safeMsgData.contactability_status,
    JSON.stringify(safeMsgData.metadata || {}),
    safeMsgData.sender_number,
    safeMsgData.sender_name,
    safeMsgData.raw_message,
    language,
    extracted_data.location,
    extracted_data.check_in,
    extracted_data.check_out,
    extracted_data.guests ? String(extracted_data.guests) : null,
    extracted_data.budget,
    extracted_data.special_notes,
    missingDetailsJson,
    confidence
  );
  return result.lastInsertRowid;
};

// Robust keyword and heuristic filter to save LLM tokens
const isLikelyLeadRequest = (text) => {
  const lower = text.toLowerCase();
  
  // 1. Hard limits (too short or too long are unlikely to be genuine lead requests)
  // Short messages are already filtered in monitor.js (< 15 chars)
  if (lower.length > 600) return false; // Long forwards, news, or spam

  // 2. Negative Keywords (Blacklist) - drop obvious non-requests
  const blacklist = [
    'http', 'www', '.com', '.co.ke', // Links are usually spam or promotions
    'job', 'vacancy', 'hiring', 'cv', 'interview', // Job postings
    'news', 'breaking', 'politics', 'update', // News forwards
    'subscribe', 'youtube', 'tiktok', 'instagram', 'follow' // Social media spam
  ];
  if (blacklist.some(k => lower.includes(k))) return false;

  // 3. Positive Keywords (Whitelist) - require at least one strong intent indicator
  const keywords = [
    'quote', 'price', 'pricing', 'cost', 'budget', 'kes', 'ksh', 'shilling',
    'book', 'booking', 'reserve', 'reservation', 'available', 'availability',
    'looking for', 'need', 'need a', 'needs a', 'client needs', 'interested',
    'demo', 'trial', 'consultation', 'order', 'buy', 'rent', 'hire',
    'natafuta', 'nahitaji', 'bei', 'ngapi', 'available?'
  ];
  
  // Return true if at least one positive keyword is found
  return keywords.some(k => lower.includes(k));
};

export const processMessage = async (msgData, tenantConfig = null) => {
  const requestId = randomUUID();
  const isSaaS = tenantConfig !== null;
  const logPrefix = isSaaS ? `[Tenant: ${tenantConfig.organization_name}]` : '[Local StayEZ]';
  let safeMsgData = null;
  const metrics = { t_start: Date.now() };
  
  try {
    const normalizedMsgData = normalizeInboundMessage(msgData, tenantConfig);
    safeMsgData = normalizedMsgData;
    logger.info(
      {
        request_id: requestId,
        kind: 'request_start',
        source_platform: normalizedMsgData.source_platform,
        source_channel: normalizedMsgData.source_channel,
        external_message_id: normalizedMsgData.external_message_id,
        sender_number: normalizedMsgData.sender_number,
        contactability_status: normalizedMsgData.contactability_status
      },
      `${logPrefix} Processing new message`
    );

    const claim = await claimInboundMessage(normalizedMsgData, tenantConfig);
    if (!claim.claimed) {
      logger.info(
        { request_id: requestId, kind: 'message_ignored', reason: 'duplicate_message' },
        `${logPrefix} Duplicate inbound message ignored`
      );
      return;
    }

    const safeMessage = validateInboundMessage(normalizedMsgData.raw_message);
    safeMsgData = { ...normalizedMsgData, raw_message: safeMessage };

    // Fetch real profile name from Meta if missing
    if ((safeMsgData.source_platform === 'instagram' || safeMsgData.source_platform === 'facebook') && safeMsgData.sender_name === 'Unknown') {
      try {
        const realName = await fetchMetaProfile(safeMsgData.sender_external_id, tenantConfig);
        if (realName) safeMsgData.sender_name = realName;
      } catch (err) {
        logger.warn({ kind: 'profile_fetch_error', error: err.message }, 'Could not fetch Meta profile name');
      }
    }

    const lower = safeMsgData.raw_message.toLowerCase();

    // 0. Pre-filter
    if (isSaaS) {
      if (tenantConfig.keyword_blacklist && tenantConfig.keyword_blacklist.some(k => lower.includes(k.toLowerCase()))) {
        logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'blacklist_filter' }, `${logPrefix} Message ignored by tenant blacklist`);
        await markInboundMessageStatus(safeMsgData, 'ignored_blacklist', { tenantConfig });
        return;
      }
      if (tenantConfig.keyword_whitelist && tenantConfig.keyword_whitelist.length > 0) {
        if (!tenantConfig.keyword_whitelist.some(k => lower.includes(k.toLowerCase()))) {
          logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'whitelist_filter' }, `${logPrefix} Message ignored (no whitelist match)`);
          await markInboundMessageStatus(safeMsgData, 'ignored_whitelist', { tenantConfig });
          return;
        }
      }
    } else {
      if (!isLikelyLeadRequest(safeMsgData.raw_message)) {
        logger.info({ request_id: requestId, kind: 'message_ignored', reason: 'keyword_filter' }, `${logPrefix} Message ignored by keyword filter`);
        await markInboundMessageStatus(safeMsgData, 'ignored_keyword', { tenantConfig });
        return;
      }
    }

    // 1. Classify
    metrics.t_classify_start = Date.now();
    const classification = await runClassifier(safeMsgData.raw_message, tenantConfig || {}, safeMsgData);
    metrics.t_classify_end = Date.now();
    if (!classification) {
      logger.debug({ request_id: requestId, kind: 'message_ignored', reason: 'classification' }, `${logPrefix} Message ignored by classifier`);
      await markInboundMessageStatus(safeMsgData, 'ignored_classification', { tenantConfig });
      return;
    }

    const { language, extracted_data, confidence } = classification;
    logger.info({ request_id: requestId, kind: 'classification_complete', confidence }, `${logPrefix} Valid request detected`);

    // 2. Insert Lead (Handle Postgres vs SQLite)
    let leadId;
    let finalLead;

    if (isSaaS) {
      leadId = await insertSaasLead(safeMsgData, classification, tenantConfig);
    } else {
      leadId = insertLocalLead(safeMsgData, classification);
    }
    await markInboundMessageStatus(safeMsgData, 'lead_created', { leadId, tenantConfig });

    const lead = {
      id: leadId,
      ...safeMsgData,
      detected_language: language,
      missing_critical_details: classification.missing_critical_details,
      ...extracted_data
    };

    // 3. Match & Draft
    metrics.t_match_draft_start = Date.now();
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
    metrics.t_match_draft_end = Date.now();

    // 4. Update DB
    if (isSaaS) {
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
    const pipeline_stage_durations_ms = {
      classifier: metrics.t_classify_end - metrics.t_classify_start,
      match_and_draft: metrics.t_match_draft_end - metrics.t_match_draft_start,
      total: Date.now() - metrics.t_start
    };

    if (isSaaS) {
      await query("UPDATE leads SET status = 'delivered' WHERE id = $1", [leadId]);
      await markInboundMessageStatus(safeMsgData, 'delivered', { leadId, tenantConfig });
      logger.info({ request_id: requestId, kind: 'request_complete', lead_id: leadId, pipeline_stage_durations_ms }, `${logPrefix} Marked lead as delivered in DB`);
    } else {
      db.prepare("UPDATE leads SET status = 'delivered', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(leadId);
      await markInboundMessageStatus(safeMsgData, 'delivered', { leadId, tenantConfig });
      logger.info({ request_id: requestId, kind: 'request_complete', lead_id: leadId, pipeline_stage_durations_ms }, `${logPrefix} Marked lead as delivered in local database`);
    }

  } catch (error) {
    if (error instanceof GuardrailError) {
      logger.warn({ request_id: requestId, kind: 'guardrail_blocked', reason: error.reason }, `${logPrefix} Message blocked by guardrail`);
      if (safeMsgData) {
        await markInboundMessageStatus(safeMsgData, 'blocked_guardrail', { error: error.reason, tenantConfig });
      }
      return;
    }
    logger.error({ request_id: requestId, kind: 'request_error', error: error.message }, `${logPrefix} Error processing message`);
    if (safeMsgData) {
      await markInboundMessageStatus(safeMsgData, 'error', { error: error.message, tenantConfig });
    }
  }
};
