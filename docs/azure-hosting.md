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

- `DATABASE_URL` with the Neon PostgreSQL connection string.
- `DASHBOARD_REQUIRE_AUTH=true`
- `CLERK_JWKS_URL` from the Clerk instance that issues dashboard session tokens.
- `CLERK_JWT_ISSUER` from the same Clerk instance.
- `CLERK_SECRET_KEY` for user enrichment when JWT claims do not include email.
- `CLERK_PUBLISHABLE_KEY` so the static dashboard can render Clerk sign-in.
- `PLATFORM_OWNER_EMAILS` as a comma-separated list of platform admin emails.
- `SECRET_ENCRYPTION_KEY` as a stable long random value. Do not rotate it casually; encrypted BYOK keys depend on it.
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and an Azure deployment name using either `AZURE_OPENAI_DEPLOYMENT` or `AZURE_OPENAI_DEPLOYMENT_NAME`
- Optional Azure setting: `AZURE_OPENAI_API_VERSION` if the deployment requires a non-default API version.
- Optional fallback keys: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- Optional OpenAI-compatible fallback: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- Optional BYOK switch: `ORGANIZATION_LLM_KEYS_ENABLED=true`
- Optional tracing: `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASEURL`
- `DATA_DIR=/app/data`
- `TZ=Africa/Nairobi`
- `LOG_LEVEL=info`

Do not set global `WC_BASE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `TELEGRAM_BOT_TOKEN`, or `TELEGRAM_CHAT_ID` for SaaS unless you intentionally want local-mode fallback behavior. In SaaS mode those values are stored per tenant in Neon through `tenant_configs`.

`AZURE_OPENAI_DEPLOYMENT=gpt-5.5` is valid if that is what your current Azure env already uses. `AZURE_OPENAI_DEPLOYMENT_NAME` is only a clearer optional alias accepted by the app.

`DASHBOARD_TOKEN` is not required when Clerk is configured. It is only for local/internal fallback deployments where `CLERK_JWKS_URL` is empty. The static dashboard uses `CLERK_PUBLISHABLE_KEY` to render Clerk sign-in and send a Clerk session JWT to the API as `Authorization: Bearer <token>`.

## Production Upgrade Path

For production, store all secrets in Azure Key Vault or Container Apps secrets, keep a persistent `/app/data` volume for WhatsApp auth state, and keep one active replica unless WhatsApp session ownership is redesigned for multiple concurrent workers.
