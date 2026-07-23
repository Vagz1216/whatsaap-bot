import { query } from './pg.js';

let ensured = false;

const parseJson = (value, fallback = {}) => {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export async function ensureChannelRuntimeTable() {
  if (ensured || !process.env.DATABASE_URL) return;
  await query(`
    CREATE TABLE IF NOT EXISTS channel_runtime_status (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_type TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      worker_id TEXT,
      metadata TEXT,
      last_error TEXT,
      last_seen_at TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, channel_type, channel_key)
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_channel_runtime_org ON channel_runtime_status(organization_id, channel_type, updated_at)');
  ensured = true;
}

export async function upsertChannelRuntime({
  organizationId,
  channelType,
  channelKey,
  status,
  workerId = null,
  metadata = {},
  lastError = null
}) {
  if (!process.env.DATABASE_URL || !organizationId || !channelType || !channelKey) return;
  await ensureChannelRuntimeTable();
  await query(
    `INSERT INTO channel_runtime_status
       (organization_id, channel_type, channel_key, status, worker_id, metadata, last_error, last_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
     ON CONFLICT (organization_id, channel_type, channel_key)
     DO UPDATE SET status = EXCLUDED.status,
                   worker_id = EXCLUDED.worker_id,
                   metadata = EXCLUDED.metadata,
                   last_error = EXCLUDED.last_error,
                   last_seen_at = EXCLUDED.last_seen_at,
                   updated_at = NOW()`,
    [
      Number(organizationId),
      channelType,
      channelKey,
      status || 'unknown',
      workerId,
      JSON.stringify(metadata || {}),
      lastError
    ]
  );
}

export async function listChannelRuntime(organizationId) {
  if (!process.env.DATABASE_URL || !organizationId) return [];
  await ensureChannelRuntimeTable();
  const result = await query(
    `SELECT organization_id, channel_type, channel_key, status, worker_id, metadata,
            last_error, last_seen_at, updated_at
       FROM channel_runtime_status
      WHERE organization_id = $1`,
    [Number(organizationId)]
  );
  return result.rows.map((row) => ({
    ...row,
    metadata: parseJson(row.metadata, {})
  }));
}
