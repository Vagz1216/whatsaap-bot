import { searchProperties } from '../stayez/api.js';
import db from '../db/index.js';
import { query } from '../db/pg.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Search for nearby contacts in the tenant's PostgreSQL contacts table.
 * @param {object} extractedData - Classifier output with location, dates, etc.
 * @param {object} tenantConfig - Tenant configuration with organization_id
 * @returns {Promise<Array<{name: string, whatsapp_number: string, region: string}>>}
 */
const findNearbyContacts = async (extractedData, tenantConfig) => {
  const locationStr = `%${(extractedData.location || '').toLowerCase()}%`;
  const result = await query(
    `SELECT name, whatsapp_number, region, sub_area, tags, notes
     FROM contacts
     WHERE organization_id = $1 AND (LOWER(region) LIKE $2 OR LOWER(sub_area) LIKE $2)
     LIMIT 3`,
    [tenantConfig.organization_id, locationStr]
  );
  return result.rows;
};

/**
 * Match extracted lead data against WooCommerce inventory and local/tenant contacts.
 * Returns a match result describing what was found (direct match, nearby hosts, or nothing).
 *
 * @param {object} extractedData - Parsed data from classifier (location, check_in, guests, etc.)
 * @param {object|string[]} tenantConfigOrMissing - Tenant config object (SaaS) or legacy missing details array
 * @returns {Promise<{matchType: string, properties?: object[], hosts?: object[], wooCommerceError?: boolean}>}
 */
export const runMatcher = async (extractedData, tenantConfigOrMissing = {}) => {
  try {
    // Handle dual-mode: if an array is passed (legacy), treat as missingDetails
    // If an object is passed (SaaS or empty), treat as tenantConfig
    const missingDetails = Array.isArray(tenantConfigOrMissing) ? tenantConfigOrMissing : [];

    // If critical details are missing, we skip matching completely
    if (missingDetails.includes('location') || missingDetails.includes('check_in')) {
      return { matchType: 'incomplete_data' };
    }

    // 1. Search WooCommerce
    const criteria = {
      location: extractedData.location || '',
      check_in: extractedData.check_in || '',
      check_out: extractedData.check_out || '',
      guests_max: extractedData.guests || 1
    };

    logger.info({ kind: 'matcher_search', criteria }, 'Searching WooCommerce inventory');

    // Soft-filter properties based on API
    let matchedProperties = [];
    let wooCommerceError = false;
    const isSaaS = !Array.isArray(tenantConfigOrMissing);
    
    try {
      const response = await searchProperties(criteria, isSaaS ? tenantConfigOrMissing : null);
      logger.debug(
        { kind: 'matcher_wc_response', snippet: JSON.stringify(response).substring(0, 500) },
        'WooCommerce raw response'
      );
      // API returns { success: true, count: N, products: [...] }
      const properties = response.products || response;
      if (Array.isArray(properties) && properties.length > 0) {
        matchedProperties = properties.slice(0, 3); // top 3 matches
        logger.info({ kind: 'matcher_direct_match', count: matchedProperties.length }, 'Found direct WooCommerce matches');
      } else {
        logger.info({ kind: 'matcher_no_wc_match' }, 'WooCommerce returned 0 matching properties');
      }
    } catch (e) {
      logger.warn({ kind: 'matcher_wc_error', error: e.message }, 'Failed to search WooCommerce');
      wooCommerceError = true; // Flag so drafter doesn't falsely say "no properties"
    }

    if (matchedProperties.length > 0) {
      return {
        matchType: 'direct',
        properties: matchedProperties
      };
    }

    // 2. If no match (or WooCommerce unreachable), search tenant contacts in SaaS,
    // otherwise use the local SQLite host list.
    let nearbyHosts = [];
    if (isSaaS && tenantConfigOrMissing.organization_id) {
      try {
        nearbyHosts = await findNearbyContacts(extractedData, tenantConfigOrMissing);
      } catch (error) {
        logger.warn({ kind: 'matcher_contacts_error', error: error.message }, 'Failed to search tenant contacts');
      }
    } else {
      const locationStr = `%${(extractedData.location || '').toLowerCase()}%`;
      nearbyHosts = db.prepare(`
        SELECT * FROM local_hosts
        WHERE LOWER(region) LIKE ? OR LOWER(sub_area) LIKE ?
        LIMIT 3
      `).all(locationStr, locationStr);
    }

    logger.info(
      { kind: 'matcher_fallback', count: nearbyHosts.length, location: extractedData.location },
      `Fallback found ${nearbyHosts.length} nearby contact(s)`
    );

    return {
      matchType: 'nearby',
      hosts: nearbyHosts,
      wooCommerceError // Pass this through so drafter can handle gracefully
    };

  } catch (error) {
    logger.error({ kind: 'matcher_error', error: error.message }, 'Matcher failed');
    return { matchType: 'none' };
  }
};
