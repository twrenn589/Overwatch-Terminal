#!/usr/bin/env node
'use strict';

/**
 * test-layer2.js — Local test harness for runContextualize (Layer 2 CONTEXTUALIZE)
 *
 * Makes ONE real Claude API call using live fixture data from the repo.
 * Does NOT write to data/360-report.json or data/360-history.json.
 * Output is written to scripts/test-layer2-output.json for inspection.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/test-layer2.js
 *   (or set ANTHROPIC_API_KEY in scripts/.env)
 *
 * Delete this file after Layer 2 is verified in production.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');

// ─── Helpers (copied from analyze-thesis.js) ──────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

// No-op — test mode does not send Telegram messages
async function sendTelegram(msg) {
  log('telegram', `(suppressed in test) ${msg.substring(0, 80)}...`);
}

// Copied verbatim from analyze-thesis.js
function repairTruncatedJSON(text, label) {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(']') || trimmed.endsWith('}')) return text;

  warn(label, 'Response appears truncated — attempting repair');

  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace === -1) {
    warn(label, 'Repair failed — no closing brace found in response');
    return text;
  }

  const candidate = trimmed.slice(0, lastBrace + 1);

  const stack = [];
  let inStr = false, esc = false;
  for (const ch of candidate) {
    if (esc)                  { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true;  continue; }
    if (ch === '"')           { inStr = !inStr; continue; }
    if (inStr)                continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  const closers = stack.reverse().map(c => c === '{' ? '}' : ']').join('');
  const repaired = candidate + closers;
  warn(label, `Repair applied — appended: ${JSON.stringify(closers)}`);
  return repaired;
}

// ─── runContextualize (test copy — production writes suppressed) ──────────────
//
// This is a copy of runContextualize from analyze-thesis.js.
// The only modifications are:
//   1. 360-report.json write → suppressed (log only)
//   2. 360-history.json write → suppressed (log only)
// All logic, prompts, and API call are identical to production.

async function runContextualize(sweepResults, marketData, previousScore, thesisContext) {
  log('analysis', '=== LAYER 2: CONTEXTUALIZE ===');
  log('analysis', `Processing ${sweepResults.length} threats from Layer 1 SWEEP`);

  let correctionsLedger = [];
  try {
    const ledgerPath = path.join(__dirname, '..', 'data', 'corrections-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      correctionsLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      log('analysis', `Corrections ledger loaded: ${correctionsLedger.length} active entries`);
    } else {
      log('analysis', 'Corrections ledger not found — proceeding with empty ledger (expected on first runs)');
    }
  } catch (e) {
    err('analysis', `Corrections ledger read failed (non-fatal): ${e.message}`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('analysis', 'ANTHROPIC_API_KEY not set — Layer 2 cannot run');
    return null;
  }
  const client = new Anthropic({ apiKey, timeout: 300000 });

  const rlusdCurrent = marketData?.rlusd?.market_cap || 0;
  const rlusdTarget = 5_000_000_000;
  const now = new Date();
  const eoy2026 = new Date('2026-12-31');
  const daysRemaining = Math.max(1, Math.ceil((eoy2026 - now) / 86400000));
  const rlusdPaceNeeded = rlusdCurrent > 0
    ? `${((rlusdTarget - rlusdCurrent) / daysRemaining / 1e6).toFixed(2)}M/day`
    : 'unknown';

  const prompt = `You are a senior analyst performing the CONTEXTUALIZE step of a four-layer investment thesis monitoring system. You receive raw observations from Layer 1 (SWEEP) and your job is to produce contextually scored threats — but ONLY after verifying that your understanding is sufficient to score them accurately.

Do NOT react to headlines. Do NOT score on surface appearance. Before you evaluate any threat, ask yourself: "Do I actually understand the thesis well enough to assess this?"

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

For each significant threat or signal from Layer 1, perform the following check BEFORE scoring:

1. THESIS KNOWLEDGE CHECK
   - "What do I know about the thesis asset's capabilities relevant to this threat?"
   - "Is my understanding current, or could conditions have changed since this knowledge was established?"
   - "Am I about to score this threat based on an assumption I haven't verified?"

   If you identify a gap: flag the threat as REQUIRES_DEEPER_CONTEXT and document:
   - What you don't know
   - What you would need to know to score accurately
   - Where that knowledge might be found

   This is a knowledge acquisition request, not an intelligence acquisition request. You are asking "do I understand the thesis?" not "what are the players doing?" (that's Layer 3's job)

2. CORRECTIONS LEDGER CHECK
   - "Do I have any stored corrections related to this type of threat?"
   - If a matching trigger is found, apply the stored lesson to inform this assessment
   - If a lesson prevents a repeat error, flag it: "LESSON_APPLIED": "CL-XXX"
   - Do NOT skip this step. The ledger exists because the system made this exact type of mistake before.

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

Now — and ONLY now — score the threats. You have verified your understanding, applied corrections from past mistakes, checked compound stress levels, and identified what you don't know.

For each threat from Layer 1:

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
   - REQUIRES_DEEPER_CONTEXT: Cannot score meaningfully without additional knowledge — passed to Layer 3 as an open question, not a scored threat

4. KILL SWITCH STATUS CHECK
   For each of the 10 falsification criteria, report current status based on available data. Flag any that have moved since last assessment. Flag any where data is unavailable (this is distinct from data showing negative results).

5. COMPOUND STRESS ASSESSMENT
   Report the current compound stress level with:
   - Current values of all three legs
   - Which legs are elevated/critical
   - Trajectory (improving, stable, deteriorating)
   - Whether the structure is pre-loaded (one or more legs already elevated, reducing the force needed from others)

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON:
{
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(repairTruncatedJSON(cleaned, 'layer2'));
      log('analysis', `Layer 2 complete: ${result.scored_threats?.length || 0} scored, ${result.unscored_threats?.length || 0} unscored, bear pressure: ${result.bear_pressure}`);
      break;
    } catch (e) {
      err('analysis', `Layer 2 attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        err('analysis', 'Layer 2 FAILED after 2 attempts');
        await sendTelegram('🚨 OVERWATCH: Layer 2 CONTEXTUALIZE failed after 2 attempts. Pipeline degraded.');
        return null;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // TEST MODE: production writes suppressed
  log('io', '(test) Skipping 360-report.json write — production data protected');
  log('io', '(test) Skipping 360-history.json write — production data protected');

  return result;
}

// ─── Test harness ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Layer 2 CONTEXTUALIZE — Local Test ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // 1. Load dashboard-data.json as marketData
  const dashboardPath = path.join(__dirname, '..', 'dashboard-data.json');
  if (!fs.existsSync(dashboardPath)) {
    console.error('ERROR: dashboard-data.json not found');
    process.exit(1);
  }
  const marketData = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
  log('fixture', `Loaded dashboard-data.json (updated: ${marketData.updated})`);

  // 2. Load data/360-report.json, extract threat_matrix as fake sweep results
  const reportPath = path.join(__dirname, '..', 'data', '360-report.json');
  if (!fs.existsSync(reportPath)) {
    console.error('ERROR: data/360-report.json not found');
    process.exit(1);
  }
  const report360 = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const threatMatrix = report360.threat_matrix ?? [];
  const sweepResults = threatMatrix.map(t => ({
    threat:     t.threat,
    description: t.description,
    severity:   'high',
    proximity:  'near-term',
    confidence: 'medium',
    evidence:   'from current 360 report',
    blind_spot: false,
    category:   'macro',
  }));
  log('fixture', `Extracted ${sweepResults.length} threats from 360-report.json threat_matrix`);

  // 3. Load scripts/thesis-context.md
  const thesisContextPath = path.join(__dirname, 'thesis-context.md');
  if (!fs.existsSync(thesisContextPath)) {
    console.error('ERROR: scripts/thesis-context.md not found');
    process.exit(1);
  }
  const thesisContext = fs.readFileSync(thesisContextPath, 'utf8');
  log('fixture', `Loaded thesis-context.md (${thesisContext.length} chars)`);

  // 4. Set previousScore from current 360-report.json
  const previousScore = report360.bear_pressure_score ?? 50;
  log('fixture', `Previous bear pressure score: ${previousScore}`);

  console.log('\n─── Calling runContextualize ────────────────────────────────────────\n');

  // 5. Call runContextualize
  const result = await runContextualize(sweepResults, marketData, previousScore, thesisContext);

  if (!result) {
    console.error('\nFATAL: runContextualize returned null — check API key and logs above');
    process.exit(1);
  }

  // 6. Print full returned JSON
  console.log('\n─── Full Layer 2 Output ─────────────────────────────────────────────\n');
  console.log(JSON.stringify(result, null, 2));

  // 7. Validate expected fields
  console.log('\n─── Validation ──────────────────────────────────────────────────────\n');

  const checks = [
    ['knowledge_audit array',   Array.isArray(result.knowledge_audit) && result.knowledge_audit.length > 0],
    ['scored_threats array',    Array.isArray(result.scored_threats)   && result.scored_threats.length  > 0],
    ['unscored_threats array',  Array.isArray(result.unscored_threats)],
    ['kill_switch_status array', Array.isArray(result.kill_switch_status) && result.kill_switch_status.length > 0],
    ['compound_stress object',  result.compound_stress && typeof result.compound_stress === 'object'],
    ['compound_stress.level',   typeof result.compound_stress?.level === 'string'],
    ['compound_stress.usd_jpy', typeof result.compound_stress?.usd_jpy?.current === 'number'],
    ['compound_stress.jgb_10y', typeof result.compound_stress?.jgb_10y?.current === 'number'],
    ['compound_stress.brent',   typeof result.compound_stress?.brent?.current   === 'number'],
    ['bear_pressure number',    typeof result.bear_pressure === 'number'],
    ['bear_pressure_reasoning', typeof result.bear_pressure_reasoning === 'string'],
    ['layer2_summary string',   typeof result.layer2_summary === 'string' && result.layer2_summary.length > 0],
  ];

  let passed = 0;
  let failed = 0;
  for (const [label, ok] of checks) {
    const status = ok ? 'PASS' : 'FAIL';
    if (ok) passed++; else failed++;
    console.log(`  ${status}  ${label}`);
  }

  console.log(`\n  ${passed}/${checks.length} checks passed${failed > 0 ? ` — ${failed} FAILED` : ''}`);

  // 8. Write result to scripts/test-layer2-output.json
  const outputPath = path.join(__dirname, 'test-layer2-output.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  log('io', `Result written to scripts/test-layer2-output.json`);

  console.log('\n━━━ Test complete ━━━\n');
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
