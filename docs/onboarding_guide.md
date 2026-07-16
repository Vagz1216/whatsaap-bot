# Shiku Platform — Operator Onboarding Guide
*How you set up the two systems for a new client, and how they use them every day.*

---

## Overview: What You Are Onboarding Them To

The platform has two systems that work together:

| System | What It Does | Technology |
|--------|-------------|------------|
| **StayEZ WhatsApp Scout** | Silently monitors WhatsApp groups and DMs. Catches people actively posting about finding accommodation *right now*. Sends a lead card to Telegram. | Node.js / Baileys |
| **Shiku SDR** | Manages outbound campaigns, email sequences, LinkedIn outreach, and a full CRM. The human-facing dashboard for approving, managing, and nurturing leads. | Python / FastAPI + Next.js |

**The client's day-to-day experience is almost entirely in Telegram and the SDR dashboard.** They do not touch servers, terminals, or code.

---

## Part 1: What YOU (the Operator) Do to Set Up a New Client

This is the setup work you perform once, before handing anything over.

---

### Step 1 — Gather Information from the Client

Before you touch any system, collect these from the client:

**A. WhatsApp Details**
- Which WhatsApp phone number will act as the "monitor"? This is a dedicated number (not their personal business number). It must be linked to a physical SIM that can receive a QR scan.
- Which WhatsApp groups does the client want monitored? (They will need to manually add the monitor number to those groups.)

**B. Telegram Setup**
- Does the client already use Telegram? If not, they need to install it and create an account.
- They need to create a **private Telegram group** for their team (e.g., "Kilimani Leads"). You will invite the bot to this group and get the `chat_id`.

**C. Business Filtering Rules**
- What keywords should trigger a lead? (e.g., `["looking for", "need", "2 bedroom", "airbnb", "short stay"]`)
- What keywords should be ignored? (e.g., `["job", "vacancy", "driver", "delivery"]`)

**D. Inventory System (Optional)**
- Does the client have a WooCommerce site? If yes, get their `WC_BASE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`.
- If not, the system runs in **Monitor-Only mode** — it still catches and forwards leads, it just won't suggest matching inventory.

**E. SDR Access**
- Name and email of everyone who needs access to the Shiku SDR dashboard (Clerk auth handles invitations).

---

### Step 2 — Create the Telegram Bot for This Client

Each client gets their own dedicated Telegram bot. This isolates their leads from other tenants.

1. Open Telegram → Search for **@BotFather** → `/newbot`
2. Set a name like `Kilimani Leads Bot` and a username like `@kilimani_leads_bot`
3. Copy the **Bot Token** — you'll need this in Step 4.
4. Have the client add this bot to their private Telegram group.
5. To get the **Chat ID**, run:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   after someone sends a message in the group. The `chat.id` in the JSON response (usually a negative number like `-1001234567890`) is what you need.

> [!TIP]
> There is a helper script already in the codebase: `node get-chat-id.js`. Run it with the bot token set to get the chat ID automatically.

---

### Step 3 — Insert the Tenant Record into PostgreSQL

Connect to the Neon PostgreSQL database and run the following (or use your admin panel if you've built one):

```sql
-- 1. Create the organization
INSERT INTO organizations (name, slug, subscription_plan)
VALUES ('Kilimani Realty', 'kilimani-realty', 'starter')
RETURNING id;

-- 2. Create their scout configuration (use the returned org id)
INSERT INTO tenant_configs (
  organization_id,
  wa_session_id,
  telegram_bot_token_secret,
  telegram_chat_id,
  organization_name,
  wc_base_url,
  wc_consumer_key_secret,
  wc_consumer_secret_secret,
  keyword_whitelist,
  keyword_blacklist,
  llm_routing_mode,
  is_active
) VALUES (
  1,                                        -- organization_id from above
  'kilimani-realty',                        -- unique session folder name
  'bot123456:ABCdef...',                   -- Telegram bot token from Step 2
  '-1001234567890',                         -- Telegram chat ID from Step 2
  'Kilimani Realty',                        -- Display name on lead cards
  'https://client-site.co.ke',             -- WooCommerce URL (or NULL)
  'ck_xxx',                                 -- WooCommerce key (or NULL)
  'cs_xxx',                                 -- WooCommerce secret (or NULL)
  '["looking for", "need", "2 bedroom"]',  -- Keyword whitelist (JSON array)
  '["job", "vacancy", "driver"]',          -- Keyword blacklist (JSON array)
  'cost_optimized',                         -- LLM routing tier
  true
);
```

> [!NOTE]
> `wa_session_id` becomes the name of the folder where Baileys stores the WhatsApp auth session files. Use the client's slug — keep it lowercase with hyphens only.

---

### Step 4 — Scan the WhatsApp QR Code

Once the tenant record is in the database, the platform automatically spawns a new monitor worker for this tenant. Within ~30 seconds of the platform restarting (or detecting the new record), you will see a QR code appear in the server logs for this tenant.

**To scan it:**
1. Open the monitoring screen (SSH into the server or use your log viewer in Coolify/Azure).
2. Find the log line: `[Tenant: Kilimani Realty] Scan this QR code to authenticate:`
3. Give the client **a video call** or forward them a screenshot of the QR code.
4. They open WhatsApp on the monitor phone → **Linked Devices** → **Link a Device** → scan the QR.
5. You will see in the logs: `[Tenant: Kilimani Realty] WhatsApp connection opened. Monitoring messages...`

> [!IMPORTANT]
> The QR code expires in ~60 seconds. Be ready when you initiate the scan session. After a successful scan, the session is persisted to disk — the client only needs to scan once unless they log out or the session expires.

---

### Step 5 — Add the Monitor Number to the Right WhatsApp Groups

The client must do this manually on their phone:

1. Open each WhatsApp group they want monitored.
2. Add the monitor phone number as a participant.
3. The system will immediately start seeing messages from that group.

> [!WARNING]
> The monitor number should not be a number the client actively uses for conversations. It is a "silent listener." If someone in the group messages it directly, the bot does not reply — it only reads.

---

### Step 6 — Invite the Client to the Shiku SDR Dashboard

1. Go to the Shiku SDR admin panel → Organizations → Kilimani Realty.
2. Send email invitations via Clerk to each user they listed in Step 1E.
3. They will receive an email with a magic link to set up their account.
4. Set their **role**: `admin` for the account owner, `member` for agents.

---

### Step 7 — Send a Test Lead

To confirm the setup is working end-to-end:

1. From a different WhatsApp number (not the monitor), send a message to one of the monitored groups like: *"Looking for a 2 bedroom in Kilimani for this weekend, dm rates"*
2. Within 10–30 seconds, the client should see a lead card arrive in their Telegram group.
3. Confirm the card shows the correct org name, the message content, and any matched inventory (if WooCommerce was configured).

If this works — **onboarding is complete.**

---

## Part 2: How the Client Uses the Platform Day-to-Day

Once set up, the client's entire workflow lives in **two places**: Telegram (for WhatsApp leads) and the SDR dashboard (for campaigns and outbound).

---

### The WhatsApp Scout — Telegram Workflow

**What happens automatically (they don't do anything):**
- The monitor phone silently reads every message in the configured WhatsApp groups.
- Each message is classified by AI as a lead or noise.
- If it's a lead, the AI extracts intent (location, budget, dates, property type), matches it to inventory, and drafts a reply.
- A lead card arrives in the client's Telegram group within 10–30 seconds.

**What the client sees in Telegram:**

A typical lead card looks like this:
```
New Lead for Kilimani Realty!
Lead ID: #47
Name: James Kamau
Number: +254712345678
Source: group (WhatsApp Group)
Language: en

Original Message:
Looking for a 2 bedroom in Kilimani, available from Friday. 
DM rates and pictures please.
```

Followed by:
```
Extracted Data:
- location: Kilimani
- bedrooms: 2
- check_in: Friday
- intent: STAY_REQUEST
```

And then a ready-to-send draft:
```
Draft to Client
Send to: James Kamau — +254712345678

Hi James! We have a lovely 2-bedroom apartment in Kilimani 
available from Friday at KES 4,500/night. It includes...
```

**What the client does:**

| Situation | Action |
|-----------|--------|
| **Visible phone number** | Copy the drafted message → open WhatsApp → paste and send. The wa.me link (once implemented) makes this a one-tap action. |
| **Hidden number** (🔒 Hidden-ID) | Follow the instructions in the card: open the WhatsApp group → find the person's name → quote their message and reply in the group. |
| **Lead is not relevant** | Ignore the card. No action needed. |
| **Lead is high quality** | Copy name + number into the SDR dashboard and enroll in a follow-up campaign. |

> [!NOTE]
> Currently, the client manually copies leads from Telegram into the SDR. The Phase 1+2 integration work (adding `POST /api/leads/inbound` and Telegram action buttons) will make this a single button tap instead.

---

### The Shiku SDR Dashboard — Campaign Workflow

This is where the client manages their outbound pipeline.

**Daily workflow:**

1. **Log in** to the SDR dashboard at your hosted URL (e.g., `app.shiku.co.ke`).

2. **Check the Approval Queue** — any AI-drafted outreach messages waiting for human review appear here. The client reads each draft and either approves (sends it) or edits + approves.

3. **Check Replies** — the email monitor surfaces any leads who replied to outreach. The client sees the intent classification and a suggested response draft. They approve it to send.

4. **Launch a Campaign** — if the client has a new batch of targets:
   - Go to **Campaigns → New Campaign**
   - Set the target ICP (location, industry, company size, etc.)
   - The system discovers leads from Apollo/PDL
   - Set the sequence: Email Day 1 → LinkedIn Day 3 → WhatsApp follow-up Day 7
   - Activate → the system begins drafting and queuing messages for approval

5. **Monitor Progress** — the dashboard shows the status of every lead: `DISCOVERED → DRAFTED → SENT → REPLIED → MEETING_BOOKED`.

---

### The Combined Picture (How Both Systems Work Together Today)

```
WhatsApp Group Post
        │
        ▼
  [Scout catches it]
  Lead card → Telegram
        │
        ▼
  Human reads card
  ┌─────────────────────────────────┐
  │ Visible number?                 │
  │   → Copy draft → WhatsApp send  │
  │   → If no reply in 24h:         │
  │     → Manually add to SDR       │
  │     → Enroll in email sequence  │
  │                                 │
  │ Hidden number?                  │
  │   → Find in group → Reply       │
  │   → If they DM you: get number  │
  │     → Add to SDR manually       │
  └─────────────────────────────────┘
        │
        ▼
  [SDR takes over]
  Email/LinkedIn/WhatsApp sequence
        │
        ▼
  Reply detected → AI draft response
  Human approves → Send
        │
        ▼
  Meeting booked ✅
```

---

## Quick Reference: Client-Facing Cheat Sheet

> This is what you give the client after onboarding.

**Your Telegram group** is your lead inbox. Every time someone in a WhatsApp group you monitor posts about needing accommodation, you'll get a card here within 30 seconds.

**If the number is visible:**
1. Open WhatsApp
2. Copy the drafted message from the card
3. Send it to the number shown

**If the number is hidden (🔒):**
1. Open the WhatsApp group
2. Find the person by their display name
3. Quote their message and reply in the group

**For follow-ups and campaigns:**
1. Log in to your Shiku dashboard
2. Approve any pending drafts
3. Check the replies section
4. Any new WhatsApp leads you want to nurture: add them manually under Leads → New Lead

**Important:** The monitor phone should always have internet and stay charged. If it goes offline for more than a few hours, you may miss leads while it reconnects.

---

## Troubleshooting Quick Reference

| Problem | Cause | Fix |
|---------|-------|-----|
| No lead cards arriving in Telegram | Monitor phone lost WhatsApp session | Check server logs for QR code → re-scan |
| Lead cards arriving but no drafts | WooCommerce API credentials wrong or inventory empty | Check `wc_base_url` and API keys in tenant config |
| Bot token error in Telegram | Bot was removed from the group | Re-add the bot to the Telegram group |
| SDR dashboard not loading | Backend service down | Check Coolify/Azure service health panel |
| Lead card shows wrong org name | `organization_name` in `tenant_configs` is wrong | Update the DB record |
