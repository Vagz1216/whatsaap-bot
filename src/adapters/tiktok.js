const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim());

const eventItems = (payload) => {
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [payload];
};

export const extractTikTokMessages = (payload = {}) => {
  const messages = [];

  for (const event of eventItems(payload)) {
    const data = event.data || event.comment || event.message || event;
    const text = firstText(
      data.text,
      data.comment_text,
      data.message,
      data.content,
      data.body
    );
    if (!text) continue;

    const sourceType = data.conversation_id || data.message_id ? 'dm' : 'comment';
    const senderId = data.user_id || data.sender_id || data.open_id || data.from?.id || data.author?.id;
    const senderName = data.username || data.display_name || data.from?.name || data.author?.username;
    const messageId = data.comment_id || data.message_id || event.event_id || data.id || `${senderId}:${text}`;
    const timestamp = data.create_time || data.created_at || event.timestamp;

    messages.push({
      source_platform: 'tiktok',
      source_type: sourceType,
      source_channel: `tiktok_${sourceType}`,
      source_id: data.video_id || data.conversation_id || data.post_id || payload.account_id || 'unknown',
      source_name: sourceType === 'dm' ? 'TikTok DM' : 'TikTok Comment',
      source_group_name: sourceType === 'comment' ? 'TikTok Comment' : null,
      message_id: String(messageId),
      external_message_id: String(messageId),
      sender_external_id: senderId ? String(senderId) : 'unknown',
      sender_number: senderId ? `tiktok:${senderId}` : 'tiktok:unknown',
      sender_name: senderName || 'Unknown',
      raw_message: text,
      received_at: timestamp
        ? new Date(Number(timestamp) > 1000000000000 ? Number(timestamp) : Number(timestamp) * 1000).toISOString()
        : new Date().toISOString(),
      contactability_status: 'platform_reply_required',
      metadata: {
        event_type: event.event || event.type || 'unknown',
        raw_event: event
      }
    });
  }

  return messages;
};

export const verifyTikTokWebhook = (query = {}) => {
  const challenge = query.challenge || query.verify_token || query['hub.challenge'];
  return challenge ? { ok: true, challenge } : { ok: true, challenge: 'ok' };
};
