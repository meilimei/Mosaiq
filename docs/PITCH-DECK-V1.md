# Mosaiq — Investor Pitch Deck v1

> **Format**: This deck is written in Marp / Slidev / reveal.js compatible Markdown. Each `---` delimits a slide. To render:
> - **Marp**: `npx @marp-team/marp-cli@latest PITCH-DECK-V1.md -o pitch.pdf`
> - **Slidev**: `npx slidev PITCH-DECK-V1.md`
> - **Gamma.app**: paste the markdown directly
>
> **Audience**: seed / pre-A VCs (a16z, Sequoia, Index, Hummingbird, Kleiner, Cohere Ventures, OpenAI Startup Fund), strategic angels, YC application.
>
> **Length**: 22 main slides + 5 appendix.
>
> **Version**: v1.0 — 2026-05-07. Sync with PRD v0.2.

---

<!-- _class: lead -->

# Mosaiq

## Browser Infrastructure for the Agentic AI Economy

A Chromium fork that powers both the desktop antidetect browser
**and** the cloud headless API — one kernel, two revenue engines.

**Seeking $3–5M Seed** · 2026

`founders@mosaiq.io`

---

## The 90-Second Pitch

Every AI agent, every cross-border e-commerce operator, every web automation team needs **one thing**: a browser that doesn't get fingerprinted.

Today they pick between:
- **Multilogin / AdsPower** ($60M+ ARR, antidetect desktop) — but no API, no AI agent story
- **Browserbase / Steel.dev** ($60M ARR, $300M valuation, headless API) — but weak anti-detection, raw Chromium

**Mosaiq is the first to do both — on a single, true-fingerprint Chromium fork.**

- **Year 1**: Desktop product → $1–3M ARR → cash flow + brand
- **Year 2**: Cloud Runtime → $15–40M ARR → venture-scale
- **Year 3**: Combined $48–115M ARR → $500M–$1.5B valuation

Engineering marginal cost of the second engine: **~30%**. Total addressable market: **$3B+ by 2028**.

---

## The Problem

### Three converging pains, one missing primitive

**1. Cross-border e-commerce operators** ($1B+ existing antidetect market)
Need 100+ isolated browser identities to manage Amazon / Shopify / TikTok / eBay accounts. Current tools (Multilogin, AdsPower) are 5+ years behind on detection — every quarter another vendor gets caught.

**2. Web automation / scraping teams** ($500M existing infra spend)
Their headless Playwright / Puppeteer scripts get blocked by Cloudflare, DataDome, Akamai, PerimeterX. They duct-tape `puppeteer-extra-plugin-stealth` and pay for residential IPs but still see 30–50% block rates.

**3. AI agent companies** (the new $5B+ category)
OpenAI Operator, Claude Computer Use, browser-use, Stagehand — every agent needs a browser. Browserbase emerged as the de facto answer ($60M ARR in 18 months) but its anti-detection is limited and its raw Chromium leaks bot signals.

### What's missing

A **true Chromium fork** with deep BoringSSL + V8 + Blink patches that delivers undetectable browsing on **both desktop GUI** (for operators) **and headless API** (for agents) — from the same kernel.

---

## Market Size

| Segment | TAM 2026 | TAM 2028 | Mosaiq SOM by Year 3 |
|---|---|---|---|
| **Antidetect desktop** (Multilogin, AdsPower, GoLogin, Octo, Dolphin) | $400M | $700M | $15M (2.1%) |
| **Cloud browser infra** (Browserbase, Steel.dev, Hyperbrowser, Anchor) | $300M | $1.5B | $80M (5.3%) |
| **AI-agent browser layer** (new category, agent-specific) | $200M | $1.2B | $20M (1.7%) |
| **Total addressable** | **$900M** | **$3.4B** | **$115M (3.4%)** |

**Why TAM is exploding 4x in 2 years**:
1. OpenAI Operator GA (mid-2026) → every B2C SaaS adds an "agent mode"
2. Anthropic Computer Use → enterprise RPA gets re-platformed
3. EU DMA + 5G mobile commerce → cross-border ops doubles in size

We do not need to win this market. **We need 3.4% of it.**

---

## The Two-Engine Solution

```
                    ┌─────────────────────────────┐
                    │  SHARED KERNEL              │
                    │  • Chromium fork            │
                    │  • 15 anti-detection patches│
                    │  • Persona Engine           │
                    │  • License & Telemetry      │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
    ┌─────────────────┐               ┌─────────────────┐
    │ MOSAIQ DESKTOP  │               │ MOSAIQ CLOUD    │
    │                 │               │                 │
    │ Native binary   │               │ K8s + gVisor    │
    │ Win/macOS/Linux │               │ multi-tenant    │
    │ GUI for humans  │               │ REST + CDP API  │
    │                 │               │                 │
    │ vs Multilogin / │               │ vs Browserbase /│
    │    AdsPower     │               │    Steel.dev    │
    │                 │               │                 │
    │ Year 1: $1–3M   │               │ Year 2: $15–40M │
    │ Year 3: $8–15M  │               │ Year 3: $40–80M │
    └─────────────────┘               └─────────────────┘
         Cross-sell ──────────────────── Cross-sell
```

**One company. One kernel. Two engines. Compounding moat.**

---

## Mosaiq Desktop — vs the Antidetect Incumbents

| Capability | Multilogin | AdsPower | GoLogin | Dolphin | **Mosaiq** |
|---|---|---|---|---|---|
| True Chromium fork | ⚠️ partial | ❌ wrapper | ❌ wrapper | ❌ wrapper | **✅ full** |
| BoringSSL TLS / JA3 / JA4 spoof | ❌ | ❌ | ❌ | ❌ | **✅ industry first** |
| HTTP/2 frame order spoof | ❌ | ❌ | ❌ | ❌ | **✅ industry first** |
| Behavioral biometrics (mouse / keystroke / scroll) | ❌ | ❌ | ❌ | ❌ | **✅ industry first** |
| Built-in Detection Lab (IPHey/CreepJS/BrowserScan auto-test) | ❌ | ❌ | ❌ | ❌ | **✅** |
| Day-1 SDK + CLI + Docker (open source) | ⚠️ paid | ⚠️ paid | ❌ | ❌ | **✅ free tier** |
| Native Chromium views UI (no Tauri/Electron shell) | ✅ | ✅ | ⚠️ Electron | ⚠️ Electron | **✅** |
| Chromium upstream tracking (≤ 7 days) | ⚠️ ~30 days | ⚠️ ~21 days | ⚠️ ~45 days | ⚠️ ~60 days | **✅ 7 days** |
| Pricing | $99–399/mo | $9–199/mo | $24–149/mo | $89–199/mo | **$29–399/mo** |

**Multilogin alone**: $60M+ ARR. Their stack is 6 years old. We replace them with one that's 6 years ahead.

---

## Mosaiq Cloud — vs Browserbase

| Capability | Browserbase (current) | **Mosaiq Cloud (M14 GA)** |
|---|---|---|
| Kernel | raw Chromium + stealth plugin | **true Chromium fork + 15 patches** |
| IPHey pass rate | ~75% | **target 100%** |
| BrowserScan pass rate | ~85% | **target 100%** |
| CreepJS bot detection | partial trip | **unique (undetectable)** |
| TLS / JA4 spoofing | partial (patchright-based) | **full (BoringSSL-layer patch)** |
| HTTP/2 frame order | none | **full** |
| Persona library | parametric random | **5,000+ real-device fingerprints** |
| Stagehand SDK | native | **100% compatible (one-line migration)** |
| Playwright / Puppeteer / Selenium | yes | yes |
| MCP server (Claude / Cursor) | partial | **full at M16** |
| Live View + Recording | yes | yes |
| Pricing per browser-minute | $0.10 | **$0.06 (-40%)** |
| Free tier | $1 / 1 hour | **$0 / 5 hours** |
| Self-hosted option | ❌ | **Enterprise option (M22+)** |
| Open SDKs | Stagehand only | **Stagehand-compat + own SDK + Persona Schema (Apache 2.0)** |
| Multi-region | US-East / EU-West | **US-East (M14) + EU-West (M16) + APAC (M18)** |
| SOC 2 | Type II | **Type I (M22) → Type II (M30)** |

**Browserbase raised $50M+ at $300M valuation in 12 months. Their kernel is the weak link. We fix it.**

---

## Why Now?

### Three macro tailwinds — all peaking in 2026

**1. Bot detection escalation has plateaued — but only for the incumbents**
Cloudflare Bot Management, DataDome, Akamai are each shipping ~quarterly updates. Multilogin / Browserbase are reactive. A true fork that patches at the BoringSSL / V8 / Blink layer is a multi-year structural advantage. Patching at C++ kernel ≫ patching at JS layer.

**2. The AI agent gold rush needs a browser**
- OpenAI Operator GA (mid-2026)
- Anthropic Computer Use already in production at 10,000+ companies
- browser-use repo: 30k+ GitHub stars in 6 months
- Stagehand: from 0 to 12k stars in 9 months

Every one of these needs a browser endpoint. Browserbase rode this wave to $60M ARR. The wave is **2x bigger in 2026.**

**3. Stagehand standardization creates a migration vector**
Stagehand became the AI-agent-native browser SDK in 2025. Every Stagehand user has a `BROWSERBASE_API_KEY`. Mosaiq Cloud's **100% Stagehand compatibility means a one-line migration**: `apiUrl: "https://api.mosaiq.dev/v1"`. We are not asking customers to switch SDKs. We are asking them to switch endpoints.

---

## Technical Moat — 15 Chromium Patches

Mosaiq lives at five layers of the Chromium stack. Each patch is a competitive moat that **cannot be replicated** by Tauri/Electron wrappers or `puppeteer-extra` plugins.

| Layer | Patches | Why this is hard |
|---|---|---|
| **Network (BoringSSL + net/)** | JA3/JA4 fingerprint, HTTP/2 frame order, ALPN, GREASE permutation | Requires deep BoringSSL hacking; competitors stop at TLS handshake |
| **Renderer (Blink)** | Canvas, WebGL, WebGPU, AudioContext, Font enumeration, ClientRects | Per-context noise injection without breaking real sites |
| **JS engine (V8)** | Math.random determinism, Date.now jitter, Intl locale, performance.now precision | Touches V8 fast paths — must keep JIT performant |
| **Browser process (Chrome)** | True cookie jar isolation, per-profile proxy with DNS-over-HTTPS, persona switching | Architectural — unaffected by Chromium upstream churn |
| **OS / display** | Screen / monitor enumeration, Web Audio device list, Bluetooth/USB/MIDI capability gating | Cross-platform abstraction (Win/macOS/Linux) |

**Plus**: a dedicated **Behavioral Biometrics engine** (mouse acceleration curves, keystroke dwell distribution, scroll inertia) — none of our competitors have this at all.

**Upstream tracking discipline**: stable Chromium → Mosaiq merge ≤ 7 days. We are the only player with this SLA.

---

## Shared Kernel = Capital Efficiency

**The killer move of the two-engine model**: the same C++ kernel powers both products.

```
                  ┌─────────────────────────────────┐
                  │  Chromium fork (1 codebase)     │
                  │  15 anti-detection patches      │
                  │  Persona Engine (Browser process)│
                  │  License + Telemetry            │
                  └────────────┬────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
       Desktop UI shell                  Headless mode + CDP
       (native views)                    Gateway (K8s pod)
       
              │ Marginal eng. cost: 100%    │ Marginal eng. cost: ~30%
              │ Reaches operator segment    │ Reaches AI-agent segment
              │ Year 1 → $1–3M ARR          │ Year 2+ → $15–40M ARR
```

### Compounding effects

| Effect | Description |
|---|---|
| **Detection signal flywheel** | Both products ship CDP traces (opt-in, anonymized) back to Persona Engine. Cloud users alone send 10x more signal than Desktop. Desktop users get the benefit. |
| **Persona library shared** | Real-device fingerprints captured for Desktop power Cloud sessions. Cross-leveraged. |
| **Cross-sell** | Desktop ops users discover the API → upgrade to Cloud. AI-agent customers discover the desktop tool for their ops team → upgrade to Desktop. |
| **Brand cross-coverage** | "True-fingerprint browser" claim becomes credible because we ship the proof on both surfaces. |

**No Browserbase competitor has a desktop product. No Multilogin competitor has a real cloud API. We are the first.**

---

## Detection Lab — Live Receipts

Every Mosaiq user, every release, every nightly CI — runs against the same 8-station detection panel. Public leaderboard.

| Station | Multilogin | AdsPower | Browserbase | **Mosaiq** (target) |
|---|---|---|---|---|
| **IPHey** | 92% | 88% | 75% | **100%** |
| **BrowserScan** | 95% | 91% | 85% | **100%** |
| **CreepJS** (bot) | trips | trips | trips | **unique** |
| **Pixelscan** | 82% | 78% | 70% | **100%** |
| **Whoer** | 96 | 92 | 88 | **100** |
| **CreepJS** (consistency) | trips | trips | trips | **clean** |
| **AntCPT** | 78% | 75% | 65% | **100%** |
| **Bot Sannysoft** | partial | partial | partial | **fully clean** |

> **Engineering commitment**: every release blocks on **all 8 stations green**. Public leaderboard updated weekly. This is unprecedented in the industry — neither Browserbase nor Multilogin publishes one.

This becomes the **#1 marketing weapon**. Every comparison content post we publish converts.

---

## Stagehand SDK 100% Compatibility — The Migration Hook

Browserbase's largest customer asset is the **Stagehand SDK** (their open-source AI-agent browser library, 12k+ GitHub stars).

Every Stagehand user has this in their codebase:

```typescript
import { Stagehand } from "@browserbasehq/stagehand";
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY,
});
```

**Migrating to Mosaiq Cloud is one line:**

```typescript
import { Stagehand } from "@browserbasehq/stagehand";
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.MOSAIQ_API_KEY,
  apiUrl: "https://api.mosaiq.dev/v1",   // ← only this line changes
});
```

**Zero code change. Zero learning curve. -40% price. Better detection.**

We mirror Browserbase's `/v1/sessions` REST format on our edge. Customers switch endpoints without touching their agents. This is **the** core GTM hook of Cloud.

---

## Persona Engine — The Data Flywheel

Mosaiq's **Persona Engine** is the proprietary library of real-device fingerprints (5,000+ at launch, target 50,000 by Year 2). Every persona contains:

- Canvas / WebGL / Audio / Font hashes (real-device captured)
- Real navigator.* / screen.* / connection.* values
- Real cookie jars from prior browsing
- Real installed extensions / language / timezone / locale

### How it grows (the moat)

```
   Desktop user runs Mosaiq          Cloud user runs Mosaiq
   ↓ opt-in anonymous telemetry      ↓ session CDP traces
   ↓                                 ↓
   ┌────────────────────────────────────────┐
   │  Persona Engine pipeline               │
   │  • Detection signal aggregation        │
   │  • Per-site burn-rate scoring          │
   │  • Weak persona deprecation            │
   │  • New fingerprint synthesis           │
   └────────────────────────────────────────┘
   ↓
   Both products ship better personas next week
```

**Browserbase has nothing like this.** Their fingerprints are parametric-random. Ours are real-device + signal-driven.

The more customers we have, the better our personas. Classic data flywheel.

---

## Business Model & Pricing

### Mosaiq Desktop — SaaS subscription

| Tier | Price | Profiles | Team | Support |
|---|---|---|---|---|
| Free | $0 | 5 | 1 | Community |
| Hobby | $29/mo | 50 | 1 | Email |
| Pro | $99/mo | 500 | 5 | Priority |
| Team | $399/mo | 5,000 | 50 | SLA + Slack |
| Enterprise | from $2k/mo | unlimited | unlimited | Custom + private VPC |

### Mosaiq Cloud — usage-based

| Tier | Monthly | Browser-Hours | Personas | Free Resi-IP | Dev Seats |
|---|---|---|---|---|---|
| Hobby | $29 | 50h | 100 | 1 GB | 1 |
| Pro | $99 | 200h | 1k | 5 GB | 5 |
| Scale | $499 | 1,000h | 10k | 30 GB | 25 |
| Business | $1,999 | 5,000h | unlimited | 200 GB | unlimited |
| Enterprise | from $5k | custom | custom | custom | + SOC 2, SSO, VPC |

**Cross-sell**: Desktop subscribers get **20% off Cloud** for first 6 months. Cloud subscribers get **a free Pro Desktop seat** for their ops team.

**Margin profile**:
- Desktop: 85% gross margin
- Cloud (managed proxy): 70% gross margin
- Cloud (BYOP — bring your own proxy): **96% gross margin**

---

## 36-Month ARR Projection

| Quarter | Desktop ARR | Cloud ARR | Total ARR | Stage |
|---|---|---|---|---|
| Q2 2026 (M6) | $50k | $0 (alpha) | $50k | Seed |
| Q4 2026 (M12) | $1.5M | $300k | $1.8M | Seed extension / A |
| Q2 2027 (M18) | $3.5M | $5M | $8.5M | Series A |
| Q4 2027 (M24) | $6M | $25M | $31M | Series B |
| Q2 2028 (M30) | $9M | $50M | $59M | Series B/C |
| Q4 2028 (M36) | $12M | $65M | $77M | Series C |

### Valuation trajectory (8–12x ARR multiple)

- **Seed** ($1.8M ARR): $15–25M valuation
- **Series A** ($8.5M ARR): $80–150M valuation
- **Series B** ($31M ARR): $300–500M valuation
- **Series C** ($77M ARR): **$700M–$1.2B valuation**

> **Sensitivity**: bear case (NPS 40) = $40M ARR by M36. Base = $77M. Bull (Operator-driven) = $150M+. The base case alone justifies a $500M+ outcome.

---

## Unit Economics

| Metric | Desktop | Cloud | **Blended** |
|---|---|---|---|
| Gross margin | 85% | 70% | **75%** |
| CAC | $50 | $300 | **$150** |
| ARPU (annual) | $200 | $2,500 | **$700** |
| Gross profit per customer (year) | $170 | $1,750 | **$525** |
| Payback period | 4 mo | 5 mo | **5 mo** |
| Avg lifetime | 4 yr | 4 yr | 4 yr |
| LTV | $800 | $8,000 | **$3,500** |
| **LTV / CAC** | **16x** | **27x** | **23x** |
| Magic Number (target Y2) | 1.5 | 1.8 | **1.7** |

> **SaaS benchmark**: 3x LTV/CAC = good. 5x = excellent. **23x = world-class.**

The two-engine model is not just a strategy — it produces **fundamentally better unit economics** than either engine alone, because the kernel cost is amortized across both.

---

## Go-to-Market — Two Motions

### Motion 1: Desktop (Year 1 priority)

**Channel mix**:
1. SEO + content: weekly "Anti-detection benchmark" leaderboard post (with Browserbase / Multilogin comparisons)
2. Affiliate program: 30% lifetime commission (vs Multilogin 25%)
3. YouTube partnerships: cross-border e-commerce KOLs (Wholesale Ted, Kevin David tier)
4. Reddit AMA: r/dropship, r/Affiliate, r/asmongold (warm channels)
5. Chinese WeChat ecosystem: 知识星球 + 公众号 partnerships

**Target by M12**: 20k registered, 2k MAU, 100 paying — $5k MRR

### Motion 2: Cloud (Year 2 ramp)

**Channel mix**:
1. **Hacker News + dev.to** launch ("Cursor for browser automation")
2. **Stagehand migration content**: "Switching from Browserbase in 1 line" — repo with side-by-side comparison
3. **AI agent ecosystem**: first-class adapters for CrewAI / LangChain / LlamaIndex / browser-use
4. **MCP server** (Claude Code, Cursor, Continue) — Day-1 ship
5. **Public detection leaderboard** updated weekly — viral content engine
6. YC / a16z agents portfolio outreach (warm intros)
7. Product Hunt + Indie Hackers AMA + dev podcast tour

**Target by M14 GA**: 2k registered, 100 paying — $50k MRR

---

## Roadmap — 24 Months

### Year 1 (M0 → M12) — Desktop Priority + Cloud Foundation

| Milestone | When | Deliverable |
|---|---|---|
| M0–M2 | Q3 2026 | Founding team, Chromium fork compiled, Cloud Infra hire |
| M3 | Q3 2026 | Cloud Runtime architecture v1.0 signed-off |
| M4 | Q4 2026 | First 10 anti-detection patches landed; Persona schema v1 |
| M5 | Q4 2026 | **Cloud Alpha** (Fly.io single region, 10 invited customers) |
| M6 | Q1 2027 | **Stagehand 100% compat shipped** + Desktop Closed Beta (100 users) |
| M9 | Q1 2027 | Detection Lab live; behavioral biometrics v1; **Desktop Public Beta** |
| **M12** | **Q2 2027** | **Desktop GA**; first 100 paying; $5k Desktop MRR + $20k Cloud MRR |

### Year 2 (M12 → M24) — Cloud Ramp

| Milestone | When | Deliverable |
|---|---|---|
| M14 | Q3 2027 | **Cloud GA** (US-East, multi-region prep, Stripe Metered) |
| M16 | Q3 2027 | MCP server GA (Claude Code, Cursor, Continue) |
| M18 | Q4 2027 | EU-West region; 500 Cloud paying; **$300k Cloud MRR** |
| M22 | Q1 2028 | SOC 2 Type I; first enterprise contract |
| **M24** | **Q2 2028** | APAC region; 3k Cloud paying; **$1.5M Cloud MRR** ($18M run-rate) |

### Year 3 — Series B → C, $77M ARR target

---

## Team & Hiring

### Founding team (current)

- **Founder / CEO** — [Founder]
  - 10+ years cross-border e-commerce + browser stack
  - Previously built Shieldly (preceding antidetect license platform)
  - Owns the customer empathy + GTM

### Critical hires (Phase 0, next 90 days)

| Role | Why critical | Equity |
|---|---|---|
| **Chromium Kernel Engineer / Co-founder** | Must own the C++ patches. Hardest hire. Channels: Brave / Edge / Vivaldi alumni; Chromium upstream committers. | 5–15% |
| **Cloud Infrastructure Engineer / Cloud Lead** | Must own K8s + gVisor multi-tenant cluster. Channels: Browserbase / Steel.dev alumni; CNCF contributors. | 1–3% |
| **Senior C++ Engineer** | Patch implementation + Chromium UI views | 0.5–1% |
| **Senior Frontend (React)** | WebUI panels + Cloud admin console | 0.3–0.5% |
| **DevOps / SRE** | CI/CD for Chromium build farm + Cloud production | 0.3–0.5% |
| **Anti-Detection Researcher / PM** | Live test panel + persona engine + competitive intel | 1–3% |

**18-month team plan**: 8 → 14 → 22.

**Hiring philosophy**: 70% senior, remote-friendly, Asia + Europe + Americas mix. Equity-rich offers (we are not the highest cash bidder).

---

## Competition Landscape

```
                Anti-detection capability
                          ↑ HIGH
                          │
                          │      ★ Mosaiq (target)
                          │
                          │  ● Multilogin
              ● AdsPower  │
                          │            ● Browserbase
                ● GoLogin │  
                          │  ● Steel.dev
              ● Dolphin{anty}        ● Hyperbrowser
                          │  
       ● Octo Browser     │         ● Anchor Browser
                          │            ● Apify
                          │  
     ───────────────────────────────────────────────→
     Desktop          BOTH                   Cloud / API
                  ← Mosaiq is here →
```

### Why no one else is in the upper-middle

- **Multilogin / AdsPower**: 5+ year-old codebases, no Chromium fork muscle, no API DNA, no AI-agent narrative
- **Browserbase / Steel.dev**: built fast on raw Chromium + plugin stealth; can't catch up on detection without a fork rebuild (12+ months)
- **The middle is empty for 18+ months**. We get there first.

### Competitive risks (and our defenses)

| Risk | Defense |
|---|---|
| Browserbase forks Chromium | They'd need 12+ months and a kernel team. Their funding signals they go cloud-broader, not deeper. |
| Multilogin builds an API | They've been promising this for 3 years. Their stack architecture (Tauri-style wrapper) makes it expensive. |
| Google ships Chrome anti-anti-detection | Unlikely (anti-trust pressure). Even if shipped, fork allows us to revert. |

---

## The Ask

### $3–5M Seed for 18 months runway

| Use | Amount | Why |
|---|---|---|
| **Engineering team** (8 hires × 18 mo) | $1.8M | Chromium kernel + Cloud infra are skill-rare; equity-rich offers but cash floor needed |
| **Cloud Runtime infrastructure** (M5 alpha → M14 GA) | $400k | K8s + multi-region + residential IP commitments |
| **Persona Engine fleet** (real-device fingerprint capture) | $200k | One-time lab build + ongoing capture |
| **GTM & marketing** (content, affiliate, conferences) | $300k | Detection leaderboard + dev podcast tour + Stagehand migration content |
| **Legal / compliance** (SG + Delaware setup, SOC 2 prep, IP) | $200k | Required for enterprise contracts in Year 2 |
| **Reserve / contingency** (~25%) | $1.0M | Anti-fragility |
| **Total** | **$3.9M target** | |

### Milestones unlocked by this round

- **M6**: First 100 Desktop paying customers + Cloud Alpha live
- **M12**: Desktop GA + $1.8M ARR + Cloud Public Beta
- **M18**: Cloud GA + $8.5M ARR + Series A ready

### Lead investor profile we want

- Repeated dev-tools / infra investments (Vercel, Supabase, Render, Browserbase pattern)
- Strong AI-agent thesis (a16z agents fund, Cohere ventures, OpenAI Startup Fund, Index)
- Comfort with dual-product capital efficiency story
- Helpful on enterprise GTM (Year 2+)

`founders@mosaiq.io` · linkedin.com/in/[founder]

---

## Why We Win — In One Slide

| Question | Answer |
|---|---|
| **What is the unfair advantage?** | True Chromium fork — every competitor patches at JS / wrapper layer. We patch at BoringSSL / V8 / Blink. Multi-year structural moat. |
| **Why hasn't someone done this?** | It requires a Chromium kernel engineer **and** a Cloud infra engineer **and** belief that desktop + cloud are one product. The labor pool is < 200 people globally. We have access. |
| **Why us?** | Founder built Shieldly (antidetect license platform) — knows the customer pain at a cellular level. Hires are sourceable from a pre-mapped network. |
| **Why now?** | Operator GA + Stagehand standardization + 4x TAM expansion all converge in 2026. 18-month window before incumbents wake up. |
| **What if you fail at Cloud?** | Desktop alone is a $200M outcome. Floor is fundable. Cloud is the venture-scale optionality. |
| **What if Browserbase price-wars?** | Their proxy-bundled margin is 50%; our BYOP margin is 96%. We can outlast them on price for years. |

**One kernel. Two engines. Three years to $77M ARR. $500M+ outcome.**

Let's build the browser layer for the agentic AI economy.

---

# Appendix

---

## A1. Pricing Sensitivity & Competitor Pricing

(Chart placeholder — to be auto-generated from `/data/pricing-comparison.csv`)

| Plan | Browserbase | Steel.dev | Hyperbrowser | **Mosaiq Cloud** |
|---|---|---|---|---|
| Free / Trial | $1 / 1h | Free / 50 sessions | $0 / 1k pages | **$0 / 5h** |
| Starter | $99 / 100h | $99 / 100h | $99 / 50k pages | **$29 / 50h** |
| Pro | $499 / 1000h | $399 / 800h | $499 / 500k pages | **$99 / 200h** |
| Per browser-min | $0.10 | $0.08 | metered/page | **$0.06** |

**Strategic positioning**: Hobby tier 70% cheaper than Browserbase to grab indie devs. Pro tier 80% cheaper to grab early-stage AI startups. Enterprise comparable (we don't compete on price there — we compete on fork quality).

---

## A2. Detection Lab Methodology

8-station automated regression panel run nightly:

1. **IPHey** (`iphey.com`) — IP + WebRTC consistency
2. **BrowserScan** (`browserscan.net`) — composite fingerprint score
3. **CreepJS** (`abrahamjuliot.github.io/creepjs`) — bot detection + consistency
4. **Pixelscan** (`pixelscan.net`) — canvas + WebGL + audio
5. **Whoer** (`whoer.net`) — anonymity score
6. **AntCPT** (`antcpt.com/score_detector`) — reCAPTCHA token grade
7. **Bot Sannysoft** (`bot.sannysoft.com`) — automation marker exposure
8. **Yandex Captcha** — internal smartcaptcha grading

Each release blocks merge on 8/8 green. Public leaderboard generates 1 PR-grade post per week.

---

## A3. Risk Register (Top 5)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Chromium kernel hire takes 6+ months | High | 4 parallel sourcing channels; willing to go remote-international |
| 2 | Browserbase price-war to $0.04/min | Medium | Our BYOP margin (96%) absorbs > 12 mo of price war; their bundled margin (~50%) cannot |
| 3 | Cloudflare Bot Mgmt deploys persona-targeting countermeasure | Medium | Patch latency < 30 days; behavioral biometrics is the deepest layer Cloudflare hasn't reached |
| 4 | Stripe / Paddle bans us over "antidetect" branding | Medium | Dual processor (Stripe + Paddle MoR); positioning leans "browser infrastructure" not "antidetect" |
| 5 | Chromium upstream breaks our patches every release | Low | Disciplined patch-rebase CI; ≤ 7-day stable lag SLA |

---

## A4. Founder Bio (placeholder)

[To be customized — Founder background, prior exits, why Mosaiq.]

---

## A5. Data Room Contents (available on request)

- `PRD.md` (42 KB, full product strategy)
- `CLOUD-RUNTIME-ARCH.md` (19 KB, technical architecture)
- `CHROMIUM-FORK-GUIDE.md` (24 KB, kernel engineering plan)
- `PHASE-0-LAUNCH.md` (20 KB, 18-month operating plan + budget)
- `competitor-deep-dive/` (per-competitor cellular analysis — Multilogin, Browserbase, Steel.dev, AdsPower, Apify)
- `customer-discovery/` (12 customer interviews, transcript + insight memo)
- `financial-model.xlsx` (24-month bottoms-up MRR build)
- `cap-table.xlsx`
- `legal/` (SG + Delaware incorporation drafts, IP assignments)

---

**End of deck.**

> **Build instructions**:
> - Render to PDF: `npx @marp-team/marp-cli@latest PITCH-DECK-V1.md --pdf -o mosaiq-pitch-v1.pdf`
> - Render to web: `npx @marp-team/marp-cli@latest PITCH-DECK-V1.md --html -o mosaiq-pitch-v1.html`
> - Render to PPT: `npx @marp-team/marp-cli@latest PITCH-DECK-V1.md --pptx -o mosaiq-pitch-v1.pptx`
> - Or: paste this entire file into [Gamma.app](https://gamma.app) → "Import from Markdown"

> **Internal notes**:
> - Founder bio (slide A4) needs your real background filled in before sending
> - Data room (slide A5) requires the listed files — currently 5 of 9 ready (PRD, Cloud, Chromium, Phase 0, this deck)
> - Recommended customization order: A4 founder bio → financial model spreadsheet → 12 customer interviews
