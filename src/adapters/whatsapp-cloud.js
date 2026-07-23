export const verifyWhatsAppCloudWebhook = (query = {}) => {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expectedToken = process.env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    return { ok: true, challenge: challenge || '' };
  }
  return { ok: false };
};

const messageText = (message = {}) => {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.caption) return message.caption;
  return '';
};

export const extractWhatsAppCloudMessages = (payload = {}) => {
  const messages = [];
  if (payload.object !== 'whatsapp_business_account') return messages;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const metadata = value.metadata || {};
      const contactsByWaId = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact]));

      for (const message of value.messages || []) {
        const text = messageText(message).trim();
        if (!text) continue;

        const contact = contactsByWaId.get(message.from) || {};
        const phoneNumberId = metadata.phone_number_id || null;
        const displayNumber = metadata.display_phone_number || null;

        messages.push({
          source_platform: 'whatsapp_cloud',
          source_type: 'dm',
          source_channel: 'whatsapp_cloud_dm',
          source_id: phoneNumberId || entry.id || 'whatsapp-cloud',
          source_name: displayNumber ? `WhatsApp Business ${displayNumber}` : 'WhatsApp Business',
          source_group_name: null,
          message_id: message.id,
          external_message_id: message.id,
          sender_external_id: message.from,
          sender_number: message.from ? `+${message.from}` : 'whatsapp-cloud:unknown',
          sender_name: contact.profile?.name || 'WhatsApp User',
          raw_message: text,
          received_at: message.timestamp
            ? new Date(Number(message.timestamp) * 1000).toISOString()
            : new Date().toISOString(),
          contactability_status: 'direct_contact_available',
          metadata: {
            phone_number_id: phoneNumberId,
            display_phone_number: displayNumber,
            waba_id: entry.id || null,
            message_type: message.type || 'text',
            webhook_adapter: 'whatsapp_cloud'
          }
        });
      }
    }
  }

  return messages;
};
