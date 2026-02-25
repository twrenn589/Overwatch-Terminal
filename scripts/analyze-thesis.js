#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — Stage 3 Autonomous Analyst
 * Reads dashboard-data.json + thesis-context.md, calls Claude API,
 * writes analysis-output.json, and sends a Telegram summary for review.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');

const DASHBOARD_PATH      = path.join(__dirname, '..', 'dashboard-data.json');
const ANALYSIS_PATH       = path.join(__dirname, '..', 'analysis-output.json');
const THESIS_CONTEXT_PATH = path.join(__dirname, 'thesis-context.md');
const DEBUG_RESPONSE_PATH = path.join(__dirname, 'debug-claude-response.txt');
const HISTORY_PATH        = path.join(__dirname, 'analysis-history.json');

const HISTORY_MAX_RECORDS = 180; // 90 days × 2 runs/day

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

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    warn('Telegram', 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping notification');
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       text,
        parse_mode: 'HTML',
      }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
    log('Telegram', 'Message sent successfully');
    return true;
  } catch (e) {
    err('Telegram', e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  const usdJpy  = macro?.usd_jpy != null ? `¥${macro.usd_jpy.toFixed(2)}` : '--';

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

  "macro_analysis": "1-2 sentences on macro environment (yen, yields, oil, tariffs)",

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

// ─── 360 Sweep — Pass 1 ───────────────────────────────────────────────────────

/**
 * Runs the 360 counter-thesis sweep (Pass 1).
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

  const sweepPrompt = `You are a senior institutional analyst conducting a full counter-thesis sweep.
Your job is NOT to evaluate a pre-defined list of risks. Your job is to find
threats the thesis holder may be blind to.

THESIS:
XRP/XRPL is positioned to become primary institutional settlement infrastructure
for cross-border payments. Convergent catalysts include: Ripple institutional
partnerships (BIS, IMF, central banks), RLUSD stablecoin growth toward $5B
circulation, ODL volume expansion, Permissioned Domains enabling compliant
institutional access, XRP ETF approval and sustained inflows, and Japanese
institutional adoption via SBI Holdings.

CURRENT DATA:
${JSON.stringify(marketData)}

FALSIFICATION CRITERIA (existing kill switches):
- ODL Volume: Must show growth trajectory toward institutional-grade volume by Q3 2026
- RLUSD Circulation: Tracking toward $5B target
- PermissionedDEX: Institutional count must be verifiable
- XRP ETF: Sustained outflows beyond 30 days triggers review
- Fear & Greed: Extended period below 20 signals structural risk

INSTRUCTIONS:

1. You are being paid to destroy this thesis. Find the fatal flaw.

2. Do NOT limit yourself to SWIFT, Visa B2B, or JPMorgan. Search across:
   - Emerging technologies not yet on the radar
   - Regulatory scenarios beyond current trajectory (regime changes, enforcement shifts)
   - Market structure changes (liquidity fragmentation, DEX evolution, L2 settlement)
   - Macro regime shifts that invalidate the setup (structural changes, not just recession)
   - Institutional behavior patterns — what are banks ACTUALLY building internally?
   - Geopolitical realignments that change corridor demand
   - Assumption decay — which core assumptions are oldest and least recently validated?
   - Adjacent disruptions (AI-native settlement, CBDC interop layers, stablecoin rails)
   - Narrative risk — what if "institutional adoption" is itself the trap?

3. Think laterally. The biggest risks are usually NOT the ones already being tracked.
   What would make a sophisticated institutional investor sell this position tomorrow?

4. Be specific. Name projects, cite developments, reference timelines.
   Vague warnings are useless. Concrete threats change tactics.

Respond with ONLY a JSON array. Each element:
{
  "threat": "Short name",
  "description": "What specifically is the threat and why it matters",
  "severity": "critical | high | moderate | low",
  "proximity": "immediate | near-term | medium-term | long-term",
  "confidence": "high | medium | low",
  "evidence": "What specific data or development supports this",
  "blind_spot": true/false,
  "category": "competing_infra | regulatory | macro | market_structure | narrative | technology | geopolitical | assumption_decay"
}

Find everything. No limit on count. Do not self-censor findings that
challenge the thesis. That is the entire point.

IMPORTANT: Keep each threat description under 100 words. Return a maximum of 12 threats. Ensure your response is valid, complete JSON with all brackets closed.`;

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
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug-sweep-response.txt'), raw);

  const cleaned = repairTruncatedJSON(
    raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim(),
    '360-sweep'
  );

  try {
    const threats = JSON.parse(cleaned);
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

// ─── 360 Assessment — Pass 2 ──────────────────────────────────────────────────

/**
 * Runs the 360 counter-thesis assessment (Pass 2).
 * Takes Pass 1 sweep findings and structures them into a prioritized,
 * scored assessment with tactical recommendation.
 * Writes the result to data/360-report.json.
 * Returns the full assessment object, or null on any failure.
 *
 * @param {Array}  sweepResults  — threat array returned by runSweep()
 * @param {object} marketData    — current dashboard data
 * @param {number} previousScore — previous bear pressure score (0-100)
 * @returns {Promise<object|null>}
 */
async function runAssessment(sweepResults, marketData, previousScore) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('360-assess', 'ANTHROPIC_API_KEY not set — cannot run assessment');
    return null;
  }

  // Compute RLUSD daily pace needed toward $5B target by EOY 2026
  const rlusdCap       = marketData?.rlusd?.market_cap ?? 0;
  const rlusdRemaining = Math.max(0, 5_000_000_000 - rlusdCap);
  const daysToEOY      = Math.max(1, Math.ceil((new Date('2027-01-01') - new Date()) / 86_400_000));
  const rlusdPaceNeeded = rlusdRemaining > 0
    ? `$${(rlusdRemaining / daysToEOY / 1_000_000).toFixed(2)}M`
    : 'target reached';

  const assessPrompt = `You are reviewing a counter-thesis sweep report for the XRPL institutional
settlement thesis. The sweep team has returned findings. Your job:

1. PRIORITIZE — Which findings change the tactical picture?
2. VALIDATE — Do any findings compound each other?
3. DECIDE — Do any findings trigger existing kill switches or warrant new ones?
4. REPORT — Produce a clear command report.

SWEEP FINDINGS:
${JSON.stringify(sweepResults)}

CURRENT MARKET DATA:
${JSON.stringify(marketData)}

PREVIOUS BEAR PRESSURE SCORE: ${previousScore}

EXISTING KILL SWITCHES:
- ODL Volume: Growth trajectory toward institutional-grade volume by Q3 2026
- RLUSD Circulation: Tracking toward $5B; currently needs ${rlusdPaceNeeded}/day
- PermissionedDEX: Institutional count must be verifiable
- XRP ETF: Sustained outflows beyond 30 days
- Fear & Greed: Extended period below 20

INSTRUCTIONS:

A) THREAT MATRIX — For each finding, calculate:
   - impact (1-10): How much damage if this materializes?
   - probability (1-10): How likely based on current evidence?
   - time_weight: immediate=10, near-term=7, medium-term=4, long-term=2
   - composite = (impact × probability × time_weight) / 10
   Sort by composite descending. Return top 8 max.

B) COMPOUNDING RISKS — Which threats amplify each other?
   Show the chain: A → B → C → [outcome]
   Explain why the combination is worse than individual threats.

C) BLIND SPOTS — Which findings were NOT previously tracked?
   For each:
   - Should it become a permanent monitoring item?
   - What data source would track it?
   - Is there an x402 endpoint opportunity?

D) BIAS CHECK — Count indicators:
   - How many data points in the system support the bull case?
   - How many actively challenge it?
   - Ratio assessment and recommendation.

E) KILL SWITCH STATUS — For each existing kill switch:
   - Current status: safe | warning | danger | triggered | no_data
   - Supporting detail
   - Any new kill switches recommended?

F) TACTICAL RECOMMENDATION (one of):
   - HOLD_POSITION: No findings warrant tactical change
   - INCREASE_MONITORING: Specific areas need closer watch
   - REDUCE_EXPOSURE: Conditions suggest partial de-risk
   - EXIT_SIGNAL: Kill switch triggered or compounding threats critical

G) UPDATED BEAR PRESSURE SCORE (0-100):
   Weight composite threats against thesis strength.
   Explain any change from previous score.

H) COMMANDER SUMMARY:
   2-3 sentences. Plain language. Lead with the most important finding.
   State the tactical recommendation. No hedging.

Respond with ONLY JSON:
{
  "threat_matrix": [
    {
      "threat": "name",
      "description": "...",
      "impact": number,
      "probability": number,
      "time_weight": number,
      "composite": number,
      "severity": "critical|high|moderate|low",
      "proximity": "immediate|near-term|medium-term|long-term",
      "blind_spot": boolean,
      "is_new": boolean,
      "category": "string"
    }
  ],
  "compounding_risks": [
    {
      "chain": ["threat A", "threat B", "threat C"],
      "outcome": "what happens when these combine",
      "severity": "critical|high|moderate"
    }
  ],
  "blind_spots": [
    {
      "threat": "name",
      "importance": "critical|high|moderate",
      "suggested_source": "...",
      "x402_opportunity": boolean,
      "recommend_permanent_monitoring": boolean
    }
  ],
  "bias_check": {
    "bull_indicators": number,
    "bear_indicators": number,
    "ratio": "string",
    "assessment": "string",
    "recommended_additions": ["..."]
  },
  "kill_switches": [
    {
      "name": "...",
      "status": "safe|warning|danger|triggered|no_data",
      "detail": "..."
    }
  ],
  "new_kill_switches_recommended": [
    {
      "name": "...",
      "trigger": "...",
      "reasoning": "..."
    }
  ],
  "tactical_recommendation": "HOLD_POSITION|INCREASE_MONITORING|REDUCE_EXPOSURE|EXIT_SIGNAL",
  "recommendation_reasoning": "...",
  "bear_pressure_score": number,
  "score_delta": number,
  "score_reasoning": "...",
  "commander_summary": "..."
}

IMPORTANT: Keep descriptions concise — under 100 words each. Ensure your response is valid, complete JSON with all brackets and braces closed.`;

  const client = new Anthropic({ apiKey });

  let response;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      log('360-assess', `Calling claude-opus-4-6… (attempt ${attempt + 1})`);
      response = await client.messages.create({
        model:      'claude-opus-4-6',
        max_tokens: 8000,
        messages:   [{ role: 'user', content: assessPrompt }],
      });
      break;
    } catch (e) {
      if (attempt === 0) {
        warn('360-assess', `Attempt 1 failed: ${e.message} — retrying in 5s`);
        await sleep(5_000);
      } else {
        err('360-assess', `API call failed after retry: ${e.message}`);
        return null;
      }
    }
  }

  const raw = response.content[0].text;
  log('360-assess', `Response received (${raw.length} chars)`);
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug-assess-response.txt'), raw);

  const cleaned = repairTruncatedJSON(
    raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim(),
    '360-assess'
  );

  let result;
  try {
    result = JSON.parse(cleaned);
    log('360-assess', `Assessment complete — recommendation: ${result.tactical_recommendation ?? 'unknown'}`);
  } catch (parseErr) {
    err('360-assess', `JSON parse failed: ${parseErr.message}`);
    return null;
  }

  // Write to data/360-report.json
  const reportPath = path.join(__dirname, '..', 'data', '360-report.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    log('360-assess', `Wrote ${reportPath}`);
  } catch (writeErr) {
    err('360-assess', `Could not write 360-report.json: ${writeErr.message}`);
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch Terminal — Stage 3 Analysis ━━━');
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

  // 4. Run 360 two-pass sweep (before main analysis — falls back gracefully on failure)
  let assessment360 = null;
  const previousBearScore = dashboardData.bear_case?.counter_thesis_score ?? 50;

  console.log('\n360 SWEEP: starting...');
  const sweepResults = await runSweep(dashboardData);

  if (sweepResults.length > 0) {
    console.log(`360 ASSESS: starting with ${sweepResults.length} threats from sweep`);
    assessment360 = await runAssessment(sweepResults, dashboardData, previousBearScore);
    if (assessment360) {
      log('360', `Assessment complete — bear pressure: ${assessment360.bear_pressure_score}, recommendation: ${assessment360.tactical_recommendation}`);
    } else {
      warn('360', 'Assessment returned null — falling back to standard analysis');
    }
  } else {
    warn('360', 'Sweep returned empty — falling back to standard analysis');
  }

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
- Assess stress indicators (USD/JPY, JGB yield, oil, Fear & Greed)
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

  // Overlay 360 results if the two-pass system succeeded
  if (assessment360) {
    analysis.bear_case = analysis.bear_case ?? {};
    analysis.bear_case.counter_thesis_score = assessment360.bear_pressure_score;
    analysis.bear_case.bear_narrative       = assessment360.commander_summary;
    analysis.assessment_360                 = assessment360;
    log('360', 'Overlaid 360 bear pressure score and commander summary onto analysis');
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
      usd_jpy:             dashboardData.macro?.usd_jpy          ?? null,
      jpn_10y:             dashboardData.macro?.jpn_10y          ?? null,
      brent_crude:         dashboardData.macro?.brent_crude      ?? null,
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
  const message = formatTelegramMessage(analysis, dashboardData);
  await sendTelegram(message);

  console.log('\n─── Analysis Summary ───────────────────────────');
  console.log(`Stress level:    ${analysis.stress_assessment?.level ?? 'N/A'} (${analysis.stress_assessment?.score ?? 'N/A'}/100)`);
  console.log(`Kill sw changes: ${(analysis.kill_switch_updates ?? []).filter(k => k.recommended_status !== k.previous_status).length}`);
  console.log(`Score changes:   ${(analysis.scorecard_updates ?? []).filter(s => s.recommended_status !== s.previous_status).length}`);
  console.log(`Alerts:          ${(analysis.alerts ?? []).length}`);
  console.log(`Events drafted:  ${(analysis.events_draft ?? []).length}`);
  console.log('───────────────────────────────────────────────\n');

  console.log(`Done: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
