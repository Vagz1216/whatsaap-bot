export const extractTestMessages = (payload = {}) => {
  const messages = Array.isArray(payload.messages) ? payload.messages : [payload];

  return messages
    .filter((message) => message && (message.raw_message || message.text))
    .map((message, index) => {
      const sourcePlatform = message.source_platform || 'test';
      const sourceType = message.source_type || 'dm';
      return {
        source_platform: sourcePlatform,
        source_type: sourceType,
        source_channel: message.source_channel || `${sourcePlatform}_${sourceType}`,
        source_id: message.source_id || 'local-test',
        source_name: message.source_name || 'Local Test',
        source_group_name: message.source_group_name || null,
        message_id: message.message_id || `test:${Date.now()}:${index}`,
        external_message_id: message.external_message_id || message.message_id || `test:${Date.now()}:${index}`,
        sender_external_id: message.sender_external_id || 'test-user',
        sender_number: message.sender_number || `${sourcePlatform}:test-user`,
        sender_name: message.sender_name || 'Test User',
        raw_message: message.raw_message || message.text,
        received_at: message.received_at || new Date().toISOString(),
        contactability_status: message.contactability_status || 'platform_reply_required',
        metadata: message.metadata || {}
      };
    });
};
