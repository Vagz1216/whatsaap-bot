import db from './index.js';
import { query } from './pg.js';

const isMissingPostgresTable = (error) => error?.code === '42P01';

export const claimInboundMessage = async (message, tenantConfig = null) => {
  const organizationId = tenantConfig?.organization_id || message.organization_id || 0;
  const params = [
    organizationId,
    message.source_platform,
    message.source_channel,
    message.external_message_id,
    message.source_id,
    message.sender_external_id,
    message.raw_message_hash
  ];

  if (tenantConfig) {
    try {
      const result = await query(
        `INSERT INTO inbound_message_events (
          organization_id, source_platform, source_channel, external_message_id,
          source_id, sender_external_id, raw_message_hash, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'received')
        ON CONFLICT (organization_id, source_platform, external_message_id) DO NOTHING
        RETURNING id`,
        params
      );
      if (result.rowCount === 0) {
        return { claimed: false, duplicate: true };
      }
      return { claimed: true, event_id: result.rows[0].id };
    } catch (error) {
      if (isMissingPostgresTable(error)) {
        return { claimed: true, dedupe_unavailable: true };
      }
      throw error;
    }
  }

  const result = db.prepare(`
    INSERT OR IGNORE INTO inbound_message_events (
      organization_id, source_platform, source_channel, external_message_id,
      source_id, sender_external_id, raw_message_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received')
  `).run(...params);

  if (result.changes === 0) {
    return { claimed: false, duplicate: true };
  }
  return { claimed: true, event_id: result.lastInsertRowid };
};

export const markInboundMessageStatus = async (
  message,
  status,
  { leadId = null, error = null, tenantConfig = null } = {}
) => {
  const organizationId = tenantConfig?.organization_id || message.organization_id || 0;

  if (tenantConfig) {
    try {
      await query(
        `UPDATE inbound_message_events
         SET status = $1, lead_id = COALESCE($2, lead_id), last_error = $3, updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $4 AND source_platform = $5 AND external_message_id = $6`,
        [status, leadId, error ? String(error).slice(0, 1000) : null, organizationId, message.source_platform, message.external_message_id]
      );
    } catch (updateError) {
      if (!isMissingPostgresTable(updateError)) throw updateError;
    }
    return;
  }

  db.prepare(`
    UPDATE inbound_message_events
    SET status = ?, lead_id = COALESCE(?, lead_id), last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE organization_id = ? AND source_platform = ? AND external_message_id = ?
  `).run(
    status,
    leadId,
    error ? String(error).slice(0, 1000) : null,
    organizationId,
    message.source_platform,
    message.external_message_id
  );
};
