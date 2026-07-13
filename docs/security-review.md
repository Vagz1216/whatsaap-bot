# Security Review

## Current Controls

- Real secrets are excluded through `.gitignore`; `.env.example` contains placeholders only.
- WhatsApp auth state, SQLite files, and local runtime data are excluded from Git.
- The bot is read-only on WhatsApp and sends Telegram drafts for human approval.
- The LLM router uses a provider fallback chain and rate-limit cooldown tracking.
- Startup validation fails closed when required environment variables are missing or still set to placeholders.
- Inbound prompt-injection patterns are blocked before LLM calls.
- Outbound drafts are checked for secret-like values and internal prompt/policy leakage before Telegram cards are sent.
- Pipeline logs include per-message request IDs for traceability.

## Required Before Production

- Extend request IDs into all provider and Telegram logs.
- Move SQLite schema changes into versioned migrations.
- Configure Azure Key Vault or Azure Container Apps secrets for all credentials.
- Set billing alerts and quota limits for all LLM providers.
- Re-authenticate WhatsApp using a persistent Azure volume, not committed auth files.

## Accepted Risk For This Push

This repository push prepares the code for source control and deployment planning. It does not make the worker production-hardened by itself.
