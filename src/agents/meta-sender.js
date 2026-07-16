import fetch from 'node-fetch';

/**
 * Sends a message back to a Facebook or Instagram user via the Meta Graph API.
 * @param {string} platform 'facebook' or 'instagram'
 * @param {string} recipientId The sender_external_id (PSID or IGSID)
 * @param {string} messageText The draft text to send
 * @param {object} tenantConfig Optional multi-tenant config
 */
export const sendMetaMessage = async (platform, recipientId, messageText, tenantConfig = null) => {
  const isSaaS = tenantConfig !== null;
  const accessToken = isSaaS ? tenantConfig.meta_access_token_secret : process.env.META_ACCESS_TOKEN;
  
  if (!accessToken) {
    throw new Error('META_ACCESS_TOKEN is not configured.');
  }

  // Both FB and IG use the same /me/messages endpoint when using a Page Access Token
  const url = `https://graph.facebook.com/v19.0/me/messages`;

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText },
    messaging_type: 'RESPONSE' // Indicates this is within the 24-hour window
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Meta API Error: ${data.error?.message || JSON.stringify(data)}`);
  }

  return data;
};

/**
 * Fetches the public profile (username/name) of a Meta user using their Scoped ID
 * @param {string} userId The sender_external_id
 * @param {object} tenantConfig Optional multi-tenant config
 */
export const fetchMetaProfile = async (userId, tenantConfig = null) => {
  const isSaaS = tenantConfig !== null;
  const accessToken = isSaaS ? tenantConfig.meta_access_token_secret : process.env.META_ACCESS_TOKEN;
  
  if (!accessToken) return null;
  
  try {
    const url = `https://graph.facebook.com/v19.0/${userId}?fields=name,username&access_token=${accessToken}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    
    const data = await response.json();
    // Return username if it exists (Instagram), otherwise name (Facebook)
    return data.username || data.name || null;
  } catch (error) {
    console.error(`[Meta] Failed to fetch profile for ${userId}: ${error.message}`);
    return null;
  }
};
