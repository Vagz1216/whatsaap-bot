# Unified Platform Proposal: Shiku Intelligence Platform

## The Two Systems Today

### System A — StayEZ WhatsApp Bot (Node.js)
**What it does:** Passively monitors WhatsApp groups and DMs. It *listens* to the world, identifies people who are actively looking for something right now, matches them to inventory in real-time, and surfaces a drafted reply to a human operator via Telegram.

**Core Strength:** **Inbound Lead Interception** — catching high-intent buyers in the wild before they contact a competitor.

**Key Components:**
- `monitor.js` — Baileys WebSocket listening on WhatsApp groups/DMs
- `classifier.js` — LLM intent filter (STAY_REQUEST vs NOISE)
- `matcher.js` — WooCommerce API inventory matching
- `drafter.js` — Contextual reply generation
- `telegram/index.js` — Human-in-the-Loop approval gateway

**Current limitations:**
- No outbound capability (it only reacts, never initiates)
- No CRM — leads are saved to SQLite and forgotten after the session
- No follow-up sequence — if the lead goes cold, nothing happens next

---

### System B — Shiku SDR (Python / FastAPI)
**What it does:** Proactively hunts for leads using Apollo/PDL, then runs multi-step outbound campaigns across Email, LinkedIn, and WhatsApp. It manages the full lifecycle of an outbound sales motion: draft → human approve → send → reply monitoring → meeting booking.

**Core Strength:** **Outbound Lead Nurturing** — systematic, personalized follow-up sequences that move cold contacts to booked meetings.

**Key Components:**
- `lead_scout/` — Apollo/PDL/Tavily ICP-driven lead discovery
- `marketing_agent.py` — Campaign Orchestrator (multi-step sequences)
- `workers.py` — Drafter Agent (3 variants) + Reviewer Agent (selects best)
- `email_monitor/` — Inbound reply handler (Intent → Response → Evaluator → Send)
- `tenant_service.py` — Full multi-tenant org/subscription/metering system
- `frontend/` — Next.js dashboard with Clerk auth and draft approval UI

**Current limitations:**
- No social listening — cannot monitor WhatsApp groups, Instagram, or TikTok
- Cannot intercept organic inbound leads from non-email channels
- The WhatsApp "outreach" tool only generates a `wa.me` deep link — it cannot read or listen to WhatsApp

---

## The Merger: What Happens When They Combine

These two systems are not competing. They are **two halves of a complete sales flywheel**. System A catches the fish. System B reels them in. Combined, you have a platform that no competitor currently offers in the African market.

```
                    ┌─────────────────────────────────────┐
                    │     SHIKU INTELLIGENCE PLATFORM      │
                    └──────────────────┬──────────────────┘
                                       │
          ┌────────────────────────────┴────────────────────────────┐
          │                                                          │
   ┌──────▼──────────┐                                    ┌─────────▼──────────┐
   │  INBOUND SCOUTS  │                                    │  OUTBOUND CAMPAIGNS │
   │  (was: StayEZ)   │                                    │  (was: Shiku SDR)   │
   └──────┬──────────┘                                    └─────────┬──────────┘
          │                                                          │
   WhatsApp Groups                                         Email Sequences
   Instagram Comments                                      LinkedIn Notes
   Facebook Groups                                         WhatsApp Follow-ups
   TikTok Comments                                         Apollo/PDL Discovery
          │                                                          │
          └──────────────────┬───────────────────────────────────────┘
                             │
                      ┌──────▼──────────┐
                      │   UNIFIED CRM    │
                      │  (PostgreSQL)    │
                      │                 │
                      │ leads           │
                      │ organizations   │
                      │ campaigns       │
                      │ messages        │
                      │ contacts        │
                      └──────┬──────────┘
                             │
                      ┌──────▼──────────┐
                      │  TELEGRAM HITL   │
                      │  COMMAND CENTER  │
                      │                 │
                      │ ✅ Approve       │
                      │ ❌ Reject        │
                      │ 🔁 Enroll Lead  │
                      │ 📋 View Profile │
                      └─────────────────┘
```

---

## The Critical New Flow: The "Scout-to-Sequence" Pipeline

This is the most powerful innovation that emerges from the merger. Currently, when the WhatsApp bot catches a lead, the conversation ends at Telegram — the operator replies manually, and if the lead goes cold, nothing happens.

In the unified platform, a **single button tap in Telegram** enrolls that inbound lead into a full SDR outbound sequence.

**Example Full Journey:**
1. A person posts in a WhatsApp group: *"Looking for a 2-bed in Kilimani, available this weekend"*
2. The Inbound Scout catches it, matches it to 2 properties, and pings Telegram with a drafted reply.
3. The operator taps **"✅ Send Reply"** → reply goes back to the WhatsApp group.
4. The operator also taps **"🔁 Enroll in Follow-Up Campaign"**.
5. The lead (name + number) is saved to the unified PostgreSQL CRM with status `WARM`.
6. The SDR Outreach Orchestrator picks up this lead 24 hours later if they did not respond, and sends a follow-up via WhatsApp or email.
7. If they reply to the email follow-up, the Inbound Email Monitor handles it, extracts meeting intent, and books the call.

> **The lead goes from a WhatsApp group post to a booked meeting — fully automated, with the human only tapping two buttons.**

---

## Integration Plan: 4 Phases

### Phase 1 — Shared Database (1–2 weeks)
**Goal:** Both systems write to the same PostgreSQL instance.

The SDR already has the production-ready schema. The WhatsApp bot needs to write intercepted leads into the SDR's `leads` table instead of local SQLite.

**Changes needed:**
- Add `source_type` column to SDR `leads` table: `email | whatsapp_group | instagram_comment | facebook_dm`
- Add `source_channel` and `source_group_name` to capture origin
- Expose a new SDR API endpoint: `POST /api/leads/inbound` that accepts a structured lead payload from any scout
- Update `stayez-chatbot/src/pipeline/index.js` to POST intercepted leads to this endpoint instead of SQLite

### Phase 2 — Telegram as Unified Command Center (1 week)
**Goal:** One Telegram bot controls both the scout and the SDR.

Add inline keyboard buttons to every Telegram card:

| Button | Action |
|--------|--------|
| ✅ Send Reply | Sends the drafted reply back via Baileys to WhatsApp |
| 🔁 Enroll in Campaign | Calls `POST /api/leads/inbound` → creates CRM lead → starts sequence |
| 👤 View Profile | Returns any previous interactions this number has had |
| ❌ Ignore | Marks as NOISE, suppresses future alerts from this number |

### Phase 3 — Multi-Channel Scout Integration (2–4 weeks)
**Goal:** Add Instagram and Facebook as inbound sources alongside WhatsApp.

New monitor modules:
- `src/agents/instagram-monitor.js` — Meta Graph API webhook for comments + DMs
- `src/agents/facebook-monitor.js` — Meta Graph API webhook for Page messages + Group posts

Both feed into the same `processMessage()` pipeline with `source_type` set appropriately. **Zero AI changes needed** — the LLM classifier and drafter work identically.

### Phase 4 — Unified Dashboard (2–3 weeks)
**Goal:** Extend the existing SDR Next.js frontend to surface scout activity.

New pages/components:
- **Inbound Feed** tab: Real-time stream of intercepted WhatsApp/IG/FB leads (SSE, just like the campaign progress stream)
- **Lead Timeline**: Full journey from first WhatsApp message → reply → enrollment → email → meeting booked
- **Scout Configuration UI**: Replace `.env` keyword lists with per-tenant configuration stored in `tenant_configs` table, editable via UI

---

## Merged Codebase Structure

```
shiku-platform/
├── backend/                          (Python / FastAPI — was: Shiku SDR)
│   ├── main.py
│   ├── outreach/
│   ├── email_monitor/
│   ├── services/
│   └── api/
│       └── inbound_leads.py          ← NEW: accepts leads from any scout
│
├── scouts/                           (Node.js — was: StayEZ WhatsApp Bot)
│   ├── src/
│   │   ├── agents/
│   │   │   ├── monitor.js            (WhatsApp via Baileys — unchanged)
│   │   │   ├── instagram-monitor.js  ← NEW
│   │   │   └── facebook-monitor.js   ← NEW
│   │   ├── pipeline/
│   │   │   └── index.js              (classify → match → draft → Telegram)
│   │   └── crm/
│   │       └── client.js             ← NEW: HTTP client to POST to backend
│   └── package.json
│
├── frontend/                         (Next.js — from Shiku SDR, unchanged)
│   └── src/
│       ├── pages/
│       │   ├── leads.tsx             (existing)
│       │   ├── inbound-feed.tsx      ← NEW
│       │   └── campaigns.tsx         (existing)
│       └── components/
│           └── LeadTimeline.tsx      ← NEW
│
└── docker-compose.yml                (backend + scouts + frontend + PostgreSQL)
```

---

## The Business Case

| Metric | StayEZ Bot Only | Shiku SDR Only | Unified Platform |
|--------|----------------|----------------|-----------------|
| Lead Sources | WhatsApp Groups only | Apollo/PDL (email/LinkedIn) | WhatsApp + IG + FB + Apollo/PDL |
| How Leads Are Found | Passive listening | Active database scouting | Both simultaneously |
| Response to Lead | Manual Ctrl+F in WhatsApp | Email sequence only | One-tap Telegram button |
| Follow-up on Cold Leads | ❌ Nothing happens | ✅ Automated email/LinkedIn | ✅ Email + LinkedIn + WhatsApp |
| Lead Memory / CRM | SQLite (session only) | PostgreSQL (persistent) | Unified PostgreSQL |
| Human Effort per Lead | High | Medium | Minimal |
| Time from Lead to Meeting | Days (manual) | Days (email lag) | Hours (real-time + automated) |

> [!IMPORTANT]
> **The most critical insight:** StayEZ catches leads that the SDR would **never find** — people posting in private WhatsApp groups don't appear on Apollo.io. And the SDR converts leads that StayEZ would **lose** — people who don't reply to the first WhatsApp message get a systematic follow-up via email. Together, they cover the entire funnel end-to-end.

---

## Recommended Immediate Next Steps

The fastest path to a working unified platform is **Phase 1 + Phase 2** (estimated 3 weeks total, no frontend work needed):

1. Add `POST /api/leads/inbound` to the SDR backend
2. Update the WhatsApp bot's `pipeline/index.js` to call this endpoint after classifying a lead
3. Add the 4 inline keyboard buttons to `telegram/index.js`

This delivers the core **Scout-to-Sequence flywheel** immediately, using infrastructure that already exists in both codebases. Phases 3 and 4 can be layered on once this is validated in production.
