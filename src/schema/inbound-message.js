import { createHash } from 'crypto';

const WHATSAPP_GROUP_SUFFIX = '@g.us';

const normalizeSourceType = (value, sourcePlatform) => {
  if (value === 'whatsapp_group') return 'group';
  if (value === 'whatsapp_dm') return 'dm';
  if (value === 'group' || value === 'dm') return value;
  if (sourcePlatform === 'whatsapp') return 'dm';
  if (String(value || '').includes('dm')) return 'dm';
  if (String(value || '').includes('comment') || String(value || '').includes('group')) return 'group';
  return 'dm';
};

const normalizeSourceChannel = (value, sourceType, sourcePlatform) => {
  if (value) return value;
  if (sourcePlatform === 'whatsapp' && sourceType === 'group') return 'whatsapp_group';
  if (sourcePlatform === 'whatsapp' && sourceType === 'dm') return 'whatsapp_dm';
  return `${sourcePlatform}_${sourceType}`;
};

const buildFallbackMessageId = (message) => {
  const hash = createHash('sha256')
    .update([
      message.source_platform,
      message.source_id,
      message.sender_external_id,
      message.raw_message,
      message.received_at || ''
    ].join('|'))
    .digest('hex');
  return `generated:${hash}`;
};

export const hashMessageText = (text) => createHash('sha256').update(String(text || '')).digest('hex');

export const normalizeInboundMessage = (rawMessage, tenantConfig = null) => {
  const sourcePlatform = rawMessage.source_platform || 'whatsapp';
  const sourceType = normalizeSourceType(rawMessage.source_type, sourcePlatform);
  const sourceChannel = normalizeSourceChannel(rawMessage.source_channel, sourceType, sourcePlatform);
  const sourceId = rawMessage.source_id || rawMessage.remote_jid || 'unknown';
  const isWhatsappGroup = sourcePlatform === 'whatsapp' && (
    sourceType === 'group' ||
    sourceChannel === 'whatsapp_group' ||
    String(sourceId).endsWith(WHATSAPP_GROUP_SUFFIX)
  );
  const senderNumber = rawMessage.sender_number || rawMessage.sender_external_id || 'unknown';
  const isHiddenSender = String(senderNumber).includes('Hidden-ID');
  const normalized = {
    organization_id: tenantConfig?.organization_id || rawMessage.organization_id || null,
    source_platform: sourcePlatform,
    source_type: sourceType,
    source_channel: sourceChannel,
    source_id: sourceId,
    source_name: rawMessage.source_name || (isWhatsappGroup ? 'WhatsApp Group' : 'Direct Message'),
    source_group_name: rawMessage.source_group_name || (isWhatsappGroup ? rawMessage.source_name || null : null),
    message_id: rawMessage.message_id || rawMessage.external_message_id || null,
    external_message_id: rawMessage.external_message_id || rawMessage.message_id || null,
    sender_external_id: rawMessage.sender_external_id || rawMessage.sender_jid || senderNumber,
    sender_number: senderNumber,
    sender_name: rawMessage.sender_name || 'Unknown',
    raw_message: String(rawMessage.raw_message || rawMessage.text || '').trim(),
    received_at: rawMessage.received_at || new Date().toISOString(),
    contactability_status: rawMessage.contactability_status || (
      isHiddenSender ? 'manual_group_reply_required' : 'direct_contact_available'
    ),
    metadata: {
      ...(rawMessage.metadata || {}),
      is_hidden_sender: isHiddenSender,
      is_group: isWhatsappGroup
    }
  };

  normalized.external_message_id = normalized.external_message_id || buildFallbackMessageId(normalized);
  normalized.message_id = normalized.message_id || normalized.external_message_id;
  normalized.raw_message_hash = hashMessageText(normalized.raw_message);
  return normalized;
};
