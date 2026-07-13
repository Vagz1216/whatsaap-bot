# Design Decisions

### ADR-001 - Background Worker Architecture

**Context:** The bot monitors WhatsApp messages and sends Telegram draft cards. It does not currently expose an HTTP API.
**Decision:** Keep the service as a long-running Node.js worker.
**Rationale:** Baileys requires an active WhatsApp socket session, and the current user workflow is event-driven.
**Trade-offs:** Azure App Service or Container Apps must run the container continuously. A future HTTP health endpoint would improve platform integration.

### ADR-002 - LLM Provider Fallbacks

**Context:** The classifier and drafter depend on third-party LLM availability.
**Decision:** Use the existing provider chain: Azure OpenAI, Groq, Gemini, OpenRouter.
**Rationale:** Fallbacks reduce downtime from quota, rate limit, or provider failures.
**Trade-offs:** Output consistency can vary by provider and model, so evaluation coverage should be expanded before production use.

### ADR-003 - Local Persistence

**Context:** The worker stores transient leads and manually added local hosts.
**Decision:** Continue using SQLite through `better-sqlite3`, with the database stored under `DATA_DIR`.
**Rationale:** SQLite is operationally simple for a single-worker bot and works well with container volume mounts.
**Trade-offs:** It is not suitable for multiple active replicas. Azure production scaling should move persistent records to Azure Database for PostgreSQL or Azure SQL.

### ADR-004 - Human-in-the-loop Messaging

**Context:** The bot can draft client and host messages based on WhatsApp leads.
**Decision:** Send drafts to Telegram instead of auto-replying on WhatsApp.
**Rationale:** Human approval limits the risk of incorrect or externally visible AI messages.
**Trade-offs:** This keeps the broker in the loop and reduces automation speed.

### ADR-005 - Container Deployment

**Context:** The project needs a repeatable path to hosting.
**Decision:** Add Docker and Docker Compose support, with runtime state stored in a named volume.
**Rationale:** Containers are portable to Azure Container Apps, Azure App Service for Containers, or Azure VM hosting.
**Trade-offs:** WhatsApp QR authentication is awkward on managed platforms unless logs are accessible and the auth volume is persistent.

## Prompt Engineering Log

Current prompts are embedded in the classifier and drafter modules. Before production hardening, move prompt contracts into versioned prompt files and add labelled evaluation cases for lead classification and message drafting.
