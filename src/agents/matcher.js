import { searchProperties } from '../stayez/api.js';
import db from '../db/index.js';

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

    console.log('[Matcher] Searching WooCommerce with criteria:', JSON.stringify(criteria));

    // Soft-filter properties based on API
    let matchedProperties = [];
    let wooCommerceError = false;
    const isSaaS = !Array.isArray(tenantConfigOrMissing);
    
    try {
      const response = await searchProperties(criteria, isSaaS ? tenantConfigOrMissing : null);
      console.log('[Matcher] WooCommerce raw response:', JSON.stringify(response).substring(0, 500));
      // API returns { success: true, count: N, products: [...] }
      const properties = response.products || response;
      if (Array.isArray(properties) && properties.length > 0) {
        matchedProperties = properties.slice(0, 3); // top 3 matches
        console.log(`[Matcher] Found ${matchedProperties.length} direct matches`);
      } else {
        console.log('[Matcher] WooCommerce returned 0 matching properties');
      }
    } catch (e) {
      console.warn(`[Matcher] Failed to search WooCommerce: ${e.message}`);
      wooCommerceError = true; // Flag so drafter doesn't falsely say "no properties"
    }

    if (matchedProperties.length > 0) {
      return {
        matchType: 'direct',
        properties: matchedProperties
      };
    }

    // 2. If no match (or WooCommerce unreachable), search local SQLite
    const locationStr = `%${(extractedData.location || '').toLowerCase()}%`;
    const nearbyHosts = db.prepare(`
      SELECT * FROM local_hosts 
      WHERE LOWER(region) LIKE ? OR LOWER(sub_area) LIKE ?
      LIMIT 3
    `).all(locationStr, locationStr);

    console.log(`[Matcher] SQLite fallback found ${nearbyHosts.length} nearby hosts for "${extractedData.location}"`);

    return {
      matchType: 'nearby',
      hosts: nearbyHosts,
      wooCommerceError // Pass this through so drafter can handle gracefully
    };

  } catch (error) {
    console.error(`[Matcher] Error: ${error.message}`);
    return { matchType: 'none' };
  }
};
