# Azure Hosting

## Recommended First Deployment

Use Azure Container Apps for the first hosted version.

Required resources:

- Azure Container Registry to store the Docker image.
- Azure Container Apps environment and one Container App for the worker.
- Azure Files or another persistent volume mounted at `/app/data` for SQLite and WhatsApp auth state.
- Azure Key Vault or Container Apps secrets for `.env` values.
- Log Analytics workspace for container logs.

Recommended sizing:

- 0.5 vCPU and 1 GiB memory to start.
- Minimum replicas: 1.
- Maximum replicas: 1 while SQLite and one WhatsApp session are used.

## Environment Variables

Set these as Azure secrets or app environment variables:

- `WC_BASE_URL`
- `WC_CONSUMER_KEY`
- `WC_CONSUMER_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT_NAME`
- Optional fallback keys: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- Optional tracing: `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASEURL`
- `DATA_DIR=/app/data`
- `TZ=Africa/Nairobi`
- `LOG_LEVEL=info`

## Production Upgrade Path

For a production version, replace SQLite with Azure Database for PostgreSQL or Azure SQL, add a real `/health` HTTP endpoint, add CI/CD through GitHub Actions, and store all secrets in Key Vault. Keep one active WhatsApp worker unless the WhatsApp integration is redesigned for multi-session operation.
