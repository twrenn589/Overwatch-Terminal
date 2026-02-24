# OVERWATCH TERMINAL
### Autonomous Institutional Intelligence Monitor

---

## Overview

Overwatch Terminal is a private, fully autonomous thesis monitoring system built to track observable institutional adoption signals for XRP — ETF flows, stablecoin supply, on-demand liquidity volume, regulatory progress, macro stress indicators, and XRPL infrastructure milestones. It fetches live data from 12+ sources four times daily, runs AI-assisted thesis analysis twice daily using Claude Sonnet, sends structured Telegram briefings with each cycle, and publishes a live dashboard on GitHub Pages. The system was built from scratch by a career fire lieutenant with no prior coding experience, using AI-assisted development as the primary toolchain. The goal was to create something rigorous: a monitor that maintains intellectual honesty through pre-defined kill switches, a dual-mandate AI analyst required to argue both the bull and bear case, and a dedicated counter-thesis layer tracking competing infrastructure and macro headwinds.

---

## Architecture

| Layer | Description |
|-------|-------------|
| **Data Layer** | 12+ sources ingested into `dashboard-data.json` — runs every 6 hours via GitHub Actions |
| **Analysis Layer** | Claude AI dual-mandate analyst — required to score both the bull thesis and counter-thesis; runs at 6am and 6pm Chicago time |
| **Counter-Thesis Layer** | Dedicated BEAR evaluation with auto-calculated signals, competing infrastructure tracking, macro headwind assessment, and AI-generated bear narrative |
| **Delivery Layer** | Telegram briefings include thesis probability distribution, stress index, kill switch status, bear score, and relevant events |
| **Approval Gate** | Analysis is staged for human review before applying — owner approves or rejects each analysis cycle |
| **Recursive Learning** | Full analysis history logged; monthly audit system planned to surface drift and recalibrate scoring |
| **Hardening** | Per-source retry logic, health check tracking, automated failure alerts via Telegram, backup/restore on every deploy |
| **Dashboard** | GitHub Pages — tabbed interface with Overview, ETF, Macro, Thesis, News, Bear, and additional sections |

---

## Data Sources

| Source | Status | What It Tracks |
|--------|--------|----------------|
| CoinGecko | ✅ Active | XRP price, volume, market cap, RLUSD market cap |
| xrp-insights.com | ✅ Active | XRP ETF flows, AUM, per-fund breakdown, XRP supply distribution |
| iShares (IBIT / ETHA) | ✅ Active | BTC and ETH ETF daily flows and AUM for macro comparison |
| XRPL Native JSON-RPC | ✅ Active | Ledger tx throughput, fee burn rate, DEX order book depth (s1.ripple.com) |
| Alpha Vantage | ✅ Active | USD/JPY real-time FX (Japan stress indicator primary source) |
| Frankfurter | ✅ Active | USD/JPY ECB fallback when Alpha Vantage unavailable |
| FRED (St. Louis Fed) | ✅ Active | US 10Y yield, Brent crude, Japan 10Y bond yield |
| alternative.me | ✅ Active | Crypto Fear & Greed Index |
| NewsData.io | ✅ Active | XRP/Ripple/XRPL/RLUSD news headlines |
| CryptoPanic | ✅ Active | News backup (important stories filtered) |
| Japan 10Y (FRED) | ⚠️ Lagging | Monthly FRED series — 1-3 day lag; daily source planned |
| DEX Volume | 🔲 Planned | XRPL native DEX 24h volume — endpoint identified, not yet active |

---

## How It Works

**Fetch cycle (every 6 hours):** GitHub Actions runs `fetch-data.js`, which pulls from all live sources in parallel, merges results with preserved manual and thesis fields, writes `dashboard-data.json`, and commits the update to main — which GitHub Pages then serves publicly.

**Analysis cycle (6am / 6pm Chicago time):** GitHub Actions first runs a fresh data fetch, then passes the complete dataset plus thesis context to Claude Sonnet via the Anthropic API. The prompt enforces a dual mandate: the model must evaluate the bull thesis across 8 scored categories *and* produce a counter-thesis assessment with a 0–100 bear score, competing infrastructure risk ratings, and a bear narrative. The analysis output is staged in `analysis-output.json`.

**Approval gate:** The owner reviews the staged analysis and triggers a manual dispatch workflow to apply or reject it. Approved analyses update `dashboard-data.json` (thesis scores, kill switch status, probability distribution, bear case fields) and insert new events into the dashboard timeline.

**Telegram briefing:** Each analysis cycle sends a structured briefing with thesis probability (bear/base/mid/bull), stress level, kill switch status, bear score, and top events — delivered immediately after the analysis completes, before the approval gate.

---

## Kill Switches

Five pre-defined falsification criteria with tracked targets and deadlines. If any kill switch is missed by its deadline, the thesis is considered invalidated.

| Kill Switch | Target | Deadline |
|-------------|--------|----------|
| ODL Volume | $25B annualized | 2026-12-31 |
| RLUSD Circulation | $5B market cap | 2026-12-31 |
| XRP ETF AUM | $5B total | 2026-12-31 |
| Permissioned DEX | 5 institutions live | 2026-09-30 |
| Digital Asset Clarity Act | Passed or meaningfully advanced | 2026-12-31 |

---

## Cost

Approximately **$1–2/month** in Claude API usage. All data sources operate on free tiers. Infrastructure runs entirely on GitHub Actions free minutes and GitHub Pages.

---

## Tech Stack

- **Orchestration:** GitHub Actions (cron scheduling, manual dispatch, secrets management)
- **Runtime:** Node.js — vanilla, no framework, no build step
- **AI Analysis:** Anthropic Claude API (`claude-sonnet-4-20250514`)
- **Dashboard:** GitHub Pages — single-file HTML/CSS/JS, no bundler
- **Alerts:** Telegram Bot API
- **XRPL Data:** Native rippled JSON-RPC (`s1.ripple.com:51234`)
- **Macro Data:** FRED API, Alpha Vantage, Frankfurter
- **ETF Data:** iShares CSV endpoints, xrp-insights.com
- **Market Data:** CoinGecko, alternative.me
- **News:** NewsData.io, CryptoPanic

---

## Status

**Phase 5 complete.** The system is running autonomously with full data ingestion, AI analysis, counter-thesis evaluation, Telegram delivery, approval gating, health monitoring, and backup/restore.

**Running since:** February 2026

**Next milestones:**
- Stability monitoring — clean autonomous operation confirmed over 2-3 day window
- Prediction tracker — log AI probability calls against outcomes
- x402 testnet agent — experimental micropayment-gated data layer
- Monthly audit system — surfaces thesis drift from 30+ analysis history entries

---

*Private repository. Dashboard hosted at [overwatch-589.github.io/Overwatch-Terminal](https://overwatch-589.github.io/Overwatch-Terminal/)*
