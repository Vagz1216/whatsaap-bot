import TelegramBot from 'node-telegram-bot-api';

// Retry wrapper for transient network errors (EFATAL, ETIMEDOUT, etc.)
const sendWithRetry = async (bot, chatId, text, options, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (err) {
      const isTransient = err.message && (
        err.message.includes('EFATAL') || 
        err.message.includes('ETIMEDOUT') || 
        err.message.includes('ECONNRESET') ||
        err.message.includes('fetch failed')
      );
      if (isTransient && attempt < maxRetries) {
        const delay = attempt * 2000; // 2s, 4s backoff
        console.warn(`[Telegram] Send failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err; // Non-transient or final attempt — let caller handle
      }
    }
  }
};

export const sendCards = async (lead, tenantConfig = null) => {
  const isSaaS = tenantConfig !== null;
  const token = isSaaS ? tenantConfig.telegram_bot_token_secret : process.env.TELEGRAM_BOT_TOKEN;
  const chatId = isSaaS ? tenantConfig.telegram_chat_id : process.env.TELEGRAM_CHAT_ID;
  const orgName = isSaaS ? tenantConfig.organization_name : 'Local StayEZ';

  if (!token || !chatId) {
    console.warn(`[Telegram] Bot not configured for ${orgName}. Skipping notification.`);
    return;
  }

  // Instantiate bot dynamically
  const bot = new TelegramBot(token, { polling: false });

  try {
    const isHiddenId = lead.sender_number && lead.sender_number.includes('Hidden-ID');
    const numberDisplay = isHiddenId 
      ? `🔒 *HIDDEN NUMBER* (Privacy ID: \`${lead.sender_number}\`)`
      : lead.sender_number;
    
    let instructions = '';
    if (isHiddenId) {
      instructions = `
⚠️ *How to reply to this lead:*
1. Open the *${lead.source_name || 'WhatsApp Group'}* group on your phone.
2. Search for the name *"${lead.sender_name}"* or look for their original message below.
3. Quote their message in the group to reply directly.`;
    }

    const card1 = `*New Lead for ${orgName}!*
*Lead ID:* #${lead.id}
*Name:* ${lead.sender_name || 'Unknown'}
*Number:* ${numberDisplay}
*Source:* ${lead.source_type} (${lead.source_name || lead.source_id})
*Language:* ${lead.detected_language || 'N/A'}

*Original Message:*
${lead.raw_message}`;
    await sendWithRetry(bot, chatId, card1, { parse_mode: 'Markdown' });

    // Ensure extracted items are parsed
    const extractedData = lead.extracted_data ? 
      (typeof lead.extracted_data === 'string' ? JSON.parse(lead.extracted_data) : lead.extracted_data) : {};

    if (Object.keys(extractedData).length > 0) {
        let extractedStr = '*Extracted Data:*\n';
        for (const [k, v] of Object.entries(extractedData)) {
            extractedStr += `- ${k}: ${v}\n`;
        }
        await sendWithRetry(bot, chatId, extractedStr, { parse_mode: 'Markdown' });
    }

    // Card 2: Draft to client
    if (lead.draft_to_client) {
      const draftToClient = typeof lead.draft_to_client === 'string' 
        ? JSON.parse(lead.draft_to_client) 
        : lead.draft_to_client;
      
      const card2 = `*Draft to Client*
👤 Send to: ${draftToClient.to_name || 'Client'} — ${draftToClient.to_number}

\`\`\`
${draftToClient.message}
\`\`\``;
      await sendWithRetry(bot, chatId, card2, { parse_mode: 'Markdown' });
    }

    // Card 3a: Draft to source (Generic/Matched Host)
    if (lead.draft_to_source) {
      const draftToSource = typeof lead.draft_to_source === 'string'
        ? JSON.parse(lead.draft_to_source)
        : lead.draft_to_source;
        
      const card3a = `*Draft to Source*
👤 Send to: ${draftToSource.to_name || 'Source'} — ${draftToSource.to_number}

\`\`\`
${draftToSource.message}
\`\`\``;
      await sendWithRetry(bot, chatId, card3a, { parse_mode: 'Markdown' });
    }

    // Card 3b: Drafts to contacts (Generic/Nearby Hosts)
    if (lead.drafts_to_contacts) {
      const contacts = typeof lead.drafts_to_contacts === 'string'
        ? JSON.parse(lead.drafts_to_contacts)
        : lead.drafts_to_contacts;
      
      for (const contact of contacts) {
        const card3b = `*Draft to Contact*
👤 Send to: ${contact.to_name || 'Contact'} — ${contact.to_number}

\`\`\`
${contact.message}
\`\`\``;
        await sendWithRetry(bot, chatId, card3b, { parse_mode: 'Markdown' });
      }
    }

  } catch (error) {
    console.error(`[Telegram] Failed to send cards for ${orgName}: ${error.message}`);
    throw error;
  }
};
