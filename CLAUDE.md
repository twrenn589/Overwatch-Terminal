# Overwatch Terminal — CLAUDE.md

Private XRP institutional adoption thesis monitoring system hosted on GitHub Pages.
This is a personal analytical dashboard, not a public tool.

## Repository

GitHub: `Overwatch-589/Overwatch-Terminal`
GitHub Pages: `https://overwatch-589.github.io/Overwatch-Terminal/`

## Project Purpose

Monitors observable institutional adoption metrics for XRP — ETF flows, RLUSD supply,
ODL volume, regulatory progress, macro stress indicators, and XRPL infrastructure
milestones. The system auto-updates every 6 hours and runs AI-assisted thesis analysis
twice daily (6am/6pm Chicago time). Telegram briefings are sent to the owner.

---

## File Structure

```
/
├── index.html                  # Single-page dashboard (all HTML/CSS/JS)
├── dashboard-data.json         # Live data feed — written by scripts, read by dashboard
├── analysis-output.json        # Last Claude analysis result (before approval)
├── CLAUDE.md                   # This file
├── scripts/
│   ├── fetch-data.js           # Data ingestion script (runs every 6h)
│   ├── analyze-thesis.js       # Claude API thesis analysis + Telegram briefing
│   ├── apply-analysis.js       # Applies approved analysis to dashboard
│   ├── push-to-github.js       # Git commit/push helper for GitHub Actions
│   ├── config.js               # API endpoints and kill-switch targets
│   ├── thesis-context.md       # Thesis framework context injected into Claude prompt
│   ├── events-history.json     # Title keys of events already inserted (dedup log)
│   ├── .env                    # Local secrets (never committed)
│   ├── .env.example            # Template for required env vars
│   └── package.json            # Node deps: dotenv, node-fetch (if needed)
└── .github/
    └── workflows/
        ├── fetch-data.yml      # Runs fetch-data.js every 6 hours
        ├── analyze-thesis.yml  # Runs analysis twice daily
        └── apply-analysis.yml  # Manual dispatch: approve or reject analysis
```

---

## Design System

**Color palette:**
- Background: `#0a0a0f` (body), `#0d0d14` (panels), `#12121c` (cards)
- Accent cyan: `#00e5ff` (primary data, headers)
- Accent green: `#00e599` (positive values, confirmed thesis items)
- Accent amber: `#ffaa00` (warnings, elevated stress)
- Accent red: `#ff4040` (critical alerts, negative values)
- Text primary: `#e0e0f0`
- Text secondary: `#8888aa`
- Text muted: `#44445a`
- Border: `rgba(255,255,255,0.06)`

**Typography:**
- Data/numbers: `JetBrains Mono` (monospace)
- Body/labels: `DM Sans` (humanist sans)

**Layout:** Mobile-first single column, tabs for sections. No build step — vanilla HTML/CSS/JS only.

**CSS classes:** `.full-card`, `.data-row`, `.data-label`, `.data-value`, `.interpret-box`, `.signal`, `.macro-pill`

---

## Scripts

### `scripts/fetch-data.js`
Runs every 6 hours via GitHub Actions. Fetches:
- XRP price/vol/mcap from CoinGecko
- RLUSD market cap from CoinGecko
- Fear & Greed index from alternative.me
- USD/JPY from Frankfurter API
- JPN 10Y, US 10Y, Brent Crude from FRED
- XRP ETF flows from `xrp-insights.com/api/flows?days=14`
- XRP supply distribution from `xrp-insights.com/api/allocations`
- News headlines from NewsData.io (fallback: CryptoPanic)

Writes `dashboard-data.json`. Always falls back to cached values on fetch failure — never throws.

### `scripts/analyze-thesis.js`
Runs at 6am and 6pm Chicago time. Steps:
1. Loads `dashboard-data.json`
2. Builds a structured prompt including all live data + news headlines + thesis context
3. Calls Claude API (`claude-opus-4-6`) to analyze thesis scorecard, kill switches, and events
4. Saves `analysis-output.json`
5. Sends Telegram briefing to owner

Claude output schema includes:
- `scorecard_updates[]` — recommended status changes per thesis category
- `kill_switch_updates[]` — recommended status changes per kill switch
- `recommended_probability_adjustment` — bear/base/mid/bull %
- `events_draft[]` — thesis-relevant news events for timeline insertion
- `stress_assessment` — level + score

### `scripts/apply-analysis.js`
Manually triggered. Reads `analysis-output.json` and:
- Applies scorecard status updates to `dashboard-data.json`
- Applies kill switch status updates
- Applies probability adjustments
- Inserts `events_draft` entries into `EVENTS_DATA` array in `index.html`
- Deduplicates events against `scripts/events-history.json`

### `scripts/config.js`
Centralized kill switch targets (update here if goals change):
- ODL Volume: $25B annualized by 2026-12-31
- RLUSD Circulation: $5B by 2026-12-31
- XRP ETF AUM: $5B by 2026-12-31
- Permissioned DEX: 5 institutions by 2026-09-30
- Clarity Act: passed or advanced by 2026-12-31

### `scripts/push-to-github.js`
Git helper used by `fetch-data.js` to commit and push `dashboard-data.json`
after each successful data fetch.

---

## GitHub Actions Workflows

### `fetch-data.yml`
- **Trigger:** Every 6 hours (cron) + manual dispatch
- **Secrets needed:** `FRED_API_KEY`, `NEWSDATA_API_KEY`
- **Steps:** checkout → setup node → npm install → configure git → `node fetch-data.js`
- **Output:** commits updated `dashboard-data.json` to main

### `analyze-thesis.yml`
- **Trigger:** 6am and 6pm Chicago time (12:00 UTC + 0:00 UTC) + manual dispatch
- **Secrets needed:** `FRED_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- **Steps:** runs fetch-data.js first (fresh data), then analyze-thesis.js
- **Output:** commits `analysis-output.json` and updated `dashboard-data.json`

### `apply-analysis.yml`
- **Trigger:** Manual dispatch only (approve / reject choice)
- **Secrets needed:** none (reads already-committed files)
- **Steps:** `node scripts/apply-analysis.js` → commits updated `dashboard-data.json` and `index.html`

---

## Required API Keys

Set as GitHub Actions Secrets and in `scripts/.env` for local development:

| Key | Source | Used By |
|-----|--------|---------|
| `FRED_API_KEY` | api.stlouisfed.org | fetch-data.js (macro yields, Brent) |
| `NEWSDATA_API_KEY` | newsdata.io | fetch-data.js (news headlines) |
| `CRYPTOPANIC_API_KEY` | cryptopanic.com | fetch-data.js (news, primary — currently 404, use as backup) |
| `ANTHROPIC_API_KEY` | console.anthropic.com | analyze-thesis.js (Claude API) |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | analyze-thesis.js (briefings) |
| `TELEGRAM_CHAT_ID` | your Telegram user ID | analyze-thesis.js (briefings) |

**Note:** `NEWSDATA_API_KEY` and `CRYPTOPANIC_API_KEY` are NOT yet added to the `fetch-data.yml` workflow secrets. Add them if news ingestion is needed in CI.

---

## Thesis Framework

### Kill Switches (falsification criteria)
The 5 tracked kill switches in `dashboard-data.json` / `config.js`:
1. **ODL Volume** — $25B annualized by EOY 2026
2. **RLUSD Circulation** — $5B market cap by EOY 2026
3. **XRP ETF AUM** — $5B total by EOY 2026
4. **Permissioned DEX** — 5 institutions by Sep 2026
5. **Clarity Act** — passed or meaningfully advanced by EOY 2026

### Scorecard Categories
8 thesis categories tracked in `dashboard-data.json.thesis_scores`:
- `regulatory` — Regulatory Clarity
- `institutional_custody` — Institutional Custody
- `etf_adoption` — ETF Adoption
- `xrpl_infrastructure` — XRPL Infrastructure
- `stablecoin_adoption` — Stablecoin (RLUSD)
- `odl_volume` — ODL Volume
- `japan_adoption` — Japan Adoption
- `macro_environment` — Macro Environment

Valid status values: `CONFIRMED`, `STRONG`, `ACCELERATING`, `GROWING`, `FAVORABLE`,
`TRACKING`, `MONITORING`, `NEEDS_DATA`, `STRESSED`, `PENDING`, `EARLY`

### Events Timeline
Events appear in `EVENTS_DATA` array at the top of the `<script>` block in `index.html`.
The array is maintained newest-first. `apply-analysis.js` inserts new events at the top.

Each event has: `date`, `dateLabel`, `title`, `category` (INSTITUTIONAL/REGULATORY/GEOPOLITICAL/FINANCIAL),
`catClass` (inst/reg/geo/fin), `threat` (CRITICAL/ELEVATED/MONITORING), `threatEmoji`, `desc`

---

## Dashboard Tabs

| Tab | ID | Description |
|-----|----|-------------|
| OVERVIEW | panel-overview | Kill switches, scorecard, event timeline |
| ETF | panel-etf | ETF flows, per-fund breakdown, supply context |
| MACRO | panel-macro | Japan, energy/commodities, Ripple/XRPL news |
| THESIS | panel-thesis | Full thesis scorecard with thesis context |
| NEWS | panel-news | Live news headlines from dashboard-data.json |

---

## Local Development

```bash
cd scripts
npm install
node fetch-data.js          # Fetch live data → dashboard-data.json
node analyze-thesis.js      # Run Claude analysis → analysis-output.json + Telegram
node apply-analysis.js      # Apply approved analysis → dashboard-data.json + index.html
```

Open `index.html` in a browser (no server needed — reads from GitHub raw URL).

---

## Key Conventions

- **Never throw in fetchers** — all fetchers return cached/fallback values on error
- **dashboard-data.json is the source of truth** — all live data flows through it
- **index.html is hand-maintained for static content** (thesis context, macro notes, events)
- **Manually-managed fields** in `dashboard-data.json.manual` are preserved on every fetch
- **Thesis scores** are preserved on every fetch, only updated via `apply-analysis.js`
- Prefer `etf.circ_supply` (from CoinGecko market_cap/price) for ETF % calculations
- Prefer `supply.circ_supply` (from xrp-insights.com) for supply breakdown display

---

## FUTURE: XRPL Native API

We can query the XRPL ledger directly via public rippled servers (e.g. `s1.ripple.com:51234`
or `wss://s1.ripple.com`) using the public JSON-RPC / WebSocket API. This eliminates
dependency on XRPScan and OnTheDex for on-chain metrics.

Relevant methods:
- `server_info` — ledger state, tx queue, fee levels
- `ledger` — ledger header + transaction list for a specific ledger index
- `book_offers` — order book for a given currency pair (DEX volume proxy)
- `amm_info` — AMM pool state (liquidity, fees)

Reference: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods
