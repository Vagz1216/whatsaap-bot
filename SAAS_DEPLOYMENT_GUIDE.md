# StayEZ Multi-Tenant SaaS Deployment Guide

This guide is for the DevOps engineer (deploying via Coolify/Azure) and the platform administrator onboarding new customers. The codebase has been updated to support a dual-mode architecture: it runs as a single-tenant SQLite worker locally by default, but switches to a highly scalable PostgreSQL multi-tenant architecture when configured for SaaS.

## 1. Environment Variables (Coolify / Azure)

When deploying this application on Coolify, you must set the following environment variables in the Coolify dashboard for the service:

### Database (Required for SaaS Mode)
*   `DATABASE_URL`: The connection string to your Neon PostgreSQL database (e.g., `postgresql://user:password@ep-cool-cloud-1234.region.aws.neon.tech/neondb?sslmode=require`).

### LLM API Keys (Global Aggregators)
*These keys are used by the fallback router to process AI requests for all tenants.*
*   `AZURE_OPENAI_API_KEY`: Your global Azure key.
*   `AZURE_OPENAI_ENDPOINT`: Your global Azure endpoint.
*   `OPENROUTER_API_KEY`: Your OpenRouter key (grants access to free DeepSeek, Qwen, and Gemma models for budget tenants).
*   `GROQ_API_KEY`: Your Groq API key (grants access to Llama 3 models for ultra-fast fallback).
*   `GEMINI_API_KEY`: Google Gemini API key.

### Observability
*   `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL`: Used to track LLM costs and usage across the platform.

*(Note: `TELEGRAM_BOT_TOKEN`, `WC_BASE_URL`, etc., should NO LONGER be set in the global `.env` for SaaS deployment. They are now stored securely per-tenant in the database).*

---

## 2. Platform Entrypoint Update

Before the deployment goes live, ensure the `index.js` (or main server file) is updated to spawn multiple WhatsApp monitors based on active tenants in the database. 

**Conceptual Entrypoint for SaaS:**
```javascript
import { getActiveTenants } from './db/tenant.js';
import { startMonitor } from './agents/monitor.js';
import { processMessage } from './pipeline/index.js';

async function startPlatform() {
  const activeTenants = await getActiveTenants(); 
  for (const tenant of activeTenants) {
    // startMonitor automatically isolates the WhatsApp auth session
    startMonitor(tenant, async (msgData, config) => {
       await processMessage(msgData, config);
    });
  }
}
startPlatform();
```

---

## 3. Customer Onboarding Checklist

When a new customer signs up to use the platform, you must insert a record into the `organizations` and `tenant_configs` tables in PostgreSQL. 

The customer must provide (or you must generate for them) the following details:

### A. Core Communication Setup
1.  **WhatsApp Number:** The number the bot will monitor. The system will generate a QR code in the server logs that the customer must scan with their WhatsApp app to link the session (`wa_session_id`).
2.  **Telegram Chat ID:** The customer must create a Telegram group and invite the bot to it, providing the `telegram_chat_id` where leads will be surfaced.
3.  **Telegram Bot Token:** You must create a new bot via BotFather on Telegram for this specific customer and store the token (`telegram_bot_token_secret`).

### B. Business Logic (Filtering)
4.  **Keyword Whitelist:** An array of words (e.g., `["rent", "house", "2br"]`). If empty, the bot listens to everything.
5.  **Keyword Blacklist:** An array of words to ignore (e.g., `["job", "vacancy"]`).

### C. Matcher API (Optional)
6.  If the customer has a WooCommerce inventory or custom API, they provide:
    *   `wc_base_url`
    *   `wc_consumer_key_secret`
    *   *If they do not provide this, the pipeline automatically switches to "Monitor-Only" mode and simply forwards filtered leads without attempting to match inventory.*

### D. Billing / Routing Plan
7.  **Routing Mode:** You set their `llm_routing_mode` in the database:
    *   `cost_optimized`: Uses free DeepSeek/Gemma models on OpenRouter (Costs you $0.00).
    *   `balanced`: Uses Gemini Flash and Llama 70B.
    *   `quality_first`: Uses Azure GPT-5.5.
