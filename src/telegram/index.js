import TelegramBot from 'node-telegram-bot-api';
import db from '../db/index.js';
import { sendMetaMessage } from '../agents/meta-sender.js';const botCache = new Map();

const getBot = (token) => {
  if (botCache.has(token)) return botCache.get(token);

  const enableCallbacks = process.env.TELEGRAM_ENABLE_CALLBACKS !== 'false';
  const bot = new TelegramBot(token, { polling: enableCallbacks });

  if (enableCallbacks) {
    bot.on('callback_query', async (query) => {
      const data = query.data || '';
      const action = data.split(':')[1] || 'unknown';
      const leadId = data.split(':')[2];

      try {
        if (action === 'reply' && leadId) {
          const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
          if (!lead) {
            await bot.answerCallbackQuery(query.id, { text: 'Lead not found.', show_alert: true });
            return;
          }
          
          const platform = (lead.source_platform || 'whatsapp').toLowerCase();
          
          if (platform === 'whatsapp') {
            await bot.answerCallbackQuery(query.id, { text: 'Automated WhatsApp sending is intentionally disabled to protect your number. Reply manually.', show_alert: true });
            return;
          }

          if (platform === 'facebook' || platform === 'instagram') {
            if (!lead.draft_to_client) {
              await bot.answerCallbackQuery(query.id, { text: 'No draft available to send.', show_alert: true });
              return;
            }
            
            const draftObj = typeof lead.draft_to_client === 'string' ? JSON.parse(lead.draft_to_client) : lead.draft_to_client;
            const messageText = draftObj.message;

            await sendMetaMessage(platform, lead.sender_external_id, messageText);
            
            // Edit the message keyboard to show it was sent
            try {
              await bot.editMessageReplyMarkup({
                inline_keyboard: [[{ text: `✅ Sent via ${platform}`, callback_data: 'noop' }]]
              }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
            } catch (e) {
              // Ignore if message wasn't modified
            }

            await bot.answerCallbackQuery(query.id, { text: 'Message Sent!' });
            return;
          }
          
          await bot.answerCallbackQuery(query.id, { text: `Auto-reply not supported for ${platform} yet.`, show_alert: true });
          return;
        }

        const messages = {
          enroll: 'Enrollment is a placeholder until the SDR inbound-leads API contract is finalized.',
          view: 'Profile lookup will open in the SDR dashboard after the scout-to-CRM API is connected.',
          replied: 'Mark-replied is a placeholder until Telegram actions are connected to the platform API.',
          ignore: 'Ignore is a placeholder until suppression rules are connected to the platform API.'
        };

        await bot.answerCallbackQuery(query.id, {
          text: messages[action] || 'This action is not connected yet.',
          show_alert: action === 'enroll'
        });
      } catch (error) {
        console.warn(`[Telegram] Failed to answer callback query: ${error.message}`);
        await bot.answerCallbackQuery(query.id, { text: `Error: ${error.message.substring(0, 50)}`, show_alert: true }).catch(()=>null);
      }
    });
  }

  botCache.set(token, bot);
  return bot;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const humanizeValue = (value) => String(value || 'unknown').replace(/_/g, ' ');

const searchSnippet = (text) => {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 90) return cleaned;
  return cleaned.slice(0, 90).trim();
};

const actionInstructions = (lead, isHiddenId) => {
  const platform = lead.source_platform || 'whatsapp';
  const channel = lead.source_channel || lead.source_type || '';
  const snippet = searchSnippet(lead.raw_message);

  if (platform === 'whatsapp' && isHiddenId) {
    return `
⚠️ <b>How to reply to this WhatsApp group lead:</b>
1. Open <b>${escapeHtml(lead.source_name || 'the WhatsApp group')}</b>.
2. Use WhatsApp search and paste: <code>${escapeHtml(snippet)}</code>
3. Open the matching message.
4. Long-press or open message options, then use <b>Reply privately</b> if available.
5. If Reply privately is unavailable, quote-reply in the group.`;
  }

  if (platform === 'whatsapp') {
    return `
⚠️ <b>How to reply:</b>
1. Use the number above or search this message in <b>${escapeHtml(lead.source_name || 'WhatsApp')}</b>.
2. Send the drafted reply manually.`;
  }

  if (platform === 'instagram' && channel.includes('comment')) {
    return `
⚠️ <b>How to reply on Instagram:</b>
1. Open the Instagram post/comment thread.
2. Search or match this text: <code>${escapeHtml(snippet)}</code>
3. Reply publicly only with safe general wording, or move to DM for details.`;
  }

  if (platform === 'instagram') {
    return `
⚠️ <b>How to reply on Instagram DM:</b>
Open the Instagram inbox/thread for <b>${escapeHtml(lead.sender_name || 'this user')}</b> and send the drafted reply manually.`;
  }

  if (platform === 'facebook' && channel.includes('comment')) {
    return `
⚠️ <b>How to reply on Facebook:</b>
1. Open the Facebook post/comment thread.
2. Search or match this text: <code>${escapeHtml(snippet)}</code>
3. Reply publicly with general wording, or move to Messenger for details.`;
  }

  if (platform === 'facebook') {
    return `
⚠️ <b>How to reply on Messenger:</b>
Open the Messenger/Page inbox thread for <b>${escapeHtml(lead.sender_name || 'this user')}</b> and send the drafted reply manually.`;
  }

  if (platform === 'tiktok') {
    return `
⚠️ <b>How to reply on TikTok:</b>
Open the TikTok comment or inbox event, match this text: <code>${escapeHtml(snippet)}</code>, then reply manually.`;
  }

  return `
⚠️ <b>How to reply:</b>
Open the source platform, match this text: <code>${escapeHtml(snippet)}</code>, and send the drafted reply manually.`;
};

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

  const bot = getBot(token);

  try {
    const isHiddenId = lead.sender_number && lead.sender_number.includes('Hidden-ID');
    const numberDisplay = isHiddenId
      ? `🔒 <b>HIDDEN NUMBER</b> (Privacy ID: <code>${escapeHtml(lead.sender_number)}</code>)`
      : escapeHtml(lead.sender_number);
    
    const instructions = actionInstructions(lead, isHiddenId);

    let profileUrl = null;
    const platform = (lead.source_platform || 'whatsapp').toLowerCase();
    if (platform === 'whatsapp' && lead.sender_number && !isHiddenId) {
      const cleanNum = lead.sender_number.replace(/[^0-9]/g, '');
      if (cleanNum) profileUrl = `https://wa.me/${cleanNum}`;
    } else if (platform === 'instagram' && lead.sender_name) {
      profileUrl = `https://instagram.com/${encodeURIComponent(lead.sender_name)}`;
    } else if (platform === 'facebook' && lead.sender_external_id) {
      profileUrl = `https://facebook.com/${encodeURIComponent(lead.sender_external_id)}`;
    } else if (platform === 'telegram' && lead.sender_external_id) {
      profileUrl = `tg://user?id=${encodeURIComponent(lead.sender_external_id)}`;
    }

    const viewProfileBtn = profileUrl 
      ? { text: 'View Profile ↗️', url: profileUrl } 
      : { text: 'View Profile', callback_data: `scout:view:${lead.id}` };

    const card1 = `<b>New Lead for ${escapeHtml(orgName)}!</b>
<b>Lead ID:</b> #${escapeHtml(lead.id)}
<b>Name:</b> ${escapeHtml(lead.sender_name || 'Unknown')}
<b>Number:</b> ${numberDisplay}
<b>Source:</b> ${escapeHtml(lead.source_type)} (${escapeHtml(lead.source_name || lead.source_id)})
<b>Channel:</b> ${escapeHtml(humanizeValue(lead.source_channel || 'whatsapp'))}
<b>Contactability:</b> ${escapeHtml(humanizeValue(lead.contactability_status || 'unknown'))}
<b>Language:</b> ${escapeHtml(lead.detected_language || 'N/A')}
<b>Search Hint:</b> <code>${escapeHtml(searchSnippet(lead.raw_message))}</code>

<b>Original Message:</b>
${escapeHtml(lead.raw_message)}
${instructions}`;
    await sendWithRetry(bot, chatId, card1, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Reply', callback_data: `scout:reply:${lead.id}` },
            { text: 'Enroll', callback_data: `scout:enroll:${lead.id}` }
          ],
          [
            viewProfileBtn,
            { text: 'Mark Replied', callback_data: `scout:replied:${lead.id}` },
            { text: 'Ignore', callback_data: `scout:ignore:${lead.id}` }
          ]
        ]
      }
    });

    // Ensure extracted items are parsed
    const extractedData = lead.extracted_data ? 
      (typeof lead.extracted_data === 'string' ? JSON.parse(lead.extracted_data) : lead.extracted_data) : {};

    if (Object.keys(extractedData).length > 0) {
        let extractedStr = '<b>Extracted Data:</b>\n';
        for (const [k, v] of Object.entries(extractedData)) {
            extractedStr += `- ${escapeHtml(k)}: ${escapeHtml(v)}\n`;
        }
        await sendWithRetry(bot, chatId, extractedStr, { parse_mode: 'HTML' });
    }

    // Card 2: Draft to client
    if (lead.draft_to_client) {
      const draftToClient = typeof lead.draft_to_client === 'string' 
        ? JSON.parse(lead.draft_to_client) 
        : lead.draft_to_client;
      
      const card2 = `<b>Draft to Client</b>
👤 Send to: ${escapeHtml(draftToClient.to_name || 'Client')} — ${escapeHtml(draftToClient.to_number)}

<pre>${escapeHtml(draftToClient.message)}</pre>`;
      await sendWithRetry(bot, chatId, card2, { parse_mode: 'HTML' });
    }

    // Card 3a: Draft to source (Generic/Matched Host)
    if (lead.draft_to_source) {
      const draftToSource = typeof lead.draft_to_source === 'string'
        ? JSON.parse(lead.draft_to_source)
        : lead.draft_to_source;
        
      const card3a = `<b>Draft to Source</b>
👤 Send to: ${escapeHtml(draftToSource.to_name || 'Source')} — ${escapeHtml(draftToSource.to_number)}

<pre>${escapeHtml(draftToSource.message)}</pre>`;
      await sendWithRetry(bot, chatId, card3a, { parse_mode: 'HTML' });
    }

    // Card 3b: Drafts to contacts (Generic/Nearby Hosts)
    if (lead.drafts_to_contacts) {
      const contacts = typeof lead.drafts_to_contacts === 'string'
        ? JSON.parse(lead.drafts_to_contacts)
        : lead.drafts_to_contacts;
      
      for (const contact of contacts) {
        const card3b = `<b>Draft to Contact</b>
👤 Send to: ${escapeHtml(contact.to_name || 'Contact')} — ${escapeHtml(contact.to_number)}

<pre>${escapeHtml(contact.message)}</pre>`;
        await sendWithRetry(bot, chatId, card3b, { parse_mode: 'HTML' });
      }
    }

  } catch (error) {
    console.error(`[Telegram] Failed to send cards for ${orgName}: ${error.message}`);
    throw error;
  }
};
