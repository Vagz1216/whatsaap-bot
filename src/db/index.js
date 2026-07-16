import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

const columnExists = (tableName, columnName) => {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
};

const addColumnIfMissing = (tableName, columnName, definition) => {
  if (!columnExists(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const initDB = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_hosts ( 
      id              INTEGER PRIMARY KEY AUTOINCREMENT, 
      name            TEXT NOT NULL, 
      whatsapp_number TEXT NOT NULL UNIQUE,  -- e.g. 254712345678 
      region          TEXT NOT NULL,         -- e.g. Nairobi, Mombasa 
      sub_area        TEXT,                  -- e.g. Westlands, Kilimani 
      unit_types      TEXT,                  -- e.g. 'studio,1BR,2BR' 
      price_min       INTEGER,               -- KES per night 
      price_max       INTEGER,               -- KES per night 
      notes           TEXT,                  -- freeform institutional knowledge 
      source          TEXT DEFAULT 'manual', -- 'manual' | 'group_capture' 
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP 
    );
    
    CREATE TABLE IF NOT EXISTS leads ( 
      id                     INTEGER PRIMARY KEY AUTOINCREMENT, 
      source_type            TEXT NOT NULL CHECK(source_type IN ('group','dm')), 
      source_id              TEXT NOT NULL, 
      source_name            TEXT, 
      source_platform        TEXT DEFAULT 'whatsapp',
      source_channel         TEXT,
      source_group_name      TEXT,
      external_message_id    TEXT,
      sender_external_id     TEXT,
      received_at            DATETIME,
      contactability_status  TEXT DEFAULT 'direct_contact_available',
      metadata               TEXT,
      sender_number          TEXT NOT NULL, 
      sender_name            TEXT, 
      raw_message            TEXT NOT NULL, 
      detected_language      TEXT,             -- 'en' | 'sw' | 'mixed' 
      location               TEXT, 
      check_in               TEXT, 
      check_out              TEXT, 
      guests                 TEXT, 
      budget                 TEXT, 
      special_notes          TEXT, 
      missing_details        TEXT,             -- JSON array of missing fields
      classifier_confidence  REAL, 
      matched_property_ids   TEXT,             -- JSON array of WC product IDs 
      status                 TEXT DEFAULT 'pending', 
      draft_to_client        TEXT,             -- JSON: { to_name, to_number, message } 
      draft_to_matched_host  TEXT,             -- JSON: { to_name, to_number, message } 
      drafts_to_nearby_hosts TEXT,             -- JSON array of { to_name, to_number, message } 
      created_at             DATETIME DEFAULT CURRENT_TIMESTAMP, 
      updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP 
    );

    CREATE TABLE IF NOT EXISTS inbound_message_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id     INTEGER DEFAULT 0,
      source_platform     TEXT NOT NULL,
      source_channel      TEXT,
      external_message_id TEXT NOT NULL,
      source_id           TEXT,
      sender_external_id  TEXT,
      raw_message_hash    TEXT,
      status              TEXT NOT NULL DEFAULT 'received',
      lead_id             INTEGER,
      last_error          TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (organization_id, source_platform, external_message_id)
    );
  `);

  const leadColumns = [
    ['source_platform', "TEXT DEFAULT 'whatsapp'"],
    ['source_channel', 'TEXT'],
    ['source_group_name', 'TEXT'],
    ['external_message_id', 'TEXT'],
    ['sender_external_id', 'TEXT'],
    ['received_at', 'DATETIME'],
    ['contactability_status', "TEXT DEFAULT 'direct_contact_available'"],
    ['metadata', 'TEXT']
  ];
  for (const [columnName, definition] of leadColumns) {
    addColumnIfMissing('leads', columnName, definition);
  }
};

initDB();

export default db;
