# Evaluation Criteria

Per SKILL.md section 10, this document defines what a "good" output looks like for each major AI agent in the pipeline. Use these criteria when modifying system prompts, adding new LLM providers, or running evaluation test sets.

---

## 1. Classifier Agent
**Goal:** Determine if an inbound message is a genuine request for accommodation (`STAY_REQUEST`) or noise (`NOISE`), and extract key details.

**A GOOD Classification:**
- **Strict Intent:** Classifies as `STAY_REQUEST` *only* if the user is explicitly asking to book or find a place. Asking "How much is this?" on a listed property is a lead. Asking "Do you sell shoes?" is noise.
- **Robust Extraction:** Extracts locations, dates, and guest counts accurately even from slang or mixed language (e.g., Sheng: "natafuta keja westy" -> Location: Westlands).
- **Graceful Defaults:** Does not hallucinate check-in dates if none are provided.
- **Missing Details:** Accurately flags missing `location` or `check_in`. It should *never* flag missing `budget` as a critical missing detail.

---

## 2. Drafter Agent
**Goal:** Generate a polite, context-aware reply to the user, either proposing a property, asking for more details, or confirming availability checks.

**A GOOD Draft to Client:**
- **Length:** Under 60 words. Short and punchy for WhatsApp/Instagram.
- **Tone:** Professional but warm, matching the language of the inbound request (Swahili/Sheng/English).
- **Safety:** Does not hallucinate properties that were not in the `matcher` payload. Does not commit to a booking (only proposes).
- **Context:** If missing details, asks only for the specific missing detail (e.g., "Which dates were you looking to check in?").
- **Clarity:** Includes the property name and link if a direct match was found.

**A GOOD Draft to Host (Source/Contact):**
- **Length:** Under 40 words.
- **Content:** Clearly states "We have a client looking for..." and includes the exact requirements.
- **Goal:** Asks for confirmation of availability and rates.

---

## How to use this
If you change the `src/agents/drafter.js` or `src/agents/classifier.js` prompts, you should visually (or programmatically) check the output of a few test leads against these criteria to ensure no regressions occurred.
