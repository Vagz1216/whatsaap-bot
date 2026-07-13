# StayEZ WhatsApp Lead Monitor & Chatbot

A Node.js worker for a Kenyan short-stay property broker.

The system monitors WhatsApp groups and DMs, detects accommodation requests, searches the StayEZ inventory, drafts personalized responses, and notifies the broker via Telegram. It keeps the broker in the approval loop by sending drafts instead of auto-replying.

## Architecture

| Component | Role |
| --- | --- |
| `src/agents/monitor.js` | Maintains the WhatsApp connection and emits candidate messages. |
| `src/pipeline/index.js` | Filters, classifies, matches, drafts, stores, and sends Telegram cards. |
| `src/llm/` | Routes LLM calls across Azure OpenAI, Groq, Gemini, and OpenRouter fallbacks. |
| `src/stayez/api.js` | Queries StayEZ/WooCommerce inventory APIs. |
| `src/db/index.js` | Stores transient leads and local host records in SQLite. |
| `src/telegram/index.js` | Sends human-review cards to the broker. |

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in your credentials.
   ```bash
   cp .env.example .env
   ```

3. **Run the healthcheck:**
   ```bash
   npm test
   npm run healthcheck
   ```

4. **Start the worker:**
   ```bash
   npm start
   ```
   *Scan the QR code printed in the terminal to link your WhatsApp account.*

## Docker

```bash
docker compose up --build
```

The container stores SQLite and WhatsApp auth state under `DATA_DIR`, which defaults to `/app/data` in Docker and is mounted as a named volume by `docker-compose.yml`.

## Features
- **Read-Only WhatsApp Monitor:** Silently monitors messages without auto-replying.
- **LLM Fallback Chain:** Uses a 5-level fallback chain (Azure OpenAI, Groq, Gemini, OpenRouter, Ollama) for high availability.
- **Property Matching:** Queries the live `stayez.co.ke` WooCommerce inventory via REST APIs.
- **Telegram Notifications:** Sends drafted messages securely to the broker via Telegram cards.

## Scripts
- **Add Local Host:** Manually add a local host to the SQLite database.
  ```bash
  node scripts/add-host.js
  ```

## Deployment

See [docs/coolify-deployment.md](docs/coolify-deployment.md) for the recommended Coolify deployment path.
See [docs/azure-hosting.md](docs/azure-hosting.md) for an Azure Container Apps alternative.

## Known Limitations

- This is a single-worker service because SQLite and the WhatsApp session are local state.
- The current healthcheck is a command, not an HTTP endpoint.
- Prompt-injection, guardrail, and evaluation tests should be added before production use.
