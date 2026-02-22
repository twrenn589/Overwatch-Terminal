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

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  "stress_interpretation": "2-3 sentences explaining the current composite stress environment for the dashboard stress card. Reference specific thresholds breached or held."
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
- Output ONLY valid JSON. No markdown, no commentary outside the JSON.`;

// ─── Determine run type ───────────────────────────────────────────────────────

function getRunType() {
  // Chicago time (UTC-6 winter, UTC-5 summer)
  const now = new Date();
  const chicagoHour = (now.getUTCHours() - 6 + 24) % 24;
  return chicagoHour < 12 ? 'morning' : 'evening';
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

  // 4. Build prompt
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

Respond with the JSON analysis object only.`;

  // 5. Call Claude API (1 retry after 5s on failure)
  let analysis;
  let raw;
  const client = new Anthropic({ apiKey });
  const callParams = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userPrompt }],
  };

  let response;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      log('Claude', `Calling claude-sonnet-4-20250514… (attempt ${attempt + 1})`);
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

  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

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

  // 6. Write analysis-output.json
  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysis, null, 2));
  log('io', `Wrote analysis-output.json`);

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
