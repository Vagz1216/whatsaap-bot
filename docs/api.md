# Webhook API Documentation

This document outlines the webhook endpoints exposed by the `src/adapters/webhook-server.js` service for receiving inbound messages from Meta (Instagram/Facebook/WhatsApp Cloud) and TikTok.

## Base URL
When deployed, the webhook server listens on `process.env.WEBHOOK_PORT` (default `3100`).
Example: `https://your-app.com`

---

## 1. Health Check
Used by load balancers and deployment platforms (like Azure Container Apps) to verify the service is running.

**Endpoint:** `GET /health`

**Response:** `200 OK`
```json
{
  "status": "ok",
  "component": "social-listener-webhook"
}
```

---

## 2. Meta Webhook (Instagram, Facebook Messenger, WA Cloud)

Meta requires both a `GET` endpoint for verification and a `POST` endpoint for receiving event payloads. Both share the same URL path.

**Endpoint:** `/webhooks/meta`

### Verification (`GET`)
When configuring the webhook in the Meta App Dashboard, Meta will send a verification request.

**Query Parameters:**
- `hub.mode`: `subscribe`
- `hub.challenge`: A random string
- `hub.verify_token`: Must match `META_WEBHOOK_VERIFY_TOKEN` in your `.env` or tenant config.

**Response:** `200 OK` with the raw `hub.challenge` text.

### Event Payload (`POST`)
When a user sends a message, Meta sends the payload here.

**Headers:**
- `Content-Type: application/json`

**Query Parameters (Optional):**
- `tenant`: The WhatsApp session ID or tenant ID (used to route the message in SaaS mode).

**Response:**
- `202 Accepted`: If parsed successfully and dispatched to the pipeline.
- `400 Bad Request`: If JSON is malformed or invalid structure.
- `403 Forbidden`: If verification token fails (during setup).

---

## 3. TikTok Webhook

Used to receive DM and comment events from TikTok.

**Endpoint:** `/webhooks/tiktok`

### Event Payload (`POST`)

**Response:**
- `202 Accepted`: Payload processed.

---

## 4. Test Webhook

Used for local development and smoke testing the pipeline without needing a real Meta or TikTok payload.

**Endpoint:** `POST /webhooks/test`

**Example Body:**
```json
{
  "tenant": "tenant_123",
  "messages": [
    {
      "text": "Looking for a 2 bedroom in Kilimani tomorrow",
      "sender_id": "test_user_01",
      "sender_name": "Test User"
    }
  ]
}
```

**Response:** `202 Accepted`
