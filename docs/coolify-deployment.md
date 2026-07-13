# Coolify Deployment

This project is ready to deploy through Coolify using the Docker Compose build pack.

## Azure Resources If Coolify Runs On Azure

Use this path if the deployer will run Coolify on an Azure VM instead of Azure Container Apps.

- Azure VM with Docker support. Start with 2 vCPU and 4 GiB RAM so Coolify and builds have enough headroom.
- Managed disk for the VM. Use at least 30-64 GiB depending on image retention and logs.
- Network Security Group rules for Coolify UI and HTTPS ingress. Only expose the ports Coolify requires.
- DNS record pointing to the Coolify server if the Coolify UI or other apps need a domain.
- Regular VM disk snapshots or backups for Coolify state and Docker volumes.

This bot itself does not need a public web port because it is a background worker. It connects outbound to WhatsApp, WooCommerce, Telegram, and LLM providers.

## Coolify Setup

1. In Coolify, create a new application from the GitHub repository:
   `https://github.com/Vagz1216/stayez_bot`
2. Select branch `main`.
3. Select the Docker Compose build pack.
4. Set Base Directory to `/`.
5. Set Docker Compose file to `docker-compose.yml`.
6. Do not assign a public domain to `stayez-bot`; it is a private background worker.
7. Add the environment variables from `.env.example` in Coolify.
8. Deploy the application.
9. Open the container logs and scan the WhatsApp QR code on first deployment.

## Required Environment Variables

Set these in Coolify as secrets or environment variables:

- `WC_BASE_URL`
- `WC_CONSUMER_KEY`
- `WC_CONSUMER_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- At least one LLM provider:
  - `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT_NAME`
  - `GROQ_API_KEY`
  - `GEMINI_API_KEY`
  - `OPENROUTER_API_KEY`

Optional:

- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_BASEURL`
- `TZ`
- `LOG_LEVEL`

## Persistent Storage

The Compose file defines a named volume:

```yaml
volumes:
  - stayez_data:/app/data
```

This must stay persistent between deployments. It stores:

- WhatsApp auth session files under `/app/data/wa-auth`
- SQLite database files under `/app/data`

If this volume is deleted, the bot will need WhatsApp QR authentication again and any local host records in SQLite will be lost.

## First Deploy Checklist

- Confirm all required environment variables are set.
- Run `npm run healthcheck` locally or in the deployed container after setting secrets.
- Deploy from `main`.
- Watch logs until the WhatsApp QR code appears.
- Scan the QR code with the broker WhatsApp account.
- Confirm logs show `WhatsApp connection opened. Monitoring messages...`.
- Send a test WhatsApp message that looks like a stay request.
- Confirm the Telegram bot sends lead cards.

## Operations

- Keep replicas at `1`. Multiple replicas can corrupt the current single SQLite database and conflict with one WhatsApp session.
- Use Coolify logs for runtime troubleshooting.
- Run the container healthcheck or `npm run healthcheck` after environment changes.
- Back up the persistent volume before redeploying infrastructure.

## Production Controls Already Included

- Startup fails when required credentials are missing or still set to placeholder values.
- The app only uses Azure OpenAI when the API key, endpoint, and deployment name are all present.
- Suspicious prompt-injection messages are blocked before reaching the LLM.
- Drafts are blocked if they contain secret-like values or internal prompt/policy wording.
- Each pipeline message gets a request ID in logs.
- WhatsApp remains read-only; Telegram receives drafts for human approval.

## Not Yet Production-Hardened

- There is no public HTTP `/health` endpoint because this is currently a worker.
- SQLite is suitable for one worker, not horizontal scaling.
- More prompt-injection and output guardrail test cases should be added before high-volume production use.
- Database migrations are not versioned yet.
