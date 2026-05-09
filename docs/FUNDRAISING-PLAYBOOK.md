# Mosaiq Seed Fundraising Playbook

> **Version**: v1.0 · 2026-05-07 · sync with PRD v0.2 + Pitch Deck v1
>
> **Goal**: $3–5M Seed in 90 days, lead investor preferred from dev-tools / AI-agent thesis funds.
>
> **Pre-requisite**: PRD v0.2 ✅ · Cloud Runtime Arch ✅ · Pitch Deck v1 ✅ · Founder bio ⏳ · Financial model ⏳ · 5–10 customer discovery interviews ⏳

---

## 1. Target Investor List (Tier-Ranked)

### Tier 1 — Highest fit (warm-intro priority)

| Fund | Partner / Contact | Why fit | Recent relevant check |
|---|---|---|---|
| **a16z** | Martin Casado, Sarah Wang (infra); David George (growth) | Vercel, Browserbase B participant rumor, infra/dev-tools depth | Browserbase B (rumored) |
| **Sequoia Capital US** | Sonya Huang (AI), Pat Grady | Stagehand author Anthropic relationships; AI agent thesis | Anthropic, Harvey |
| **Index Ventures** | Mike Volpi, Bryan Offutt | Browser infra (Cohere, ElevenLabs); Europe + US presence | Cohere, Figma |
| **Hummingbird Ventures** | Pieter Coucke | Specifically infra + dev tools, comfortable with controversial categories | Algolia, Eden AI |
| **Cohere Ventures** | Aidan Gomez team | Direct AI-agent ecosystem play | browser-use, agent infra |
| **OpenAI Startup Fund** | Brad Lightcap | Operator ecosystem alignment | Multiple agent infra |

### Tier 2 — Strong fit (cold + warm parallel)

| Fund | Why fit |
|---|---|
| **Kleiner Perkins** (Mamoon Hamid) | Dev-tools depth, Figma / Loom track record |
| **Founders Fund** (Trae Stephens) | Contrarian + infrastructure heavy |
| **Greylock** (Sarah Guo, conviction.fund spinoff) | AI thesis + infra fluency |
| **Conviction** (Sarah Guo) | Dedicated AI fund; agent infra is on thesis |
| **Boldstart Ventures** (Ed Sim) | Pure infra-seed specialist |
| **Costanoa Ventures** (Greg Sands) | Dev-tools focus |
| **Wing VC** (Gaurav Gupta) | Dev-tools + AI infra |
| **Battery Ventures** (Dharmesh Thakker) | Cloud infra |
| **Lux Capital** (Brandon Reeves) | Hard-tech tolerance |
| **8VC** (Jake Medwell) | Cross-border + infra |

### Tier 3 — Specialist / strategic

| Fund | Why fit |
|---|---|
| **Y Combinator** (W27 batch application) | Network + brand; YC alums route to Tier 1 funds |
| **South Park Commons** (Aditya Agarwal) | Pre-seed + dev infrastructure |
| **AIX Ventures** | AI-only fund, smaller checks |
| **Andreessen Horowitz Crypto** | If we frame "agent identity" angle |
| **Anthropic / OpenAI strategic** | Possible if strategic fit clarifies post-Operator GA |
| **Multilogin / AdsPower competitor M&A line** | NOT for seed; keep as Year 3 exit option |

### Strategic angels (target 3–5 for $25–100k each)

- Founders of dev-tools companies (Vercel, Supabase, Render, Linear, Notion, Stripe early team)
- AI-agent founders (Stagehand / Browserbase customers — they understand the pain)
- Cross-border e-commerce operators (Anker founders / SHEIN exec circle)
- Web automation OG community (Apify founders, Bright Data founders if hostile-but-respectful)

---

## 2. Cold Email Templates

### Template A — VC Partner (cold, no warm intro)

> **Subject**: Mosaiq — Browser infra for the agentic AI economy ($3M seed, two-engine play)

```
Hi [Partner First Name],

Browserbase hit $60M ARR in 18 months on raw Chromium + a stealth plugin.
Their kernel is the bottleneck — IPHey passes only 75%, CreepJS still trips.

Mosaiq is a true Chromium fork (15 patches at BoringSSL / V8 / Blink layers)
shipping as both a desktop antidetect browser (vs Multilogin) and a Cloud
headless API (vs Browserbase, with 100% Stagehand SDK compatibility — one-line
migration). Same C++ kernel, ~30% engineering marginal cost for the second engine.

Why I'm reaching out to [Fund]:
- [Specific portfolio company A — e.g. Vercel] is a textbook example of the
  dev-tools-with-cash-flow + cloud-with-venture-scale pattern we're building
- [Partner name] has written about [specific thesis — find via Twitter/blog]

Year 1 Desktop ARR target: $1–3M. Year 2 Cloud target: $15–40M.
Year 3 combined: $48–115M (8–12x ARR multiple → $500M–$1.5B outcome).

Raising $3–5M Seed. 22-page deck attached. Live detection lab numbers in the
appendix (we beat Browserbase 100% vs 75% on IPHey).

Could I get 25 minutes next week?

[Your name]
[founder linkedin] · founders@mosaiq.io
```

**Rules of thumb**:
- One paragraph problem, one paragraph solution, one paragraph fund-fit, one paragraph ask. ≤ 200 words.
- Always reference one specific portfolio company by name.
- Always reference one specific partner-authored content (their podcast, blog, tweet).
- Attach deck as PDF, name it `mosaiq-seed-deck-v1.pdf` (≤ 8 MB).
- Send Tuesday 9–11am or Thursday 9–11am partner local time.

### Template B — Warm intro request (to mutual contact)

> **Subject**: Quick intro ask — would you connect me to [Partner Name] at [Fund]?

```
Hey [Mutual Contact First Name],

I'm raising a $3M seed for Mosaiq — we're building a Chromium fork that
serves both as a desktop antidetect browser (our Year 1 cash-flow engine)
and a cloud headless browser API (our Year 2 venture-scale engine).
Direct Browserbase competitor with a deeper kernel.

Saw on LinkedIn you know [Partner Name]. Their work on [specific deal /
podcast / tweet] makes them a natural fit for our two-engine story.

Would you be willing to make an intro? I've drafted a forwardable
paragraph below to make it zero-effort:

----- forwardable -----
[Partner first name],

This is [your name], founder of Mosaiq. We're building the Chromium fork
that powers both a desktop antidetect browser and a cloud agent-browser API
— same kernel, two revenue engines. Year 1 Desktop $1–3M ARR target,
Year 2 Cloud $15–40M, Year 3 combined ARR $48–115M.

Browserbase is doing this with raw Chromium and shipped a $60M ARR business
in 18 months. We're doing it with a true fork (15 patches at BoringSSL /
V8 / Blink) — IPHey 100% pass rate vs their 75%.

Raising $3M seed. Could I send you the deck?
----- end forwardable -----

Thanks either way!
[Your name]
```

### Template C — AI agent founder / dev-tools founder (angel target)

> **Subject**: 60-second thing for you — Browserbase but with a real anti-detection kernel

```
Hi [First Name],

I know you've been [building agent X / using browser-use / shipping with
Stagehand] — quick 60-second thing.

We're shipping a Chromium fork (15 BoringSSL/V8/Blink patches) that's
100% Stagehand SDK compatible — your code keeps `BROWSERBASE_API_KEY`,
just changes one line:
    apiUrl: "https://api.mosaiq.dev/v1"

Why bother:
- IPHey 100% vs Browserbase ~75%
- $0.06/min vs Browserbase $0.10/min
- Same SDK, no rewrite

Two questions:
1. Would you be a M5 Cloud Alpha tester? (Free 6 months)
2. Open to angel investing $25–100k in our $3M seed?

Either way, would love your feedback on the deck (link).

[Your name]
```

---

## 3. Outreach Sequence

### Week 1 (you are here)

- [ ] Customize Pitch Deck slide A4 (Founder bio) and A5 (data room URLs)
- [ ] Build financial model spreadsheet (24-mo bottoms-up MRR build)
- [ ] Conduct 5 customer discovery calls — 2 cross-border ops, 2 AI-agent founders, 1 Browserbase ex-customer
- [ ] Render Pitch Deck to PDF + PPTX + Gamma.app web link
- [ ] Set up `founders@mosaiq.io` + Calendly + Notion data room
- [ ] LinkedIn audit: founder profile must be 100% complete with Mosaiq title

### Week 2

- [ ] Identify 3–5 mutual contacts → request warm intros (Template B)
- [ ] Send Tier 1 cold emails to 6 partners (Template A) — Tuesday batch
- [ ] Send Template C to 10 angel candidates
- [ ] Apply YC W27

### Weeks 3–6

- [ ] First-round meetings (target 8–12 meetings from 16 outreaches)
- [ ] Iterate deck based on feedback (track every objection in a sheet)
- [ ] Tier 2 outreach starts

### Weeks 7–10

- [ ] Partner meetings + DD requests
- [ ] Term sheets target by W10
- [ ] Negotiate 2–3 term sheets in parallel

### Weeks 11–13

- [ ] Lead picked, syndicate filled
- [ ] Wire transfer initiated → Phase 0 unlocked

---

## 4. Common Objections & Responses

| Objection | One-line response |
|---|---|
| "Antidetect = grey area" | We position as **browser infrastructure**. Same legal posture as VPN providers. Customers self-certify ToS compliance. SOC 2 from Year 2. |
| "Why not just better stealth plugin on Browserbase?" | Plugin layer can patch ~30% of detection signals. Real fork patches 100%. Browserbase will need 12+ months to fork. |
| "Browserbase will copy" | They'd need a kernel team they don't have. Their funding signals broader cloud, not deeper kernel. We have an 18-month window. |
| "Two products is dilution" | Marginal eng cost of engine #2 is ~30%, not 100%. Same kernel. Same Persona Engine. Same revenue team. Compounding flywheel. |
| "Desktop is a $200M outcome at best" | Floor is $200M. Cloud is the $1B+ optionality. Both being on same kernel is what makes this $500M+ baseline. |
| "Can you really hire a Chromium engineer?" | Pre-mapped network: Brave / Edge / Vivaldi alums + Chromium upstream committers + ungoogled-chromium / Bromite maintainers. ≤ 200 people globally; we know where to look. |
| "What about Google retaliating?" | Anti-trust climate makes platform-level retaliation unlikely. Even so, fork allows revert. |
| "Pricing race to bottom" | BYOP margin 96% means we can outlast Browserbase on price for years. They can't go below 50% bundled margin. |
| "Why now vs 2 years ago?" | Operator GA + Stagehand standardization + 4x TAM growth. The window opened 6 months ago and closes in 18. |

---

## 5. Founder Prep — Your Story (5 questions)

Practice 90-second answers:

1. **"Tell me about yourself."**
   - 30s background → 30s why this problem → 30s why now/why you

2. **"Why is this a venture-scale opportunity?"**
   - $3.4B TAM by 2028 + dual-engine compounding + Browserbase already at $60M proves market

3. **"What's the one thing that has to go right?"**
   - Hire a Chromium kernel engineer in 90 days. (Be honest. Then explain your 4-channel sourcing plan.)

4. **"Why won't Browserbase win?"**
   - They went broad (cloud-only, ecosystem). We go deep (kernel + dual surface). Different optimum.

5. **"What's your unfair advantage?"**
   - Founder who built [Shieldly / prior business] knows the customer at cellular level. Pre-mapped hiring network. First to see the dual-engine play.

---

## 6. Data Room Checklist

Required before scheduling first VC meeting:

- [x] PRD.md (`docs/PRD.md`)
- [x] Cloud Runtime Architecture (`docs/CLOUD-RUNTIME-ARCH.md`)
- [x] Chromium Fork Guide (`docs/CHROMIUM-FORK-GUIDE.md`)
- [x] Phase 0 Operating Plan (`docs/PHASE-0-LAUNCH.md`)
- [x] Pitch Deck v1 (`docs/PITCH-DECK-V1.md`)
- [ ] Financial Model (24-month bottoms-up — TO BUILD)
- [ ] 5+ Customer Discovery Memo (TO CONDUCT)
- [ ] Competitive Deep-Dives (Multilogin, Browserbase — drafts exist; finalize)
- [ ] Founder Bio + LinkedIn (TO CUSTOMIZE)
- [ ] Cap Table (post-incorporation)
- [ ] Legal Setup Status (SG + Delaware)

**Data room platform**: Notion shared with view-only access OR DocSend. Track who opens what.

---

## 7. Backup Plan if Seed Fails to Close in 90 Days

| Plan | Trigger | Action |
|---|---|---|
| **Plan B** | < 2 term sheets by W10 | Apply YC W27 (next deadline) for $500k + brand |
| **Plan C** | YC reject + no terms | Strategic LP route — pitch 3 cross-border e-commerce founders for $300k bridge to MVP |
| **Plan D** | All above fail | Bootstrap Desktop alone with founder + 2 hires; defer Cloud to Series A; aim for $500k MRR by M18 then re-raise from strength |

**The point**: Mosaiq has a real Plan D that ships a fundable business without VC. This makes us *more* fundable.

---

> **Next step**: open `PITCH-DECK-V1.md`, customize slide A4 (founder bio), then render to PDF and start sending Template A on Tuesday.
