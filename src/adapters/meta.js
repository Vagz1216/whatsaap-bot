const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim());

const metaPlatformForObject = (objectName) => {
  const value = String(objectName || '').toLowerCase();
  if (value.includes('instagram')) return 'instagram';
  return 'facebook';
};

const makeMessage = ({
  platform,
  sourceType,
  sourceId,
  sourceName,
  messageId,
  senderId,
  senderName,
  text,
  timestamp,
  metadata = {}
}) => ({
  source_platform: platform,
  source_type: sourceType,
  source_channel: `${platform}_${sourceType}`,
  source_id: sourceId || 'unknown',
  source_name: sourceName || platform,
  source_group_name: sourceType === 'group' || sourceType === 'comment' ? sourceName || platform : null,
  message_id: messageId,
  external_message_id: messageId,
  sender_external_id: senderId || 'unknown',
  sender_number: senderId ? `${platform}:${senderId}` : `${platform}:unknown`,
  sender_name: senderName || 'Unknown',
  raw_message: text,
  received_at: timestamp ? new Date(Number(timestamp)).toISOString() : new Date().toISOString(),
  contactability_status: 'platform_reply_required',
  metadata
});

const extractMessagingEvent = (entry, event, platform) => {
  const text = firstText(
    event.message?.text,
    event.messaging?.message?.text,
    event.postback?.title,
    event.postback?.payload
  );
  if (!text) return null;

  const senderId = event.sender?.id || event.from?.id;
  const recipientId = event.recipient?.id || entry.id;
  const messageId = event.message?.mid || event.postback?.mid || event.timestamp || `${entry.id}:${senderId}:${text}`;

  return makeMessage({
    platform,
    sourceType: 'dm',
    sourceId: recipientId,
    sourceName: platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger',
    messageId,
    senderId,
    senderName: event.sender?.name || event.from?.name,
    text,
    timestamp: event.timestamp || entry.time,
    metadata: {
      meta_object: platform,
      entry_id: entry.id,
      event_type: event.message ? 'message' : 'postback',
      raw_event: event
    }
  });
};

const extractChangeEvent = (entry, change, platform) => {
  const value = change.value || {};
  const text = firstText(
    value.text,
    value.message,
    value.comment?.text,
    value.comment?.message,
    value.post?.message,
    value.caption
  );
  if (!text) return null;

  const senderId = value.from?.id || value.sender_id || value.user_id || value.comment?.from?.id;
  const senderName = value.from?.name || value.username || value.comment?.from?.username;
  const commentId = value.comment_id || value.comment?.id || value.id || value.media_id || change.field;
  const sourceType = String(change.field || '').includes('messages') ? 'dm' : 'comment';

  return makeMessage({
    platform,
    sourceType,
    sourceId: value.media_id || value.post_id || value.parent_id || entry.id,
    sourceName: platform === 'instagram' ? 'Instagram Comment' : 'Facebook Comment',
    messageId: commentId,
    senderId,
    senderName,
    text,
    timestamp: value.created_time ? Date.parse(value.created_time) : entry.time,
    metadata: {
      meta_object: platform,
      entry_id: entry.id,
      field: change.field,
      raw_change: change
    }
  });
};

export const extractMetaMessages = (payload = {}) => {
  const platform = metaPlatformForObject(payload.object);
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const messages = [];

  for (const entry of entries) {
    for (const event of entry.messaging || []) {
      const message = extractMessagingEvent(entry, event, platform);
      if (message) messages.push(message);
    }

    for (const change of entry.changes || []) {
      const message = extractChangeEvent(entry, change, platform);
      if (message) messages.push(message);
    }
  }

  return messages;
};

export const verifyMetaWebhook = (query = {}) => {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    return { ok: true, challenge: challenge || '' };
  }
  return { ok: false };
};
