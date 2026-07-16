# Social Listener Adapters

The scout now accepts inbound events from socket-based WhatsApp monitoring and HTTP webhook adapters.

## Local Runtime

Start the normal worker:

```bash
npm start
```

By default this also starts the webhook server on `WEBHOOK_PORT` or `3100`.

Health check:

```bash
curl http://localhost:3100/health
```

Local test webhook:

```bash
curl -X POST http://localhost:3100/webhooks/test \
  -H 'Content-Type: application/json' \
  -d '{"source_platform":"instagram","source_type":"comment","text":"Looking for a 2br in Kilimani this weekend","sender_name":"Test Lead"}'
```

## Live Webhook Routes

Meta verification:

```text
GET /webhooks/meta?hub.mode=subscribe&hub.verify_token=<META_WEBHOOK_VERIFY_TOKEN>&hub.challenge=<challenge>
```

Meta delivery:

```text
POST /webhooks/meta?tenant=<wa_session_id>
```

TikTok delivery:

```text
POST /webhooks/tiktok?tenant=<wa_session_id>
```

For SaaS mode, include either:

```text
?tenant=<tenant_configs.wa_session_id>
```

or:

```text
?organization_id=<organizations.id>
```

If exactly one tenant is active, the server will use that tenant as a fallback.

## Adapter Contract

All adapters emit the same shape before the pipeline runs:

```json
{
  "source_platform": "instagram",
  "source_type": "comment",
  "source_channel": "instagram_comment",
  "source_id": "post-or-conversation-id",
  "source_name": "Instagram Comment",
  "message_id": "provider-message-id",
  "sender_external_id": "provider-user-id",
  "sender_name": "Display Name",
  "raw_message": "Looking for a 2br in Kilimani",
  "received_at": "2026-07-14T12:00:00.000Z",
  "contactability_status": "platform_reply_required",
  "metadata": {}
}
```

The existing pipeline then handles dedupe, guardrails, filtering, classification, matching, drafting, persistence, and Telegram cards.

## Current Safety Boundary

The scout only listens, drafts, and notifies. Telegram buttons are placeholders until the SDR inbound-lead API contract is finalized.
