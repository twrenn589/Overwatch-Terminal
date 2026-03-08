#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — Four-Layer Autonomous Analyst
 *
 * Architecture: SWEEP → CONTEXTUALIZE → INFER → RECONCILE
 * Each layer receives ONLY the output of the layer before it.
 * Each layer filters signal from noise (compression funnel).
 *
 * Layer 1 (SWEEP):        Widest intake, no filtering. 100+ observations → top 15.
 * Layer 2 (CONTEXTUALIZE): Knowledge audit + contextual scoring. Verifies before scoring.
 * Layer 3 (INFER):         Game theory, circuit breakers, feedback loops. WHY is this happening?
 * Layer 4 (RECONCILE):     Judgment. Burden of proof. Final score and recommendation.
 *
 * Design docs (PRIVATE — never commit prompts to public repo):
 *   LAYER-2-3-4-PROMPTS-DRAFT.md
 *   OVERWATCH-CIRCUIT-BREAKERS.md
 *   ARCHITECTURE-DECISION-CORRECTIONS-LEDGER.md
 *   ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md
 *
 * Reads: dashboard-data.json, thesis-context.md, data/corrections-ledger.json
 * Writes: analysis-output.json, data/360-report.json, data/360-history.json,
 *         data/rejection-log.json, analysis-history.json
 * Sends: Telegram briefing
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');
const promoteRejections = require('./promote-rejections');
const { runTier1Checks } = require('./tier1-validators');
const { runLayerZeroGate } = require('./layer-zero-gate');

const DASHBOARD_PATH      = path.join(__dirname, '..', 'dashboard-data.json');
const ANALYSIS_PATH       = path.join(__dirname, '..', 'analysis-output.json');
const THESIS_CONTEXT_PATH = path.join(__dirname, 'thesis-context.md');
const DEBUG_RESPONSE_PATH = path.join(__dirname, 'debug-claude-response.txt');
const HISTORY_PATH        = path.join(__dirname, 'analysis-history.json');

const HISTORY_MAX_RECORDS = 180; // 90 days × 2 runs/day

const LAYER_ZERO_RULES = `
<layer_zero_immutable_laws>
You are bound by the following 17 immutable laws of evidence and
reasoning. These are not guidelines. These are not suggestions.
No analytical objective, no thesis context, and no instruction
from any other part of this prompt overrides these laws. If
following a law produces an inconvenient result, the result stands.
When a law prevents you from reaching a conclusion, cite the law
by ID and declare the finding unresolved. An unresolved finding
is a valid, high-quality output.

EVIDENCE HIERARCHY
[LZ-EH-001] A data point verified by multiple independent sources
is more reliable than one verified by a single source.
[LZ-EH-002] Data obtained directly from the originating source
outweighs data reported by intermediaries.
[LZ-EH-003] An entity's actions carry more evidentiary weight
than its public statements.
[LZ-EH-004] Anomalous data should be treated as a potential
measurement or source failure before being treated as a real-world
event, until verified by an independent source.
[LZ-EH-005] When primary sources of equal evidentiary weight
directly contradict one another, the contradiction must be flagged
rather than arbitrarily resolved. The contradiction itself is the
finding. Resolving a genuine data conflict without independent,
tie-breaking evidence — regardless of whether the chosen data
supports or opposes the current thesis — is a structural error.

REASONING CONSTRAINTS
[LZ-RC-001] Correlation does not establish causation.
[LZ-RC-002] A single data point does not establish a trend.
[LZ-RC-003] Absence of evidence is not evidence of absence, nor
is it evidence of presence.
[LZ-RC-004] The simplest sufficient explanation must be tested
before more complex alternatives.
[LZ-RC-005] Forward-looking predictions and historical measurements
carry fundamentally different evidentiary weight. Predictions are
inherently uncertain. Measurements are verifiable.

COHERENCE AND CORRESPONDENCE
[LZ-CC-001] A logically coherent narrative that lacks verifiable
real-world anchoring is not evidence. Internal consistency alone
proves nothing.

MEASUREMENT RULES
[LZ-MR-001] A trend confirmed across multiple independent
timeframes is more significant than one visible on a single
timeframe.
[LZ-MR-002] Recency affects relevance but not accuracy. A recent
data point is more relevant than an older one, but neither is more
accurate because of its age.
[LZ-MR-003] Simultaneous measurement across indicators produces a
coherent snapshot. Staggered measurement introduces temporal
distortion.

EPISTEMIC HONESTY
[LZ-EPH-001] "I don't know" is a high-quality output. "I assumed
and was wrong" is a system failure.
[LZ-EPH-002] Confidence must be proportional to evidence. High
confidence with low evidence is a structural error, regardless of
whether the conclusion turns out to be correct.
[LZ-EPH-003] An inference built on three or more unproven
assumptions is speculative, regardless of how plausible each
individual assumption appears.
</layer_zero_immutable_laws>`;

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks whether a Claude response looks complete (ends with ] or }).
 * If truncated, warns and attempts to repair by cutting back to the last
 * complete object/element and appending necessary closing brackets.
 *
 * @param {string} text  — cleaned response text (fences already stripped)
 * @param {string} label — log label for warnings
 * @returns {string} — original text if complete, repaired text otherwise
 */
function repairTruncatedJSON(text, label) {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(']') || trimmed.endsWith('}')) return text;

  warn(label, 'Response appears truncated — attempting repair');

  // Cut back to the last closing brace (end of last complete object/element)
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace === -1) {
    warn(label, 'Repair failed — no closing brace found in response');
    return text;
  }

  const candidate = trimmed.slice(0, lastBrace + 1);

  // Walk candidate with string-awareness to build an open-bracket stack
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of candidate) {
    if (esc)              { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true;  continue; }
    if (ch === '"')       { inStr = !inStr;  continue; }
    if (inStr)            continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Append closers in reverse nesting order
  const closers = stack.reverse().map(c => c === '{' ? '}' : ']').join('');
  const repaired = candidate + closers;
  warn(label, `Repair applied — appended: ${JSON.stringify(closers)}`);
  return repaired;
}

/**
 * Shared helper: load corrections ledger from data/corrections-ledger.json.
 * Returns empty array if file doesn't exist or is malformed.
 * Used by Layer 2, Layer 3, and Layer 4.
 */
function loadCorrectionsLedger() {
  try {
    const ledgerPath = path.join(__dirname, '..', 'data', 'corrections-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (Array.isArray(data)) {
        log('ledger', `Corrections ledger loaded: ${data.length} active entries`);
        return data;
      }
    }
    log('ledger', 'Corrections ledger not found or empty — proceeding with empty ledger');
    return [];
  } catch (e) {
    err('ledger', `Corrections ledger read failed (non-fatal): ${e.message}`);
    return [];
  }
}

async function enforceCorrectionsReferenced(result, layerLabel, client, ledgerEntries) {
  if (Array.isArray(result.corrections_referenced)) {
    log(layerLabel, `corrections_referenced present: ${result.corrections_referenced.length} entries`);
    return;
  }

  const ledgerCount = Array.isArray(ledgerEntries) ? ledgerEntries.length : 0;
  warn(layerLabel, `corrections_referenced missing from output (ledger has ${ledgerCount} active entries)`);

  if (client) {
    try {
      log(layerLabel, 'Firing one-shot retry for corrections_referenced...');
      const retryResponse = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Your previous analysis output was missing the required corrections_referenced field. The corrections ledger had ${ledgerCount} active entries.\n\nReturn ONLY the following JSON object — nothing else:\n{\n  "corrections_referenced": [\n    {\n      "correction_id": "CL-XXX",\n      "trigger_matched": "what specific trigger condition matched",\n      "influence_on_assessment": "how it changed your assessment"\n    }\n  ],\n  "compliance_error_reason": "why this field was not included in your original output"\n}\n\nIf no corrections were relevant, return:\n{\n  "corrections_referenced": [],\n  "compliance_error_reason": "why this field was not included in your original output"\n}`
        }]
      });

      const retryRaw = retryResponse.content[0].text;
      const retryCleaned = retryRaw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const retryParsed = JSON.parse(retryCleaned);

      if (Array.isArray(retryParsed.corrections_referenced)) {
        result.corrections_referenced = retryParsed.corrections_referenced;
        result._corrections_compliance = 'RECOVERED_VIA_RETRY';
        result._compliance_error_reason = retryParsed.compliance_error_reason || 'No reason provided';
        log(layerLabel, `Retry succeeded: ${result.corrections_referenced.length} corrections referenced`);
        log(layerLabel, `Compliance error reason: ${result._compliance_error_reason}`);
        return;
      }

      warn(layerLabel, 'Retry returned invalid type for corrections_referenced — falling back');
      result.corrections_referenced = [];
      result._corrections_compliance = 'RETRY_INVALID_TYPE';
      result._compliance_error_reason = retryParsed.compliance_error_reason || 'No reason provided';
      return;

    } catch (retryErr) {
      warn(layerLabel, `Retry failed: ${retryErr.message} — falling back`);
      result.corrections_referenced = [];
      result._corrections_compliance = 'RETRY_FAILED';
      result._compliance_error_reason = `Retry error: ${retryErr.message}`;
      return;
    }
  }

  result.corrections_referenced = [];
  result._corrections_compliance = 'MISSING_NO_CLIENT';
  result._compliance_error_reason = 'No API client available for retry';
  warn(layerLabel, 'No API client — injected empty array with compliance flag');
}

/**
 * Shared helper: strip markdown fences and parse JSON from Claude response.
 * Applies truncation repair. Throws on parse failure.
 */
function parseClaudeJSON(rawText, label) {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const repaired = repairTruncatedJSON(cleaned, label);
  return JSON.parse(repaired);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

/**
 * Split a message into chunks of at most maxLen characters, breaking only on
 * newline boundaries so we never cut mid-word or mid-HTML-tag.
 */
function chunkMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const lines  = text.split('\n');
  let current  = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramChunk(token, chatId, text) {
  const url        = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 15_000);
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal:  controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram API error: ${json.description}`);
    return true;
  } catch (e) {
    err('Telegram', e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    warn('Telegram', 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping notification');
    return false;
  }

  const chunks = chunkMessage(text, 4000);
  if (chunks.length > 1) {
    log('Telegram', `Message is ${text.length} chars — splitting into ${chunks.length} chunks`);
  }

  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    // Append chunk indicator when sending multiple messages
    const body = chunks.length > 1
      ? `${chunks[i]}\n\n<i>(${i + 1}/${chunks.length})</i>`
      : chunks[i];
    const ok = await sendTelegramChunk(token, chatId, body);
    if (ok) {
      log('Telegram', chunks.length > 1 ? `Chunk ${i + 1}/${chunks.length} sent` : 'Message sent');
    } else {
      allOk = false;
    }
    // Brief pause between chunks to respect Telegram rate limits
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  return allOk;
}

// ─── Format analysis as Telegram message ──────────────────────────────────────

function formatTelegramMessage(analysis, dashboardData) {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const runLabel = analysis.run_type === 'morning' ? 'Morning' : 'Evening';

  const xrp   = dashboardData?.xrp;
  const macro  = dashboardData?.macro;
  const etf    = dashboardData?.etf;

  const price   = xrp?.price != null   ? `$${xrp.price.toFixed(4)}` : '--';
  const chg     = xrp?.change_24h != null ? `${xrp.change_24h >= 0 ? '+' : ''}${xrp.change_24h.toFixed(2)}%` : '--';
  const fgi     = macro?.fear_greed?.value ?? '--';
  const usdJpy  = macro?.usd_jpy?.value != null ? `¥${macro.usd_jpy.value.toFixed(2)}` : '--';
  const dxy     = macro?.dxy?.value != null ? macro.dxy.value.toFixed(2) : '--';
  const sp500   = macro?.sp500?.value != null ? macro.sp500.value.toFixed(2) : '--';

  // ETF flow summary
  let etfLine = '--';
  if (etf?.daily_net_inflow != null) {
    const m = etf.daily_net_inflow / 1e6;
    etfLine = `${m >= 0 ? '+' : ''}$${Math.abs(m).toFixed(2)}M daily`;
  } else if (etf?.weekly_net_inflow != null) {
    const m = etf.weekly_net_inflow / 1e6;
    etfLine = `${m >= 0 ? '+' : ''}$${Math.abs(m).toFixed(2)}M/wk`;
  }

  // Alerts
  const alertLines = (analysis.alerts ?? []).map(a => {
    const icon = a.severity === 'CRITICAL' ? '🚨' : a.severity === 'WARNING' ? '⚠️' : 'ℹ️';
    return `${icon} ${a.message}`;
  }).join('\n') || 'None';

  // Kill switch changes
  const ksChanges = (analysis.kill_switch_updates ?? [])
    .filter(k => k.recommended_status !== k.previous_status)
    .map(k => `• ${k.name}: ${k.previous_status} → ${k.recommended_status}`)
    .join('\n') || 'None';

  // Scorecard changes
  const scChanges = (analysis.scorecard_updates ?? [])
    .filter(s => s.recommended_status !== s.previous_status)
    .map(s => `• ${s.category}: ${s.previous_status} → ${s.recommended_status}`)
    .join('\n') || 'None';

  // Probability
  const prob = analysis.recommended_probability_adjustment;
  const probLine = prob
    ? `Bear ${prob.bear}% | Base ${prob.base}% | Mid ${prob.mid}% | Bull ${prob.bull}%`
    : '(no change recommended)';

  // Bear case
  const bearScore = analysis.bear_case?.counter_thesis_score ?? '--';
  const bearNarrative = analysis.bear_case?.bear_narrative ?? '';
  const bearOneLiner = bearNarrative.split(/\.\s+/)[0].replace(/\.$/, '');

  const stressScore = analysis.stress_assessment;

  // Events draft
  const eventsDraft = analysis.events_draft ?? [];
  const eventsSection = eventsDraft.length > 0
    ? `\n📰 <b>THESIS-RELEVANT NEWS: ${eventsDraft.length}</b>\n` +
      eventsDraft.map(e => `• [${e.category}] [${e.severity}] — ${e.title}`).join('\n') +
      `\n\n📋 <b>EVENTS DRAFT:</b>\n` +
      eventsDraft.map(e =>
        `<b>${e.date} · ${e.category} · ${e.severity}</b>\n${e.title}\n<i>${e.expanded}</i>`
      ).join('\n\n')
    : '\n📰 <b>THESIS-RELEVANT NEWS:</b> None flagged';

  return `🔭 <b>OVERWATCH ANALYSIS — ${runLabel} ${dateStr}</b>

📊 <b>MARKET:</b> XRP ${price} (${chg}) | F&amp;G: ${fgi} | USD/JPY: ${usdJpy}
📊 <b>INDICES:</b> DXY ${dxy} | S&amp;P 500 ${sp500}
📈 <b>ETF FLOW:</b> ${etfLine}

📝 <b>THESIS PULSE:</b>
${analysis.thesis_pulse ?? '(not available)'}

⚡ <b>STRESS:</b> ${stressScore?.level ?? '--'} (${stressScore?.score ?? '--'}/100)
${stressScore?.interpretation ?? ''}

📈 <b>ETF:</b> ${analysis.etf_analysis ?? '--'}

🌍 <b>MACRO:</b> ${analysis.macro_analysis ?? '--'}

⚠️ <b>ALERTS:</b>
${alertLines}

🎯 <b>KILL SWITCH CHANGES:</b> ${(analysis.kill_switch_updates ?? []).filter(k => k.recommended_status !== k.previous_status).length}
${ksChanges}

📊 <b>SCORECARD CHANGES:</b> ${(analysis.scorecard_updates ?? []).filter(s => s.recommended_status !== s.previous_status).length}
${scChanges}

🎲 <b>PROBABILITY:</b>
${probLine}
🐻 <b>COUNTER-THESIS:</b> ${bearScore}/100
${bearOneLiner || '(no bear narrative)'}
${eventsSection}

<i>To apply: trigger "Apply Approved Analysis" workflow in GitHub Actions.</i>`;
}

// ─── Claude system prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Overwatch Terminal autonomous analyst. Your job is to analyze live market data against a specific XRP institutional adoption thesis framework.

You will receive:
1. Current dashboard data (prices, macro indicators, ETF flows, XRPL metrics)
2. The thesis framework (kill switches, probability model, institutional evidence)

Your output must be a JSON object with these fields:

{
  "timestamp": "ISO timestamp",
  "run_type": "morning" or "evening",

  "market_summary": "2-3 sentence summary of current market conditions",

  "thesis_pulse": "3-5 sentence updated thesis assessment. Be specific about what changed since last analysis. Reference actual numbers.",

  "stress_assessment": {
    "level": "LOW" | "MODERATE" | "ELEVATED" | "HIGH" | "CRITICAL",
    "score": 1-100,
    "interpretation": "2-3 sentences explaining the stress environment"
  },

  "kill_switch_updates": [
    {
      "name": "kill switch name",
      "previous_status": "status from thesis context",
      "recommended_status": "your recommended new status",
      "reasoning": "why"
    }
  ],

  "scorecard_updates": [
    {
      "category": "category name",
      "previous_status": "old status",
      "recommended_status": "new status",
      "reasoning": "why"
    }
  ],

  "alerts": [
    {
      "severity": "INFO" | "WARNING" | "CRITICAL",
      "message": "what happened or what to watch"
    }
  ],

  "etf_analysis": "1-2 sentences on ETF flow trends and what they signal",

  "macro_analysis": "1-2 sentences on macro environment (yen, yields, oil, DXY, S&P 500, tariffs)",

  "recommended_probability_adjustment": {
    "bear": 8,
    "base": 55,
    "mid": 25,
    "bull": 12,
    "reasoning": "only include if recommending a change, explain why"
  },

  "events_draft": [
    {
      "date": "Feb 20",
      "category": "INSTITUTIONAL",
      "severity": "ELEVATED",
      "title": "Concise event title",
      "expanded": "1-2 sentence detail on thesis relevance and context."
    }
  ],

  "geopolitical_watchlist": [
    {
      "region": "Japan / BOJ",
      "status_text": "1 sentence current status with key signal"
    },
    {
      "region": "Middle East",
      "status_text": "1 sentence current status"
    },
    {
      "region": "US-China",
      "status_text": "1 sentence current status"
    },
    {
      "region": "Trade / Tariffs",
      "status_text": "1 sentence current status"
    },
    {
      "region": "Arctic / Russia",
      "status_text": "1 sentence current status"
    }
  ],

  "energy_interpretation": "2-3 sentences on energy market conditions and their impact on the Japan stress thesis (oil, JPY, trade deficit feedback loop).",

  "thesis_pulse_assessment": "3-4 sentences distilling the current thesis state for the dashboard assessment box. Terminal voice. Reference actual numbers. Be honest about risks.",

  "stress_interpretation": "2-3 sentences explaining the current composite stress environment for the dashboard stress card. Reference specific thresholds breached or held.",

  "bear_case": {
    "counter_thesis_score": 0,
    "score_reasoning": "1-2 sentence explanation of the score. What is driving the pressure level?",
    "competing_infrastructure": [
      {"name": "SWIFT GPI", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "Visa B2B Connect", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "JPMorgan Kinexys", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "BIS Project Nexus", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "Ethereum Institutional", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"}
    ],
    "odl_stagnation": "1 sentence assessment of ODL volume growth risk",
    "token_velocity_concern": "1 sentence assessment of token velocity / utility ratio risk",
    "macro_headwinds": [
      {"name": "Global Recession Risk", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "Crypto Winter Signals", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "Regulatory Reversal Risk", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"},
      {"name": "Rate Hike Extension", "status": "LOW_RISK | MONITORING | ELEVATED_RISK", "status_text": "1 sentence current assessment"}
    ],
    "bear_narrative": "2-3 sentences stating the strongest honest counter-arguments to the thesis right now. Do not soften findings."
  }
}

Rules:
- Be precise and data-driven. Reference specific numbers.
- Don't be promotional or bullish by default. Be honest.
- Flag deterioration as readily as improvement.
- If a kill switch should be tripped (thesis falsified on that dimension), say so clearly.
- If data is missing or stale, note it — don't fill gaps with assumptions.
- Keep all text fields concise. This feeds a dashboard, not a report.
- For events_draft: only include headlines that materially affect the thesis framework. Ignore routine price commentary, opinion pieces, and pure speculation. Flag if any headline suggests a kill switch status change.
- For geopolitical_watchlist: provide current, factual status for each region. Use terminal-style language — terse, specific. Flag active escalation.
- For energy_interpretation, thesis_pulse_assessment, stress_interpretation: terminal voice — precise, no fluff, signal-focused. These render directly in the dashboard.
- For bear_case: ACTIVELY SEEK DISCONFIRMING EVIDENCE. Do not soften bear case findings to protect the thesis. The counter_thesis_score should reflect genuine risk (0 = no credible threat to thesis, 100 = thesis clearly failing). Rate each competing infrastructure item honestly based on actual adoption data. The bear_narrative must represent the strongest honest case against the thesis — not a strawman.`;

// ─── Determine run type ───────────────────────────────────────────────────────

function getRunType() {
  // Chicago time (UTC-6 winter, UTC-5 summer)
  const now = new Date();
  const chicagoHour = (now.getUTCHours() - 6 + 24) % 24;
  return chicagoHour < 12 ? 'morning' : 'evening';
}

// ─── Layer 1: SWEEP ───────────────────────────────────────────────────────────

/**
 * Runs the 360 counter-thesis sweep (Layer 1 — SWEEP).
 * Widest intake, no filtering, no judgment.
 * Feeds all market data to Claude with no checklist — lets it find threats
 * on its own. Returns the array of threat objects, or [] on any failure.
 *
 * @param {object} marketData — current dashboard data (from dashboard-data.json)
 * @returns {Promise<Array>}
 */
async function runSweep(marketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('360-sweep', 'ANTHROPIC_API_KEY not set — cannot run sweep');
    return [];
  }

  const sweepPrompt = `You are a senior analyst performing the SWEEP step of a four-layer analytical monitoring system. Your job is perception — surface every material signal in the environment the thesis operates in.

Positive, negative, ambiguous, contradictory. Apply equal rigor in all directions. A positive signal requires the same standard of evidence as a negative one — specific developments, named entities, verifiable actions. No direction is preferred.

You are not evaluating these signals. You are not determining their impact on the thesis. You are identifying what is happening in the environment. Later layers will contextualize, reason about, and judge what you find.

THESIS:
XRP/XRPL is positioned to become primary institutional settlement infrastructure for cross-border payments. Convergent catalysts include: Ripple institutional partnerships (BIS, IMF, central banks), RLUSD stablecoin growth toward $5B circulation, ODL volume expansion, Permissioned Domains enabling compliant institutional access, XRP ETF approval and sustained inflows, and Japanese institutional adoption via SBI Holdings.

CURRENT DATA:
${JSON.stringify(marketData)}

FALSIFICATION CRITERIA (existing kill switches):
- ODL Volume: Must show growth trajectory toward institutional-grade volume by Q3 2026
- RLUSD Circulation: Tracking toward $5B target
- PermissionedDEX: Institutional count must be verifiable
- XRP ETF: Sustained outflows beyond 30 days triggers review
- Fear & Greed: Extended period below 20 signals structural risk

SIGNAL CATEGORIES:
Every signal must be classified into one of these universal categories:
- regulatory: Legal, regulatory, or compliance environment changes
- competitive: Alternative approaches, competing solutions, rival actors
- macro: Systemic forces beyond the thesis scope
- structure: How the operating environment is organized — access, flow, infrastructure, participant dynamics
- technology: Technical capabilities, infrastructure changes, protocol developments
- integration: Usage patterns, deployment evidence, participant behavior, implementation signals
- geopolitical: Cross-border power dynamics, international relations, jurisdictional conflicts
- assumption_decay: Core assumptions that haven't been re-verified
- narrative: Perception shifts, framing changes, public sentiment
- agent_capacity: Health, runway, leadership, and execution capability of the thesis actor itself

INSTRUCTIONS:

1. Search across all ten categories. Do not concentrate on any single category. A sweep that returns signals from only 3 categories has blind spots in the other 7.

2. For each signal, observe its apparent direction:
   - ACCELERATION: movement suggesting expansion, growth, or advancement in this area
   - DETERIORATION: movement suggesting contraction, decline, or weakening in this area
   - AMBIGUOUS: movement detected but direction cannot be determined from available data
   - CONTRADICTORY: simultaneous movement in opposing directions within the same signal

3. Be specific. Name entities, cite developments, reference timelines. Vague signals are low-value signals.

4. Think laterally. The most important signals are often the ones not already being tracked.

5. Do not self-censor signals in any direction. A material positive development requires the same reporting discipline as a material negative development.

GRADUATED LESSONS (promoted from corrections ledger — operational experience):
These principles were identified through repeated errors in production runs and promoted from the Overledger into standing perceptual instructions. They represent patterns the system got wrong multiple times before the lesson was formalized.

6. Personal social media content from individuals relevant to the thesis is not a business signal unless it contains verifiable thesis-relevant content. Personal posts, lifestyle content, and non-business commentary do not qualify as signals regardless of the individual's organizational role. [Graduated from CL-030]

7. Retail sentiment indices measure public mood, not institutional behavior. Do not treat sentiment index movements as signals of institutional activity without independent flow evidence. [Graduated from CL-031]

Respond with ONLY a JSON array. Each element:
{
  "threat": "Short name",
  "description": "What specifically is happening and why it matters",
  "direction": "ACCELERATION | DETERIORATION | AMBIGUOUS | CONTRADICTORY",
  "severity": "critical | high | moderate | low",
  "proximity": "immediate | near-term | medium-term | long-term",
  "confidence": "high | medium | low",
  "evidence": "What specific data or development supports this",
  "blind_spot": true/false,
  "category": "regulatory | competitive | macro | structure | technology | integration | geopolitical | assumption_decay | narrative | agent_capacity"
}

IMPORTANT: Keep each signal description under 100 words. Return a maximum of 15 signals. Ensure your response is valid, complete JSON with all brackets closed.`;

  const client = new Anthropic({ apiKey });

  let response;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      log('360-sweep', `Calling claude-opus-4-6… (attempt ${attempt + 1})`);
      response = await client.messages.create({
        model:      'claude-opus-4-6',
        max_tokens: 6000,
        messages:   [{ role: 'user', content: sweepPrompt }],
      });
      break;
    } catch (e) {
      if (attempt === 0) {
        warn('360-sweep', `Attempt 1 failed: ${e.message} — retrying in 5s`);
        await sleep(5_000);
      } else {
        err('360-sweep', `API call failed after retry: ${e.message}`);
        return [];
      }
    }
  }

  const raw = response.content[0].text;
  log('360-sweep', `Response received (${raw.length} chars)`);

  try {
    const threats = parseClaudeJSON(raw, '360-sweep');
    if (!Array.isArray(threats)) {
      err('360-sweep', 'Response is not a JSON array — returning empty');
      return [];
    }
    log('360-sweep', `Sweep complete — ${threats.length} threats found`);
    return threats;
  } catch (parseErr) {
    err('360-sweep', `JSON parse failed: ${parseErr.message}`);
    return [];
  }
}

// ─── Layer 2: CONTEXTUALIZE ───────────────────────────────────────────────────

/**
 * Layer 2: CONTEXTUALIZE — Knowledge Audit + Contextual Scoring.
 * Receives Layer 1 sweep results, verifies understanding BEFORE scoring.
 * Two phases: (1) Knowledge Audit, (2) Contextual Scoring.
 *
 * Design rationale: ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md
 * Prompt source: LAYER-2-3-4-PROMPTS-DRAFT.md
 *
 * @param {Array}  sweepResults  — threat array returned by runSweep()
 * @param {object} marketData    — current dashboard data
 * @param {number} previousScore — previous bear pressure score (0-100)
 * @param {string} thesisContext  — contents of thesis-context.md
 * @returns {Promise<object|null>}
 */
async function runContextualize(sweepResults, marketData, previousScore, thesisContext) {
  log('analysis', '=== LAYER 2: CONTEXTUALIZE ===');
  log('analysis', `Processing ${sweepResults.length} threats from Layer 1 SWEEP`);

  const correctionsLedger = loadCorrectionsLedger();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('analysis', 'ANTHROPIC_API_KEY not set — Layer 2 cannot run');
    return null;
  }
  const client = new Anthropic({ apiKey });

  // Compute RLUSD pace for thesis context enrichment
  const rlusdCurrent = marketData?.rlusd?.market_cap || 0;
  const rlusdTarget = 5_000_000_000;
  const now = new Date();
  const eoy2026 = new Date('2026-12-31');
  const daysRemaining = Math.max(1, Math.ceil((eoy2026 - now) / 86400000));
  const rlusdPaceNeeded = rlusdCurrent > 0
    ? `${((rlusdTarget - rlusdCurrent) / daysRemaining / 1e6).toFixed(2)}M/day`
    : 'unknown';

  const prompt = `${LAYER_ZERO_RULES}

You are a senior analyst performing the CONTEXTUALIZE step of a four-layer investment thesis monitoring system. You receive raw observations from Layer 1 (SWEEP) and your job is to produce contextually scored signals — but ONLY after verifying that your understanding is sufficient to score them accurately.

Do NOT react to headlines. Do NOT score on surface appearance. Before you evaluate any signal, ask yourself: "Do I actually understand the thesis well enough to assess this?"

LAYER 1 OBSERVATIONS:
${JSON.stringify(sweepResults)}

CURRENT MARKET DATA:
${JSON.stringify(marketData)}

THESIS CONTEXT:
${thesisContext}

RLUSD PACE NEEDED TO HIT $5B TARGET: ${rlusdPaceNeeded} (${daysRemaining} days remaining to EOY 2026)

PREVIOUS BEAR PRESSURE SCORE: ${previousScore}

CORRECTIONS LEDGER (active lessons from past errors):
${JSON.stringify(correctionsLedger)}

=== PHASE 1: KNOWLEDGE AUDIT ===

For each significant signal from Layer 1, perform the following check BEFORE scoring:

1. THESIS KNOWLEDGE CHECK
   - "What do I know about the thesis asset's capabilities relevant to this signal?"
   - "Is my understanding current, or could conditions have changed since this knowledge was established?"
   - "Am I about to score this signal based on an assumption I haven't verified?"

   If you identify a gap: flag the signal as REQUIRES_DEEPER_CONTEXT and document:
   - What you don't know
   - What you would need to know to score accurately
   - Where that knowledge might be found

   This is a knowledge acquisition request, not an intelligence acquisition request. You are asking "do I understand the thesis?" not "what are the players doing?" (that's Layer 3's job)

2. CORRECTIONS LEDGER CHECK
   - "Do I have any stored corrections related to this type of signal?"
   - If a matching trigger is found, apply the stored lesson to inform this assessment
   - If a lesson prevents a repeat error, flag it: "LESSON_APPLIED": "CL-XXX"
   - Do NOT skip this step. The ledger exists because the system made this exact type of mistake before.
   - You MUST populate the corrections_referenced field in your output. List every correction entry you consulted, what trigger matched, and how it influenced your assessment. If no corrections matched, return an empty array. This field is required.

3. COMPOUND STRESS CHECK
   - Stress indicators are NOT independent. They compound.
   - When evaluating any macro stress signal, check ALL THREE legs of the compound stress matrix simultaneously:
     * USD/JPY (current value, trajectory)
     * JGB 10Y yield (current value, trajectory)
     * Brent Crude (current value, trajectory)
   - Assess compound stress level:
     * MONITORING: Any one indicator in elevated range
     * ELEVATED: Any two of (Brent >$85, JGB 10Y >2.3%, USD/JPY >157) simultaneously
     * CRITICAL: Any two of (Brent >$95, JGB 10Y >2.5%, USD/JPY >160) OR any Hormuz disruption event
     * EMERGENCY: Hormuz closure + forced BOJ intervention + JGB 10Y >2.5%
   - The break point of a pre-loaded structure is LOWER than the break point of an unloaded structure. If one leg is already elevated, less force is needed from the other two to reach critical. State this explicitly.
   - Velocity and trajectory matter as much as current level. A fast move toward a threshold is more dangerous than sitting at it.

4. KNOWLEDGE GAP IDENTIFICATION
   Honestly identify what you DON'T know. This is high-value output. Admitting "I don't know X and it matters for this assessment" is MORE valuable than guessing.

   "I DON'T KNOW" IS A HIGH-QUALITY OUTPUT.
   "I ASSUMED AND WAS WRONG" IS A SYSTEM FAILURE.

   Types of gaps:
   - THESIS_CAPABILITY_GAP: "I don't know if the thesis asset can handle this specific technical challenge"
   - THRESHOLD_CALIBRATION_GAP: "This threshold was set under different conditions and may need recalibration"
   - DATA_AVAILABILITY_GAP: "I need data that isn't in my current inputs to score this accurately"
   - COMPETITIVE_KNOWLEDGE_GAP: "I don't understand the competing infrastructure well enough to assess this threat"

=== PHASE 2: CONTEXTUAL SCORING ===

Now — and ONLY now — score the signals. You have verified your understanding, applied corrections from past mistakes, checked compound stress levels, and identified what you don't know.

For each signal from Layer 1:

1. SEVERITY SCORE (1-10)
   - Score based on VERIFIED understanding, not surface appearance
   - If a knowledge audit changed your assessment, document what the score WOULD have been vs what it IS after the audit
   - Weight by source tier:
     * Tier 1 (core thesis sources): full weight
     * Tier 2 (domain monitors): 0.7x weight
     * Tier 3 (keyword catches): 0.4x weight unless corroborated

2. THESIS RELEVANCE
   - DIRECT: Threat directly impacts a kill switch or falsification criterion
   - INDIRECT: Threat impacts thesis through secondary effects (e.g., macro stress → settlement demand)
   - CONTEXTUAL: Threat provides background but doesn't directly affect thesis scoring

3. CONFIDENCE TAG
   - HIGH: Scored on verified knowledge with current data
   - MEDIUM: Scored on reasonable understanding but some gaps remain
   - LOW: Scored with known knowledge gaps — Layer 3 should treat with caution
   - REQUIRES_DEEPER_CONTEXT: Cannot score meaningfully without additional knowledge — passed to Layer 3 as an open question, not a scored signal

4. KILL SWITCH STATUS CHECK
   For each of the 10 falsification criteria, report current status based on available data. Flag any that have moved since last assessment. Flag any where data is unavailable (this is distinct from data showing negative results).

5. COMPOUND STRESS ASSESSMENT
   Report the current compound stress level with:
   - Current values of all three legs
   - Which legs are elevated/critical
   - Trajectory (improving, stable, deteriorating)
   - Whether the structure is pre-loaded (one or more legs already elevated, reducing the force needed from others)

CRITICAL OUTPUT REQUIREMENT:
Your JSON output MUST include the "corrections_referenced" array. This is not optional.
- If you applied corrections from the ledger, list each one with correction_id, trigger_matched, and influence_on_assessment.
- If no corrections were relevant, return an empty array: "corrections_referenced": []
- Omitting this field is a structural compliance failure.

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON:
{
  "corrections_referenced": [
    {
      "correction_id": "CL-XXX",
      "trigger_matched": "what specific trigger condition matched this analysis",
      "influence_on_assessment": "how the stored lesson changed this assessment"
    }
  ],
  "knowledge_audit": [
    {
      "threat": "name from Layer 1",
      "knowledge_check": "what I verified before scoring",
      "gap_identified": "description of gap, or NONE",
      "gap_type": "THESIS_CAPABILITY_GAP | THRESHOLD_CALIBRATION_GAP | DATA_AVAILABILITY_GAP | COMPETITIVE_KNOWLEDGE_GAP | NONE",
      "pre_audit_assessment": "what I would have scored without the audit",
      "post_audit_assessment": "what I scored after verifying",
      "audit_impact": "how the knowledge check changed the assessment",
      "lesson_applied": "CL-XXX or NONE",
      "status": "SCORED | REQUIRES_DEEPER_CONTEXT"
    }
  ],
  "scored_threats": [
    {
      "threat": "name",
      "severity": 0,
      "source_tier": "1 | 2 | 3",
      "weighted_severity": 0,
      "thesis_relevance": "DIRECT | INDIRECT | CONTEXTUAL",
      "confidence": "HIGH | MEDIUM | LOW",
      "reasoning": "...",
      "knowledge_verified": true
    }
  ],
  "unscored_threats": [
    {
      "threat": "name",
      "reason": "description of why it cannot be scored",
      "knowledge_needed": "what would be needed to score this",
      "acquisition_type": "KNOWLEDGE | INTELLIGENCE"
    }
  ],
  "kill_switch_status": [
    {
      "criterion": "name",
      "status": "TRACKING | NEEDS_DATA | MONITORING | PENDING | WARNING | TRIGGERED",
      "current_value": "...",
      "target": "...",
      "movement_since_last": "improved | stable | deteriorated | unknown"
    }
  ],
  "compound_stress": {
    "level": "MONITORING | ELEVATED | CRITICAL | EMERGENCY",
    "usd_jpy": { "current": 0, "threshold_status": "normal | elevated | critical", "trajectory": "improving | stable | deteriorating" },
    "jgb_10y": { "current": 0, "threshold_status": "normal | elevated | critical", "trajectory": "improving | stable | deteriorating" },
    "brent": { "current": 0, "threshold_status": "normal | elevated | critical", "trajectory": "improving | stable | deteriorating" },
    "pre_loaded": false,
    "pre_loaded_detail": "which legs are already elevated and why this matters",
    "stress_chain_proximity": "how close current conditions are to the violent unwind scenario"
  },
  "bear_pressure": 0,
  "bear_pressure_reasoning": "...",
  "layer2_summary": "2-3 sentences. What does Layer 3 need to know? What was verified, what remains uncertain, what is the compound stress state?"
}`;

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log('analysis', `Layer 2 API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 12000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      result = parseClaudeJSON(raw, 'layer2');
      log('analysis', `Layer 2 complete: ${result.scored_threats?.length || 0} scored, ${result.unscored_threats?.length || 0} unscored, bear pressure: ${result.bear_pressure}`);
      await enforceCorrectionsReferenced(result, 'layer2', client, correctionsLedger);
      break;
    } catch (e) {
      err('analysis', `Layer 2 attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        err('analysis', 'Layer 2 FAILED after 2 attempts');
        await sendTelegram('🚨 OVERWATCH: Layer 2 CONTEXTUALIZE failed after 2 attempts. Pipeline degraded.');
        return null;
      }
      await sleep(5000);
    }
  }

  return result;
}

// ─── Layer 3: INFER ───────────────────────────────────────────────────────────

/**
 * Layer 3: INFER — Strategic Game Theory with Circuit Breakers.
 * Receives Layer 2's knowledge-verified, contextually scored threats.
 * Explains WHY we're seeing this pattern using player behavior analysis,
 * feedback loop mapping, and strategic inference with circuit breakers.
 *
 * Circuit breakers built into prompt:
 *   1. Null Hypothesis Mandate — must test "nothing is happening" first
 *   2. Assumption Count — 3+ assumptions = SPECULATIVE, auto-discarded
 *   3. Evidence-to-Inference Ratio — must cite 2+ independent verifiable sources
 *
 * Design docs: OVERWATCH-CIRCUIT-BREAKERS.md, LAYER-2-3-4-PROMPTS-DRAFT.md
 *
 * @param {object} contextualizeResult — Layer 2 output
 * @param {object} marketData          — current dashboard data
 * @param {string} thesisContext        — contents of thesis-context.md
 * @returns {Promise<object|null>}
 */
async function runInfer(contextualizeResult, marketData, thesisContext) {
  log('analysis', '=== LAYER 3: INFER ===');

  const correctionsLedger = loadCorrectionsLedger();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('analysis', 'ANTHROPIC_API_KEY not set — Layer 3 cannot run');
    return null;
  }
  const client = new Anthropic({ apiKey });

  // Layer 3 receives ONLY Layer 2 output + market data + thesis context.
  // It does NOT see Layer 1 raw sweep — compression funnel enforced.
  const prompt = `${LAYER_ZERO_RULES}

You are a strategic analyst applying game theory to explain the pattern of evidence in an investment thesis analysis. Layer 2 has scored signals, verified its own knowledge, identified gaps, and assessed compound stress levels. Your job is to provide the strategic reasoning that explains WHY we're seeing this pattern.

Do not judge whether the thesis is right or wrong. For each key finding, ask: given what each player WANTS and what they're DOING, what is the most rational explanation?

Focus on BEHAVIOR over statements. ACTIONS over words. RESOURCE COMMITMENTS over announcements. What players are NOT doing is as important as what they ARE doing.

LAYER 2 ASSESSMENT:
${JSON.stringify(contextualizeResult)}

CURRENT MARKET DATA:
${JSON.stringify(marketData)}

THESIS CONTEXT:
${thesisContext}

CORRECTIONS LEDGER (active lessons):
${JSON.stringify(correctionsLedger)}

=== CIRCUIT BREAKERS — READ BEFORE REASONING ===

CRITICAL CONSTRAINT — NULL HYPOTHESIS:
Before generating any strategic inference, you MUST first test the null hypothesis: the possibility that nothing strategic is happening and the data simply is what it is.

For every inference you generate, ask:
"Is the simplest explanation that this is just a data gap, market noise, or normal business behavior?"

If YES — classify as NULL_HYPOTHESIS_HOLDS.
Finding nothing strategic IS a valid, high-quality output.
You are being evaluated on ACCURACY, not creativity.

ASSUMPTION COUNT REQUIREMENT:
For every strategic inference, list each unproven assumption required for the inference to be true.

Scoring rules:
- 0-1 assumptions: VALID inference, full weight
- 2 assumptions: FLAGGED, passed with caution note
- 3+ assumptions: SPECULATIVE, automatically discarded from scoring. Logged for Sunday audit only.

If you cannot make a connection with 2 or fewer unproven assumptions, the connection does not exist. Return INSUFFICIENT_EVIDENCE and move on.

ASSUMPTION COUNTING DISCIPLINE:
Each discrete unproven claim is one assumption. Do not bundle.
- "Entity X is acting rationally AND their motive is Y" is TWO assumptions, not one.
- "Established economic theory applies in this specific current context" is ONE assumption. A well-documented historical relationship does not become a fact about what is happening right now. Count it.
- "Action A will cause Effect B through Mechanism C" contains assumptions about the mechanism operating AND the effect materializing. Count each independently.
- If you are unsure whether something is one assumption or two, count it as two. Undercounting is a structural error. Overcounting is conservative and safe.

EVIDENCE REQUIREMENT:
Every inference MUST be grounded in at least two independent, verifiable pieces of evidence from Layer 2 or from known public information.

"I think this might be happening" is NOT an inference.
"These two verified facts together suggest X" IS an inference.

Verifiable evidence:
- On-chain data, SEC/regulatory filings, official announcements with dates, published financial data, confirmed partnerships, observable product launches, central bank statements/actions

NOT verifiable evidence:
- "Industry sources say...", "It's widely believed...", "Historically, companies tend to...", pattern matching from other industries without direct link

CORRECTIONS LEDGER CHECK:
- "Have my previous inferences in this domain been reliable?"
- If the ledger shows a pattern of assumption failures in a specific area, INCREASE your evidence threshold for that inference type
- Self-calibrate based on your own track record
   - You MUST populate the corrections_referenced field in your output. List every correction entry you consulted, what trigger matched, and how it influenced your assessment. If no corrections matched, return an empty array. This field is required.

=== ANALYSIS INSTRUCTIONS ===

A) PLAYER BEHAVIORAL ANALYSIS

For each key player, analyze the gap between what they SAY and what they DO:

1. RIPPLE — Actions: resource commitments, hiring, product launches. Key question: Why stop publishing ODL data?
2. BIS / PROJECT NEXUS / mBRIDGE — Actions: pilot programs, central bank enrollment. Key question: Replace bridge currencies or coexist?
3. SWIFT — Actions: Go-Live timeline, messaging upgrades. Key question: Upgrade sufficient to eliminate alternatives?
4. JAPANESE INSTITUTIONS (SBI Holdings, BOJ) — Actions: SBI XRPL integration, BOJ policy moves. Key question: XRPL adoption from conviction or desperation?
5. INSTITUTIONAL ASSET MANAGERS (Franklin Templeton, etc) — Actions: ETF launches, custody, public statements. Key question: Would $1.5T managers launch without private data?
6. COMPETING INFRASTRUCTURE (Circle/USDC, bank networks) — Actions: CCTP v2, tokenized deposit rollouts. Key question: Parallel to XRPL or competing for same corridors?
7. CENTRAL BANKS / MACRO ACTORS (BOJ, Fed, ECB) — Actions: rate decisions, intervention signals, fiscal policy. Key question: How do their trapped positions create second-order effects for settlement infrastructure demand?

For each player: What resources are they committing? (money > words) What talent are they hiring? (reveals future plans) What partnerships are they forming? (reveals strategy) What are they NOT doing that they should be? (reveals doubt)

B) FEEDBACK LOOP ANALYSIS

Do NOT analyze signals individually. Map how forces compound through interconnected systems:
- When one stress indicator moves, what does it do to the others?
- Where are the feedback loops? (e.g., oil → yen → BOJ → JGB → carry trade → global liquidity)
- Where are the trapped positions? (actors who can't move without making things worse)
- Is the system currently in orderly stress (managed, gradual) or approaching disorderly stress (cascade, self-reinforcing)?
- What is the VELOCITY of change, not just the level?

Specifically assess the compound stress chain from Layer 2:
- How close are current conditions to triggering the chain?
- What specific catalyst would push orderly → disorderly?
- Is the structure pre-loaded (one leg already elevated)?

C) STRATEGIC INFERENCES

For each major finding from Layer 2, provide the most rational explanation given player incentives. Test the null hypothesis FIRST. If the simplest explanation is sufficient, say so and move on.

For every inference that passes the null hypothesis test, you MUST declare:
- expected_timeline: How long before this inference should produce observable evidence? Days, weeks, months, or quarters.
- materialization_signal: What specific, observable outcome would confirm this inference?

D) HIDDEN MOVES — What are players most likely doing that they're NOT talking about? Based on incentive analysis, what non-public actions would be rational?

E) SCENARIO PROBABILITIES — Based on behavioral evidence (not speculation): thesis CONFIRMED, MODIFIED, or FALSIFIED with probability, key evidence, and timeline.

F) x402 PAPER TRADES — Identify data gaps that, if filled, would most change the assessment. Document the reasoning. Do NOT attempt to acquire data.

CRITICAL OUTPUT REQUIREMENT:
Your JSON output MUST include the "corrections_referenced" array. This is not optional.
- If you applied corrections from the ledger, list each one with correction_id, trigger_matched, and influence_on_assessment.
- If no corrections were relevant, return an empty array: "corrections_referenced": []
- Omitting this field is a structural compliance failure.

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON:
{
  "corrections_referenced": [
    {
      "correction_id": "CL-XXX",
      "trigger_matched": "what specific trigger condition matched this analysis",
      "influence_on_assessment": "how the stored lesson changed this assessment"
    }
  ],
  "player_analysis": [
    {
      "player": "name",
      "stated_position": "what they say",
      "observed_actions": "what they're doing",
      "say_do_gap": "where words and actions diverge",
      "inferred_strategy": "most likely actual strategy",
      "confidence": "high | medium | low"
    }
  ],
  "feedback_loops": [
    {
      "loop": "description of the feedback mechanism",
      "components": ["indicator/player 1", "indicator/player 2"],
      "current_state": "dormant | active_orderly | active_accelerating | critical",
      "trigger_to_next_state": "what would push it to the next level",
      "thesis_implication": "what this means for settlement infrastructure demand"
    }
  ],
  "behavioral_patterns": [
    {
      "pattern": "description of cross-player pattern",
      "players_involved": ["player1", "player2"],
      "thesis_implication": "supports | challenges | neutral",
      "significance": "high | medium | low"
    }
  ],
  "strategic_inferences": [
    {
      "finding_from_layer2": "signal name",
      "null_hypothesis": "simplest non-strategic explanation",
      "null_holds": true,
      "rational_explanation": "most likely explanation if strategic",
      "alternative_explanation": "second most likely",
      "which_is_more_likely": "null | primary | alternative",
      "assumptions": ["list each unproven assumption"],
      "assumption_count": 0,
      "classification": "VALID | FLAGGED | SPECULATIVE | INSUFFICIENT_EVIDENCE | NULL_HYPOTHESIS_HOLDS",
      "evidence_citations": ["verifiable evidence 1", "verifiable evidence 2"],
      "expected_timeline": "days | weeks | months | quarters",
      "materialization_signal": "what specific observable outcome would confirm this inference",
      "reasoning": "...",
      "confidence": "high | medium | low"
    }
  ],
  "hidden_moves": [
    {
      "player": "name",
      "likely_action": "what they're probably doing privately",
      "incentive_basis": "why this would be rational",
      "evidence_hints": "observable signals that support this",
      "assumption_count": 0,
      "classification": "VALID | FLAGGED | SPECULATIVE",
      "expected_timeline": "days | weeks | months | quarters",
      "materialization_signal": "what would confirm this is happening",
      "confidence": "high | medium | low"
    }
  ],
  "scenario_probabilities": {
    "thesis_confirmed": { "probability": "X%", "key_evidence": "...", "timeline": "..." },
    "thesis_modified": { "probability": "X%", "modification": "what changes from original thesis", "key_evidence": "..." },
    "thesis_falsified": { "probability": "X%", "key_evidence": "...", "confirming_signal": "what we'd see next if this is true" }
  },
  "x402_paper_trades": [
    {
      "question": "what would you pay to know?",
      "data_source": "where it would come from",
      "impact_on_analysis": "how it would change the assessment",
      "confidence_data_exists": "high | medium | low",
      "estimated_value": "how much resolving this uncertainty is worth"
    }
  ],
  "compound_stress_inference": {
    "current_chain_state": "dormant | building | approaching_critical | critical",
    "orderly_vs_disorderly": "assessment of current stress mode",
    "catalyst_proximity": "what specific event could trigger cascade",
    "pre_load_assessment": "which legs are pre-loaded and what that means",
    "thesis_paradox": "the violent unwind is simultaneously highest-risk AND highest-thesis-validation — state this honestly"
  },
  "inference_summary": "2-3 sentences. What does player behavior reveal that the data alone does not? What should Layer 4 focus on when reconciling?"
}`;

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log('analysis', `Layer 3 API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 16000, // Layer 3 is the heaviest output — player analysis + inferences + feedback loops
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      result = parseClaudeJSON(raw, 'layer3');
      const inferCount = result.strategic_inferences?.length || 0;
      const validCount = (result.strategic_inferences || []).filter(i => i.classification === 'VALID').length;
      const specCount = (result.strategic_inferences || []).filter(i => i.classification === 'SPECULATIVE').length;
      log('analysis', `Layer 3 complete: ${inferCount} inferences (${validCount} VALID, ${specCount} SPECULATIVE), ${result.player_analysis?.length || 0} players analyzed`);
      await enforceCorrectionsReferenced(result, 'layer3', client, correctionsLedger);
      break;
    } catch (e) {
      err('analysis', `Layer 3 attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        err('analysis', 'Layer 3 FAILED after 2 attempts');
        await sendTelegram('🚨 OVERWATCH: Layer 3 INFER failed after 2 attempts. Pipeline degraded — Layer 4 will not run.');
        return null;
      }
      await sleep(5000);
    }
  }

  return result;
}

// ─── Layer 4: RECONCILE ───────────────────────────────────────────────────────

/**
 * Layer 4: RECONCILE — Final Judgment with Burden of Proof.
 * The commander. Does not re-analyze. DECIDES.
 *
 * Receives Layer 2 (scored data) AND Layer 3 (strategic reasoning).
 * Applies 3-step burden of proof to every Layer 3 inference.
 * Resolves contradictions. Classifies data gaps. Produces final assessment.
 * Writes rejected inferences to data/rejection-log.json.
 *
 * Design docs: LAYER-2-3-4-PROMPTS-DRAFT.md, OVERWATCH-CIRCUIT-BREAKERS.md
 *
 * @param {object} contextualizeResult — Layer 2 output
 * @param {object} inferenceResult     — Layer 3 output
 * @param {object} marketData          — current dashboard data
 * @param {string} thesisContext        — contents of thesis-context.md
 * @returns {Promise<object|null>}
 */
async function runReconcile(contextualizeResult, inferenceResult, marketData, thesisContext) {
  log('analysis', '=== LAYER 4: RECONCILE ===');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('analysis', 'ANTHROPIC_API_KEY not set — Layer 4 cannot run');
    return null;
  }
  const client = new Anthropic({ apiKey });

  // Layer 4 receives BOTH Layer 2 and Layer 3 output — it has the most complete picture.
  const prompt = `${LAYER_ZERO_RULES}

You are the final decision-maker in a four-layer investment thesis monitoring system. You have the most complete picture of any layer: scored data from Layer 2 AND strategic reasoning from Layer 3. Your job is not to add more analysis. Your job is to DECIDE what everything means and what to do about it.

You are the judge, not the detective. The detective (Layer 3) proposed theories. You decide which ones hold up. Where data and behavior tell different stories, you determine which deserves more weight. Where paradoxes exist, you name them honestly — you do not force false resolution.

LAYER 2 ASSESSMENT:
${JSON.stringify(contextualizeResult)}

LAYER 3 INFERENCES:
${JSON.stringify(inferenceResult)}

MARKET DATA:
${JSON.stringify(marketData)}

THESIS CONTEXT:
${thesisContext}

=== BURDEN OF PROOF — APPLY BEFORE ALL ELSE ===

For every inference Layer 3 produced, apply judicial skepticism:

STEP 1: Check classification tag.
- VALID (0-1 assumptions): Full weight. Proceed to Step 2.
- FLAGGED (2 assumptions): 50% weight. Caution note in output.
- SPECULATIVE (3+ assumptions): 75% weight DISCOUNT. It appears in the report as context but does NOT move the bear pressure score or influence the tactical recommendation.
- INSUFFICIENT_EVIDENCE: Strip entirely from scoring. Log it.
- NULL_HYPOTHESIS_HOLDS: Accept the null. Do not override with speculation. The simplest explanation was sufficient.

STEP 2: Check data support.
- Does hard data from Layer 2 support this inference?
  * YES with multiple data points → full weight (after Step 1)
  * PARTIALLY (one data point) → 50% weight (stacks with Step 1)
  * NO supporting data → Strip from bear pressure score entirely. Log for Sunday audit but do NOT let it influence the tactical recommendation.

STEP 3: Check for contradiction with verified data.
- Does this inference require believing something that contradicts verified data from Layer 2?
  * YES → Reject entirely. Log rejection with reasoning. This goes to rejection-log.json for the corrections ledger pipeline.

Layer 4 has FULL AUTHORITY to overrule Layer 3. The detective proposes. The judge decides.

=== INSTRUCTIONS ===

1. CONTRADICTION RESOLUTION — For each case where Layer 2 data and Layer 3 behavior tell different stories, resolve: data_wins | behavior_wins | paradox_held.

2. DATA CLASSIFICATION — For each null or missing data point, make the final call: TRUE_NEGATIVE | DATA_GAP | SUSPICIOUS_ABSENCE | STRATEGICALLY_EXPLAINED.

3. FINAL THREAT MATRIX — For each threat that passed through Layers 2 and 3: Layer 2 composite score, Layer 3 adjustment (after burden of proof), final composite score.

4. COMPOUND STRESS FINAL ASSESSMENT — Confirm or override Layer 2's level. State one observation that SUPPORTS and one that CHALLENGES your assessment. Report delta, velocity, pre-load status, cascade proximity.
   - If compound stress is CRITICAL or EMERGENCY: estimate the operator's action window — hours, days, or weeks.
   - State the thesis paradox if one exists: "A [event] simultaneously [risk] AND [validation] because [mechanism]."

5. KILL SWITCH REVIEW — Review all 10 falsification criteria. If any kill switch is TRIGGERED, state this FIRST. Everything else is secondary.

6. FINAL BEAR PRESSURE SCORE (0-100) — The definitive number. State how it moved from Layer 2's score and why.

7. TACTICAL RECOMMENDATION — One of: HOLD_POSITION | INCREASE_MONITORING | REDUCE_EXPOSURE | EXIT_SIGNAL. No ambiguity.

8. REJECTION LOG — If Layer 4 overruled any Layer 3 inference, document it with root cause and corrections ledger trigger.

9. FINAL REPORT — 3-4 sentences. The 6 AM briefing. Lead with what matters most. State the call. Name the paradox if it exists. Honest about what you don't know.

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON:
{
  "burden_of_proof_applied": [
    {
      "inference": "name from Layer 3",
      "layer3_classification": "VALID | FLAGGED | SPECULATIVE | INSUFFICIENT_EVIDENCE | NULL_HYPOTHESIS_HOLDS",
      "data_support": "full | partial | none",
      "contradicts_data": false,
      "final_weight": "full | reduced_50 | reduced_75 | stripped | rejected",
      "reasoning": "why this weight was assigned"
    }
  ],
  "contradictions_resolved": [
    {
      "data_says": "what Layer 2 data shows",
      "behavior_suggests": "what Layer 3 inferred",
      "resolution": "data_wins | behavior_wins | paradox_held",
      "confidence": "high | medium | low",
      "reasoning": "why this resolution",
      "score_impact": 0
    }
  ],
  "data_classifications": [
    {
      "data_point": "name",
      "layer2_classification": "what Layer 2 assumed",
      "layer3_context": "what game theory revealed",
      "layer3_inference_valid": "true | false | n/a",
      "final_classification": "TRUE_NEGATIVE | DATA_GAP | SUSPICIOUS_ABSENCE | STRATEGICALLY_EXPLAINED",
      "reasoning": "why this classification"
    }
  ],
  "final_threat_matrix": [
    {
      "threat": "name",
      "layer2_composite": 0,
      "layer3_adjustment": "description of behavioral evidence applied",
      "adjustment_direction": "up | down | unchanged",
      "final_composite": 0,
      "confidence": "high | medium | low"
    }
  ],
  "compound_stress_final": {
    "level": "MONITORING | ELEVATED | CRITICAL | EMERGENCY",
    "layer2_level": "what Layer 2 reported",
    "layer3_assessment": "orderly vs disorderly from Layer 3",
    "override": false,
    "override_reasoning": "why, if applicable",
    "self_challenge": "one observation supporting this level AND one challenging it",
    "pre_loaded": false,
    "pre_loaded_legs": [],
    "cascade_proximity": "distant | approaching | imminent",
    "delta_since_last": "stable | escalating | de-escalating",
    "cycles_at_current_level": 0,
    "velocity_note": "one sentence on rate of change",
    "operator_action_window": "hours | days | weeks | not_applicable",
    "thesis_paradox": "A [event] simultaneously [risk] AND [validation] because [mechanism]"
  },
  "kill_switch_review": [
    {
      "criterion": "name",
      "current_status": "from Layer 2",
      "layer3_context": "behavioral evidence if relevant",
      "final_status": "GREEN | MONITORING | WARNING | TRIGGERED",
      "action": "maintain | escalate | de-escalate",
      "reasoning": "why"
    }
  ],
  "rejection_log": [
    {
      "layer3_inference": "what Layer 3 believed",
      "rejection_reason": "why Layer 4 rejected it",
      "root_cause": "ASSUMPTION_FAILURE | APOPHENIA | INSUFFICIENT_EVIDENCE | CONTRADICTED_BY_DATA",
      "confidence_in_rejection": "high | medium",
      "corrections_ledger_action": "auto_commit | flag_for_review"
    }
  ],
  "final_bear_pressure": 0,
  "pressure_vs_layer2": 0,
  "pressure_reasoning": "1-2 sentences explaining the final number",
  "tactical_recommendation": "HOLD_POSITION | INCREASE_MONITORING | REDUCE_EXPOSURE | EXIT_SIGNAL",
  "recommendation_reasoning": "2-3 sentences. What drives the call.",
  "monitoring_triggers": [],
  "overall_confidence": "high | medium | low",
  "biggest_uncertainty": "the single thing that most affects confidence",
  "what_would_change_assessment": "what new data or event would move the recommendation",
  "final_report": "3-4 sentences. The 6 AM briefing. Lead with what matters most. State the call. Name the paradox if it exists. Honest about what you don't know."
}`;

  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log('analysis', `Layer 4 API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 16000, // Layer 4 receives both L2 and L3, produces comprehensive output
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      result = parseClaudeJSON(raw, 'layer4');
      log('analysis', `Layer 4 complete: bear pressure ${result.final_bear_pressure}, recommendation: ${result.tactical_recommendation}, rejections: ${result.rejection_log?.length || 0}`);
      break;
    } catch (e) {
      err('analysis', `Layer 4 attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        err('analysis', 'Layer 4 FAILED after 2 attempts');
        await sendTelegram('🚨 OVERWATCH: Layer 4 RECONCILE failed after 2 attempts. Using Layer 2 output as fallback.');
        return null;
      }
      await sleep(5000);
    }
  }

  // Write rejection log entries to data/rejection-log.json
  // These feed the corrections ledger pipeline.
  if (result.rejection_log && result.rejection_log.length > 0) {
    try {
      const rejLogPath = path.join(__dirname, '..', 'data', 'rejection-log.json');
      let existing = [];
      if (fs.existsSync(rejLogPath)) {
        existing = JSON.parse(fs.readFileSync(rejLogPath, 'utf8'));
      }
      const newEntries = result.rejection_log.map(r => {
        r.corrections_ledger_action = r.confidence_in_rejection === 'high' ? 'auto_commit' : 'flag_for_review';
        return {
          ...r,
          timestamp: new Date().toISOString(),
          source: 'layer4_reconcile'
        };
      });
      existing.push(...newEntries);
      fs.writeFileSync(rejLogPath, JSON.stringify(existing, null, 2));
      log('analysis', `Rejection log updated: ${newEntries.length} new entries`);
    } catch (e) {
      err('analysis', `Rejection log write failed (non-fatal): ${e.message}`);
    }
  }

  // Promote auto_commit rejections to corrections ledger
  try {
    const promoted = promoteRejections();
    if (promoted > 0) log('analysis', `Corrections ledger: ${promoted} new entries from rejection log`);
  } catch (e) {
    err('analysis', `Corrections ledger promotion failed (non-fatal): ${e.message}`);
  }

  return result;
}

// ─── Compatibility Bridge ─────────────────────────────────────────────────────

/**
 * Transforms Layer 4 RECONCILE output into the old 360-report.json schema
 * that the dashboard (index.html render360Report) expects.
 *
 * This bridge exists so the four-layer pipeline can be verified end-to-end
 * without modifying index.html. Once the pipeline is proven, the dashboard
 * will be updated to read the native Layer 4 schema directly.
 *
 * IMPORTANT: Does not invent data. Fields without natural mappings are set
 * to null — the dashboard uses ?? '—' defaults for missing values.
 *
 * @param {object} reconcileResult    — Layer 4 output
 * @param {object} contextualizeResult — Layer 2 output (for enrichment)
 * @param {object} inferenceResult     — Layer 3 output (for enrichment)
 * @param {number} previousScore       — previous bear pressure score for delta
 * @returns {object} — old-format 360 report object
 */
function buildDashboardCompatible(reconcileResult, contextualizeResult, inferenceResult, previousScore) {
  log('bridge', 'Building dashboard-compatible 360 report from Layer 4 output');

  // 1. threat_matrix[] — reshape from Layer 4's final_threat_matrix[]
  // Old format expects: threat, description, impact, probability, time_weight, composite,
  //   severity, proximity, blind_spot, is_new, category
  // Layer 4 produces: threat, layer2_composite, layer3_adjustment, adjustment_direction,
  //   final_composite, confidence
  // Fields without natural mapping (impact, probability, time_weight, is_new) → null
  // The dashboard renders ?? '—' for nulls.
  const threatMatrix = (reconcileResult.final_threat_matrix || []).map(t => {
    // Try to find the original sweep threat data via Layer 2's scored_threats
    const l2Match = (contextualizeResult.scored_threats || []).find(
      s => s.threat === t.threat
    );
    return {
      threat:      t.threat,
      description: t.layer3_adjustment || '',
      impact:      null, // no natural mapping — dashboard handles null
      probability: null, // no natural mapping
      time_weight: null, // no natural mapping
      composite:   t.final_composite ?? 0,
      severity:    t.confidence === 'high' ? 'critical'
                 : t.confidence === 'medium' ? 'high'
                 : 'moderate',
      proximity:   null, // no natural mapping from Layer 4
      blind_spot:  false,
      is_new:      null, // no natural mapping
      category:    null  // no natural mapping from Layer 4
    };
  });

  // 2. compounding_risks[] — derive from Layer 4's contradictions + compound stress
  const compoundingRisks = [];
  // Add compound stress chain if pre-loaded or approaching critical
  const csf = reconcileResult.compound_stress_final;
  if (csf) {
    const stressLevel = csf.level || 'MONITORING';
    const sevMap = { MONITORING: 'moderate', ELEVATED: 'high', CRITICAL: 'critical', EMERGENCY: 'critical' };
    compoundingRisks.push({
      chain:    (csf.pre_loaded_legs || []).length > 0
        ? csf.pre_loaded_legs
        : ['Oil', 'USD/JPY', 'JGB 10Y', 'BOJ', 'Carry Trade'],
      outcome:  csf.thesis_paradox || csf.velocity_note || `Compound stress: ${stressLevel}`,
      severity: sevMap[stressLevel] || 'moderate'
    });
  }
  // Add contradictions as compounding risks where resolution is paradox_held
  (reconcileResult.contradictions_resolved || [])
    .filter(c => c.resolution === 'paradox_held')
    .forEach(c => {
      compoundingRisks.push({
        chain:    ['Data', 'Behavior', 'Paradox'],
        outcome:  c.reasoning || 'Unresolved contradiction between data and behavior',
        severity: c.confidence === 'high' ? 'high' : 'moderate'
      });
    });

  // 3. blind_spots[] — derive from Layer 2's unscored_threats + Layer 3's x402_paper_trades
  const blindSpots = [];
  (contextualizeResult.unscored_threats || []).forEach(ut => {
    blindSpots.push({
      threat:                       ut.threat,
      importance:                   'high',
      suggested_source:             ut.knowledge_needed || 'Unknown',
      x402_opportunity:             ut.acquisition_type === 'INTELLIGENCE',
      recommend_permanent_monitoring: false
    });
  });
  (inferenceResult.x402_paper_trades || []).forEach(pt => {
    blindSpots.push({
      threat:                       pt.question,
      importance:                   pt.confidence_data_exists === 'high' ? 'high' : 'moderate',
      suggested_source:             pt.data_source || 'Unknown',
      x402_opportunity:             true,
      recommend_permanent_monitoring: false
    });
  });

  // 4. bias_check — derive from burden of proof counts
  const bop = reconcileResult.burden_of_proof_applied || [];
  // Bull indicators: inferences where Layer 3 found thesis support and Layer 4 kept them
  const bullCount = bop.filter(b =>
    (b.final_weight === 'full' || b.final_weight === 'reduced_50') &&
    !b.contradicts_data
  ).length;
  // Bear indicators: inferences stripped, rejected, or where null hypothesis held
  const bearCount = bop.filter(b =>
    b.final_weight === 'stripped' || b.final_weight === 'rejected' || b.final_weight === 'reduced_75' ||
    b.layer3_classification === 'NULL_HYPOTHESIS_HOLDS'
  ).length;
  const totalBop = bullCount + bearCount || 1;
  const biasCheck = {
    bull_indicators:      bullCount,
    bear_indicators:      bearCount,
    ratio:                `${bullCount}:${bearCount}`,
    assessment:           reconcileResult.pressure_reasoning || '',
    recommended_additions: null
  };

  // 5. kill_switches[] — reshape from Layer 4's kill_switch_review[]
  const killSwitches = (reconcileResult.kill_switch_review || []).map(ks => {
    const statusMap = {
      GREEN:      'safe',
      MONITORING: 'warning',
      WARNING:    'danger',
      TRIGGERED:  'triggered'
    };
    return {
      name:   ks.criterion,
      status: statusMap[ks.final_status] || 'no_data',
      detail: ks.reasoning || ''
    };
  });

  // 6. Top-level scalar fields
  const bearPressure = reconcileResult.final_bear_pressure ?? 0;
  const scoreDelta = bearPressure - (previousScore || 0);

  const dashCompat = {
    // Fields the dashboard reads directly
    commander_summary:          reconcileResult.final_report || '',
    bear_pressure_score:        bearPressure,
    score_delta:                scoreDelta,
    score_reasoning:            reconcileResult.pressure_reasoning || '',
    tactical_recommendation:    reconcileResult.tactical_recommendation || 'INCREASE_MONITORING',
    recommendation_reasoning:   reconcileResult.recommendation_reasoning || '',
    threat_matrix:              threatMatrix,
    compounding_risks:          compoundingRisks,
    blind_spots:                blindSpots,
    bias_check:                 biasCheck,
    kill_switches:              killSwitches,
    new_kill_switches_recommended: [],

    // Preserve the raw four-layer output for audit/debugging
    // The dashboard ignores these fields, but they're available for inspection
    _layer4_raw: reconcileResult,
    _layer3_raw: inferenceResult,
    _layer2_raw: contextualizeResult,
    _pipeline_version: '4-layer-v1',
    _generated_at: new Date().toISOString()
  };

  log('bridge', `Bridge complete: score=${bearPressure}, delta=${scoreDelta}, rec=${dashCompat.tactical_recommendation}, threats=${threatMatrix.length}`);
  return dashCompat;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch Terminal — Four-Layer Analysis ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // 1. Load dashboard data
  if (!fs.existsSync(DASHBOARD_PATH)) {
    err('io', 'dashboard-data.json not found — run fetch-data.js first');
    process.exit(1);
  }
  const dashboardData = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  log('io', 'Loaded dashboard-data.json');

  // 2. Load thesis context
  if (!fs.existsSync(THESIS_CONTEXT_PATH)) {
    err('io', 'thesis-context.md not found — create scripts/thesis-context.md');
    await sendTelegram('⚠️ OVERWATCH: Analysis failed — thesis-context.md missing');
    process.exit(1);
  }
  const thesisContext = fs.readFileSync(THESIS_CONTEXT_PATH, 'utf8');
  log('io', 'Loaded thesis-context.md');

  // 3. Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('Claude', 'ANTHROPIC_API_KEY not set');
    await sendTelegram('⚠️ OVERWATCH: Analysis failed — ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const runType = getRunType();
  log('run', `Run type: ${runType}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FOUR-LAYER PIPELINE: SWEEP → CONTEXTUALIZE → INFER → RECONCILE
  // Each layer receives ONLY the output of the layer before it.
  // If any layer fails, the pipeline degrades gracefully.
  // ═══════════════════════════════════════════════════════════════════════════

  let assessment360 = null;
  const previousBearScore = dashboardData.bear_case?.counter_thesis_score ?? 50;

  // ── Layer 1: SWEEP ──────────────────────────────────────────────────────
  console.log('\n═══ LAYER 1: SWEEP ═══');
  const sweepResults = await runSweep(dashboardData);

  // Tier 1 validators — Layer 1
  let tier1Layer1 = { flags: [], hard_fails: 0, total_flags: 0, layer: 1 };
  try {
    tier1Layer1 = runTier1Checks(1, sweepResults, dashboardData);
  } catch (e) {
    warn('tier1', `Layer 1 validator failed (non-fatal): ${e.message}`);
    tier1Layer1 = { flags: [{ rule_id: 'VALIDATOR_FAILURE', finding: 'Layer 1 Tier 1 checks', detail: e.message, severity: 'FLAG', timestamp: new Date().toISOString() }], hard_fails: 0, total_flags: 1, layer: 1 };
  }

  // Layer Zero Gate — Layer 1
  let gateLayer1 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
  if (sweepResults.length > 0) {
    try {
      gateLayer1 = await runLayerZeroGate(1, sweepResults, tier1Layer1, process.env.ANTHROPIC_API_KEY);
    } catch (e) {
      warn('gate', `Layer 1 gate failed (non-fatal): ${e.message}`);
      gateLayer1 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true, failure_reason: e.message };
    }
  }

  if (sweepResults.length === 0) {
    warn('pipeline', 'Layer 1 SWEEP returned empty — four-layer pipeline cannot run');
  }

  if (sweepResults.length > 0) {
    // Prune to top 15 threats: critical → high → moderate → low
    const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3 };
    let threatsToAssess = sweepResults;
    if (sweepResults.length > 15) {
      threatsToAssess = sweepResults
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (SEVERITY_RANK[a.t.severity] ?? 9) - (SEVERITY_RANK[b.t.severity] ?? 9) || a.i - b.i)
        .slice(0, 15)
        .sort((a, b) => a.i - b.i)
        .map(({ t }) => t);
      log('pipeline', `Pruned sweep from ${sweepResults.length} to 15 threats`);
    }

    // ── Layer 2: CONTEXTUALIZE ────────────────────────────────────────────
    console.log('\n═══ LAYER 2: CONTEXTUALIZE ═══');
    const contextualizeResult = await runContextualize(threatsToAssess, dashboardData, previousBearScore, thesisContext);

    // Tier 1 validators — Layer 2
    let tier1Layer2 = { flags: [], hard_fails: 0, total_flags: 0, layer: 2 };
    if (contextualizeResult) {
      try {
        tier1Layer2 = runTier1Checks(2, contextualizeResult, dashboardData);
      } catch (e) {
        warn('tier1', `Layer 2 validator failed (non-fatal): ${e.message}`);
        tier1Layer2 = { flags: [{ rule_id: 'VALIDATOR_FAILURE', finding: 'Layer 2 Tier 1 checks', detail: e.message, severity: 'FLAG', timestamp: new Date().toISOString() }], hard_fails: 0, total_flags: 1, layer: 2 };
      }
    }

      // Layer Zero Gate — Layer 2
      let gateLayer2 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
      if (contextualizeResult) {
        try {
          gateLayer2 = await runLayerZeroGate(2, contextualizeResult, tier1Layer2, process.env.ANTHROPIC_API_KEY);
        } catch (e) {
          warn('gate', `Layer 2 gate failed (non-fatal): ${e.message}`);
          gateLayer2 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true, failure_reason: e.message };
        }
      }

    if (contextualizeResult) {
      // ── Layer 3: INFER ──────────────────────────────────────────────────
      console.log('\n═══ LAYER 3: INFER ═══');
      const inferenceResult = await runInfer(contextualizeResult, dashboardData, thesisContext);

      // Tier 1 validators — Layer 3
      let tier1Layer3 = { flags: [], hard_fails: 0, total_flags: 0, layer: 3 };
      if (inferenceResult) {
        try {
          tier1Layer3 = runTier1Checks(3, inferenceResult, dashboardData);
        } catch (e) {
          warn('tier1', `Layer 3 validator failed (non-fatal): ${e.message}`);
          tier1Layer3 = { flags: [{ rule_id: 'VALIDATOR_FAILURE', finding: 'Layer 3 Tier 1 checks', detail: e.message, severity: 'FLAG', timestamp: new Date().toISOString() }], hard_fails: 0, total_flags: 1, layer: 3 };
        }
      }

      // Layer Zero Gate — Layer 3
      let gateLayer3 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
      if (inferenceResult) {
        try {
          gateLayer3 = await runLayerZeroGate(3, inferenceResult, tier1Layer3, process.env.ANTHROPIC_API_KEY);
        } catch (e) {
          warn('gate', `Layer 3 gate failed (non-fatal): ${e.message}`);
          gateLayer3 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true, failure_reason: e.message };
        }
      }

      if (inferenceResult) {
        // ── Layer 4: RECONCILE ────────────────────────────────────────────
        console.log('\n═══ LAYER 4: RECONCILE ═══');
        const reconcileResult = await runReconcile(contextualizeResult, inferenceResult, dashboardData, thesisContext);

        // Tier 1 validators — Layer 4
        let tier1Layer4 = { flags: [], hard_fails: 0, total_flags: 0, layer: 4 };
        if (reconcileResult) {
          try {
            tier1Layer4 = runTier1Checks(4, reconcileResult, dashboardData);
          } catch (e) {
            warn('tier1', `Layer 4 validator failed (non-fatal): ${e.message}`);
            tier1Layer4 = { flags: [{ rule_id: 'VALIDATOR_FAILURE', finding: 'Layer 4 Tier 1 checks', detail: e.message, severity: 'FLAG', timestamp: new Date().toISOString() }], hard_fails: 0, total_flags: 1, layer: 4 };
          }
        }

        // Layer Zero Gate — Layer 4
        let gateLayer4 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
        if (reconcileResult) {
          try {
            gateLayer4 = await runLayerZeroGate(4, reconcileResult, tier1Layer4, process.env.ANTHROPIC_API_KEY);
          } catch (e) {
            warn('gate', `Layer 4 gate failed (non-fatal): ${e.message}`);
            gateLayer4 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true, failure_reason: e.message };
          }
        }

        if (reconcileResult) {
          // ── Compatibility Bridge ──────────────────────────────────────
          assessment360 = buildDashboardCompatible(reconcileResult, contextualizeResult, inferenceResult, previousBearScore);
          log('pipeline', '✓ Full four-layer pipeline complete');
        } else {
          // Layer 4 failed — fall back to Layer 2 output via old bridge
          warn('pipeline', 'Layer 4 failed — using Layer 2 output as fallback');
          assessment360 = {
            commander_summary: contextualizeResult.layer2_summary || '',
            bear_pressure_score: contextualizeResult.bear_pressure ?? 0,
            score_delta: (contextualizeResult.bear_pressure ?? 0) - previousBearScore,
            score_reasoning: contextualizeResult.bear_pressure_reasoning || '',
            tactical_recommendation: 'INCREASE_MONITORING',
            recommendation_reasoning: 'Layer 4 RECONCILE failed. Using Layer 2 data only. Increase monitoring until full pipeline is restored.',
            threat_matrix: [],
            compounding_risks: [],
            blind_spots: [],
            bias_check: { bull_indicators: 0, bear_indicators: 0, ratio: '0:0', assessment: 'Pipeline degraded — Layer 4 unavailable' },
            kill_switches: [],
            new_kill_switches_recommended: [],
            _pipeline_version: '2-layer-fallback',
            _generated_at: new Date().toISOString()
          };
        }
      } else {
        // Layer 3 failed — fall back to Layer 2 output
        warn('pipeline', 'Layer 3 failed — using Layer 2 output as fallback');
        assessment360 = {
          commander_summary: contextualizeResult.layer2_summary || '',
          bear_pressure_score: contextualizeResult.bear_pressure ?? 0,
          score_delta: (contextualizeResult.bear_pressure ?? 0) - previousBearScore,
          score_reasoning: contextualizeResult.bear_pressure_reasoning || '',
          tactical_recommendation: 'INCREASE_MONITORING',
          recommendation_reasoning: 'Layer 3 INFER failed. Using Layer 2 data only. Strategic reasoning unavailable.',
          threat_matrix: [],
          compounding_risks: [],
          blind_spots: [],
          bias_check: { bull_indicators: 0, bear_indicators: 0, ratio: '0:0', assessment: 'Pipeline degraded — Layers 3-4 unavailable' },
          kill_switches: [],
          new_kill_switches_recommended: [],
          _pipeline_version: '2-layer-fallback',
          _generated_at: new Date().toISOString()
        };
      }
    } else {
      warn('pipeline', 'Layer 2 failed — four-layer pipeline cannot continue');
    }
  }

  // ── Write 360 report and history ──────────────────────────────────────────
  if (assessment360) {
    // Persist Layer 1 sweep output for audit and cognitive trace assembly
    // Attached here (not in bridge) so it persists in all pipeline paths including fallbacks
    if (sweepResults && sweepResults.length > 0) {
      assessment360._layer1_raw = sweepResults;
    }
    try {
      const reportPath = path.join(__dirname, '..', 'data', '360-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(assessment360, null, 2));
      log('io', '360-report.json updated');
    } catch (e) {
      err('io', `Failed to write 360-report.json: ${e.message}`);
    }

    try {
      const historyPath = path.join(__dirname, '..', 'data', '360-history.json');
      let history = [];
      if (fs.existsSync(historyPath)) {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      }
      const historyEntry = {
        timestamp: new Date().toISOString(),
        ...assessment360
      };
      // Extract corrections_referenced before deleting raw layer data
      // These small arrays enable Sunday audit to verify times_applied counters
      // across all runs in a week, not just the latest 360-report.json
      historyEntry._layer2_corrections_referenced = historyEntry._layer2_raw?.corrections_referenced || [];
      historyEntry._layer3_corrections_referenced = historyEntry._layer3_raw?.corrections_referenced || [];
      // Don't store raw layer data in history — too large
      delete historyEntry._layer4_raw;
      delete historyEntry._layer3_raw;
      delete historyEntry._layer2_raw;
      delete historyEntry._layer1_raw;
      history.push(historyEntry);
      if (history.length > 60) {
        history = history.slice(-60);
      }
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
      log('io', `360-history.json updated (${history.length} entries)`);
    } catch (e) {
      err('io', `Failed to update 360-history.json: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN ANALYSIS CALL (legacy — produces dashboard primary data)
  // This will be replaced by the four-layer pipeline once verified.
  // For now, both run. The 360 pipeline feeds bear_case overlay only.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n═══ MAIN ANALYSIS (legacy) ═══');

  // 5. Build prompt
  const newsHeadlines = dashboardData.news?.headlines ?? [];
  const userPrompt = `## CURRENT DASHBOARD DATA
${JSON.stringify(dashboardData, null, 2)}

## THESIS FRAMEWORK
${thesisContext}

## RECENT NEWS HEADLINES
${JSON.stringify(newsHeadlines, null, 2)}

## ANALYSIS INSTRUCTIONS
- Current time: ${new Date().toISOString()}
- Run type: ${runType} (morning/evening)
- Compare current data against kill switch thresholds
- Assess stress indicators (USD/JPY, JGB yield, oil, DXY, S&P 500, Fear & Greed)
- Evaluate ETF flow trends
- Check if any scorecard items need status changes
- Flag any alerts
- Evaluate each news headline for thesis relevance
- For thesis-relevant headlines, draft an events_draft entry with: date (from headline publish date, formatted as "Mon DD"), category (INSTITUTIONAL | REGULATORY | GEOPOLITICAL | FINANCIAL), severity (MONITORING | ELEVATED | CRITICAL), title (concise), expanded (1-2 sentence detail)
- Only include headlines that materially affect the thesis framework — ignore routine price commentary, opinion pieces, and speculation
- Flag if any headline suggests a kill switch status change

Respond with the JSON analysis object only.

IMPORTANT: Keep all text fields concise. Ensure your response is valid, complete JSON with all brackets and braces closed.`;

  // 5. Call Claude API (1 retry after 5s on failure)
  let analysis;
  let raw;
  const client = new Anthropic({ apiKey });
  const callParams = {
    model:      'claude-opus-4-6',
    max_tokens: 8000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userPrompt }],
  };

  let response;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      log('Claude', `Calling claude-opus-4-6… (attempt ${attempt + 1})`);
      response = await client.messages.create(callParams);
      break; // success
    } catch (e) {
      if (attempt === 0) {
        warn('Claude', `Attempt 1 failed: ${e.message} — retrying in 5s`);
        await sleep(5_000);
      } else {
        err('Claude', `API call failed after retry: ${e.message}`);
        await sendTelegram(`🚨 <b>OVERWATCH: Analysis failed — Claude API unreachable</b>\n\nError: ${e.message}`);
        process.exit(1);
      }
    }
  }

  raw = response.content[0].text;
  log('Claude', `Response received (${raw.length} chars)`);

  // Strip any accidental markdown code fences, then check for truncation
  const cleaned = repairTruncatedJSON(
    raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim(),
    'Claude'
  );

  try {
    analysis = JSON.parse(cleaned);
    log('Claude', 'JSON parsed successfully');
  } catch (parseErr) {
    err('Claude', `JSON parse failed: ${parseErr.message}`);
    try {
      fs.writeFileSync(DEBUG_RESPONSE_PATH, raw);
      warn('Claude', `Raw response saved to ${DEBUG_RESPONSE_PATH}`);
    } catch (writeErr) {
      warn('Claude', `Could not write debug file: ${writeErr.message}`);
    }
    await sendTelegram(
      `⚠️ <b>OVERWATCH: JSON parse failed</b>\n\nDebug saved to scripts/debug-claude-response.txt\n\nRaw output preview:\n<pre>${raw.substring(0, 2000)}</pre>`
    );
    process.exit(1);
  }

  // Ensure timestamp and run_type are set
  analysis.timestamp = analysis.timestamp ?? new Date().toISOString();
  analysis.run_type  = analysis.run_type  ?? runType;

  // Overlay 360 results if the four-layer pipeline (or fallback) succeeded
  if (assessment360) {
    analysis.bear_case = analysis.bear_case ?? {};
    analysis.bear_case.counter_thesis_score = assessment360.bear_pressure_score;
    analysis.bear_case.bear_narrative       = assessment360.commander_summary;
    analysis.assessment_360                 = assessment360;
    log('pipeline', 'Overlaid 360 bear pressure score and commander summary onto analysis');
  }

  // 6. Write analysis-output.json
  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysis, null, 2));
  log('io', `Wrote analysis-output.json`);

  // 6b. Append to analysis-history.json
  try {
    // Build kill switch summary from current dashboard data
    const ksCounts = {};
    for (const ks of Object.values(dashboardData.kill_switches ?? {})) {
      const s = ks.status ?? 'UNKNOWN';
      ksCounts[s] = (ksCounts[s] || 0) + 1;
    }

    // Probability: use recommended adjustment if present, else existing dashboard probability
    const probSrc = analysis.recommended_probability_adjustment?.reasoning
      ? analysis.recommended_probability_adjustment
      : dashboardData.probability;

    const historyRecord = {
      timestamp:           analysis.timestamp,
      run_type:            analysis.run_type,
      stress_score:        analysis.stress_assessment?.score    ?? null,
      stress_level:        analysis.stress_assessment?.level    ?? null,
      xrp_price:           dashboardData.xrp?.price             ?? null,
      fear_greed:          dashboardData.macro?.fear_greed?.value ?? null,
      usd_jpy:             dashboardData.macro?.usd_jpy?.value   ?? null,
      jpn_10y:             dashboardData.macro?.jpn_10y?.value   ?? null,
      brent_crude:         dashboardData.macro?.brent_crude?.value ?? null,
      dxy:                 dashboardData.macro?.dxy?.value       ?? null,
      sp500:               dashboardData.macro?.sp500?.value     ?? null,
      etf_daily_flow:      dashboardData.etf?.daily_net_flow     ?? null,
      dex_volume_24h:      dashboardData.xrpl_metrics?.dex_volume_24h_usd ?? null,
      rlusd_market_cap:    dashboardData.rlusd?.market_cap       ?? null,
      probability_framework: {
        bear: probSrc?.bear ?? 8,
        base: probSrc?.base ?? 55,
        mid:  probSrc?.mid  ?? 25,
        bull: probSrc?.bull ?? 12,
      },
      kill_switch_summary: ksCounts,
      alerts_count:        (analysis.alerts ?? []).length,
      events_drafted_count:(analysis.events_draft ?? []).length,
      thesis_pulse:        (analysis.thesis_pulse ?? '').substring(0, 200),
      counter_thesis_score: analysis.bear_case?.counter_thesis_score ?? null,
    };

    let history = [];
    if (fs.existsSync(HISTORY_PATH)) {
      try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (_) {}
    }
    if (!Array.isArray(history)) history = [];
    history.push(historyRecord);
    if (history.length > HISTORY_MAX_RECORDS) {
      history = history.slice(history.length - HISTORY_MAX_RECORDS);
    }
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    log('io', `Analysis history updated (${history.length} records)`);
  } catch (histErr) {
    warn('io', `Could not update analysis-history.json: ${histErr.message}`);
  }

  // 7. Send Telegram notification
  let pipelineHealthLine = '⚡ Pipeline: health check unavailable';
  try {
    const healthPath = path.join(__dirname, 'pipeline-health.json');
    if (fs.existsSync(healthPath)) {
      const h = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      pipelineHealthLine = `⚡ Pipeline: ${h.fields_populated}/${h.fields_total} sources | ${h.status}`;
    }
  } catch (_) {}

  // Add four-layer pipeline status to Telegram
  const pipelineVersion = assessment360?._pipeline_version ?? 'not-run';
  const pipelineStatus = pipelineVersion === '4-layer-v1'
    ? '🟢 4-LAYER'
    : pipelineVersion.includes('fallback')
    ? '🟡 DEGRADED'
    : '🔴 OFFLINE';
  const fourLayerLine = `🏗️ Pipeline: ${pipelineStatus} (${pipelineVersion})`;

  // Overledger status for Telegram
  let overledgerLine = '';
  try {
    const rejLogPath = path.join(__dirname, '..', 'data', 'rejection-log.json');
    const ledgerPath = path.join(__dirname, '..', 'data', 'corrections-ledger.json');
    let pendingReview = 0;
    let ledgerCount = 0;
    if (fs.existsSync(rejLogPath)) {
      const rejections = JSON.parse(fs.readFileSync(rejLogPath, 'utf8'));
      pendingReview = rejections.filter(r => r.corrections_ledger_action === 'flag_for_review').length;
    }
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      ledgerCount = ledger.length;
    }
    overledgerLine = `\n📋 Overledger: ${ledgerCount} active lessons | ${pendingReview} pending review`;
    if (pendingReview >= 5) {
      overledgerLine += ' ⚠️ REVIEW RECOMMENDED';
    }
  } catch (_) {
    overledgerLine = '\n📋 Overledger: status unavailable';
  }

  const message = formatTelegramMessage(analysis, dashboardData) + '\n' + pipelineHealthLine + '\n' + fourLayerLine + overledgerLine;
  await sendTelegram(message);

  console.log('\n─── Analysis Summary ───────────────────────────');
  console.log(`Stress level:    ${analysis.stress_assessment?.level ?? 'N/A'} (${analysis.stress_assessment?.score ?? 'N/A'}/100)`);
  console.log(`Kill sw changes: ${(analysis.kill_switch_updates ?? []).filter(k => k.recommended_status !== k.previous_status).length}`);
  console.log(`Score changes:   ${(analysis.scorecard_updates ?? []).filter(s => s.recommended_status !== s.previous_status).length}`);
  console.log(`Alerts:          ${(analysis.alerts ?? []).length}`);
  console.log(`Events drafted:  ${(analysis.events_draft ?? []).length}`);
  console.log(`4-Layer:         ${pipelineStatus}`);
  console.log(`Bear pressure:   ${assessment360?.bear_pressure_score ?? 'N/A'}`);
  console.log(`Recommendation:  ${assessment360?.tactical_recommendation ?? 'N/A'}`);
  console.log('───────────────────────────────────────────────\n');

  console.log(`Done: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
