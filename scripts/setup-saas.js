import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupSaaS() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is not set in your .env file!");
    console.log("Please add your Neon PostgreSQL URL to the .env file first.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log("🔌 Connecting to PostgreSQL...");
    const client = await pool.connect();

    console.log("🏗️ Creating tables from schema_pg.sql...");
    const schemaPath = path.join(__dirname, '../src/db/schema_pg.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log("✅ Tables created successfully!");

    console.log("👤 Setting up your first Tenant (StayEZ / Markethacks)...");
    
    // Insert Tenant Config
    await client.query(`
      INSERT INTO tenant_configs (
        organization_id, wa_session_id, telegram_bot_token_secret, telegram_chat_id, 
        meta_access_token_secret, classifier_system_prompt, keyword_whitelist, keyword_blacklist, drafter_persona
      ) VALUES (
        1, 
        'markethacks_main', 
        $1, 
        $2, 
        $3, 
        'You are a helpful real estate assistant.',
        '',
        '',
        'friendly and professional'
      ) ON CONFLICT (organization_id) DO UPDATE SET 
        telegram_bot_token_secret = EXCLUDED.telegram_bot_token_secret,
        telegram_chat_id = EXCLUDED.telegram_chat_id,
        meta_access_token_secret = EXCLUDED.meta_access_token_secret;
    `, [
      process.env.TELEGRAM_BOT_TOKEN || 'placeholder_token',
      process.env.TELEGRAM_CHAT_ID || 'placeholder_id',
      process.env.META_ACCESS_TOKEN || ''
    ]);

    console.log("✅ First tenant created!");
    console.log("🎉 Your SaaS Database is fully set up and ready.");
    client.release();
  } catch (err) {
    console.error("❌ Setup failed:", err.message);
  } finally {
    pool.end();
  }
}

setupSaaS();
