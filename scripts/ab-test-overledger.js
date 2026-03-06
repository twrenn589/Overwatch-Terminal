#!/usr/bin/env node
'use strict';

/**
 * A/B Test: Overledger Causal Impact on Layer 2 CONTEXTUALIZE
 *
 * PURPOSE: Empirically prove that the corrections ledger (Overledger)
 * has causal power over Layer 2's analytical output.
 *
 * METHOD:
 *   1. Snapshot current market data and latest Layer 1 SWEEP results
 *   2. Run Layer 2 TWICE against identical inputs:
 *      - Run A: Full corrections ledger injected (19 entries)
 *      - Run B: Empty corrections ledger injected
 *   3. Compare severity scores on threats matching correction triggers
 *
 * ISOLATION: This script does NOT import from analyze-thesis.js.
 * It reconstructs the Layer 2 prompt from the same source files.
 * Zero production code is modified or imported.
 *
 * EXPECTED RESULT: Threats matching correction triggers (especially
 * JoelKatz apophenia CL-006/007/012/013/015 and Fear & Greed
 * misinterpretation CL-008/010/016) should show measurably different
 * severity scores between Run A and Run B.
 *
 * The Integrity Protocol — Level 2 Recursive Learning Proof
 * Tim Wrenn, March 2026
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');

// ─── Paths ───────────────────────────────────────────────────────────────────

const DASHBOARD_PATH      = path.join(__dirname, '..', 'dashboard-data.json');
const THESIS_CONTEXT_PATH = path.join(__dirname, 'thesis-context.md');
const LEDGER_PATH         = path.join(__dirname, '..', 'data', 'corrections-ledger.json');
const REPORT_PATH         = path.join(__dirname, '..', 'data', '360-report.json');
const OUTPUT_PATH         = path.join(__dirname, '..', 'data', 'ab-test-results.json');

// ─── Layer Zero Rules (identical to production) ──────────────────────────────

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

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function repairTruncatedJSON(text, label) {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(']') || trimmed.endsWith('}')) return text;

  warn(label, 'Response appears truncated — attempting repair');
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace === -1) {
    warn(label, 'Repair failed — no closing brace found');
    return text;
  }

  const candidate = trimmed.slice(0, lastBrace + 1);
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

  const closers = stack.reverse().map(c => c === '{' ? '}' : ']').join('');
  const repaired = candidate + closers;
  warn(label, `Repair applied — appended: ${JSON.stringify(closers)}`);
  return repaired;
}

function parseClaudeJSON(rawText, label) {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const repaired = repairTruncatedJSON(cleaned, label);
  return JSON.parse(repaired);
}

// ─── Build Layer 2 Prompt (identical logic to production) ────────────────────

function buildLayer2Prompt(sweepResults, marketData, previousScore, thesisContext, correctionsLedger) {
  const rlusdCurrent = marketData?.rlusd?.market_cap || 0;
  const rlusdTarget = 5_000_000_000;
  const now = new Date();
  const eoy2026 = new Date('2026-12-31');
  const daysRemaining = Math.max(1, Math.ceil((eoy2026 - now) / 86400000));
  const rlusdPaceNeeded = rlusdCurrent > 0
    ? `${((rlusdTarget - rlusdCurrent) / daysRemaining / 1e6).toFixed(2)}M/day`
    : 'unknown';

  return `${LAYER_ZERO_RULES}

You are a senior analyst performing the CONTEXTUALIZE step of a four-layer investment thesis monitoring system. You receive raw observations from Layer 1 (SWEEP) and your job is to produce contextually scored threats — but ONLY after verifying that your understanding is sufficient to score them accurately.

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
}

// ─── Run a single Layer 2 call ───────────────────────────────────────────────

async function runLayer2(client, prompt, runLabel) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log(runLabel, `Layer 2 API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 12000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      const result = parseClaudeJSON(raw, runLabel);
      log(runLabel, `Complete: ${result.scored_threats?.length || 0} scored, bear pressure: ${result.bear_pressure}`);
      return result;
    } catch (e) {
      err(runLabel, `Attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        err(runLabel, 'FAILED after 2 attempts');
        return null;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Extract Layer 1 threats from latest 360 report ──────────────────────────

function getLatestSweepResults() {
  // The 360-report.json stores _layer2_raw which received the sweep results.
  // But we need the ORIGINAL sweep threats that went INTO Layer 2.
  // Best available: reconstruct from Layer 2's scored_threats + unscored_threats
  // since the sweep results aren't stored separately.
  //
  // Alternative: Run a fresh Layer 1 SWEEP. But that introduces variance —
  // different sweep results between Run A and Run B would invalidate the test.
  //
  // Solution: We run Layer 1 ONCE at the start of this test, then feed the
  // same results to both Run A and Run B.

  log('setup', 'Will run a fresh Layer 1 SWEEP to get identical inputs for both runs');
  return null; // Signal to main() that we need to run sweep
}

// ─── Layer 1 SWEEP (copied from production for isolation) ────────────────────

async function runSweepForTest(marketData, client) {
  log('sweep', 'Running Layer 1 SWEEP for A/B test input...');

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

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log('sweep', `API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content: sweepPrompt }]
      });
      const raw = response.content[0].text;
      const threats = parseClaudeJSON(raw, 'sweep');
      if (!Array.isArray(threats)) {
        err('sweep', 'Response is not a JSON array');
        return [];
      }
      log('sweep', `Sweep complete — ${threats.length} threats found`);
      return threats;
    } catch (e) {
      err('sweep', `Attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) return [];
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Analysis: Compare Run A vs Run B ────────────────────────────────────────

function analyzeResults(runA, runB, correctionsLedger) {
  log('analysis', '=== COMPARING RUN A (with ledger) vs RUN B (without ledger) ===\n');

  // Build a set of correction trigger keywords for matching
  const correctionTriggers = correctionsLedger.map(c => ({
    id: c.id || c.correction_id,
    trigger: c.trigger || c.trigger_condition || '',
    lesson_type: c.lesson_type || '',
    belief: c.belief || ''
  }));

  const scoredA = runA.scored_threats || [];
  const scoredB = runB.scored_threats || [];

  // Build lookup maps by threat name
  const mapA = {};
  scoredA.forEach(t => { mapA[t.threat] = t; });
  const mapB = {};
  scoredB.forEach(t => { mapB[t.threat] = t; });

  // All unique threat names across both runs
  const allThreats = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])];

  // Corrections referenced in Run A
  const refsA = runA.corrections_referenced || [];
  const refIdsA = new Set(refsA.map(r => r.correction_id));

  // Corrections referenced in Run B (should be empty or minimal)
  const refsB = runB.corrections_referenced || [];
  const refIdsB = new Set(refsB.map(r => r.correction_id));

  const comparisons = [];

  for (const threat of allThreats) {
    const a = mapA[threat];
    const b = mapB[threat];

    const sevA = a?.severity ?? null;
    const sevB = b?.severity ?? null;
    const delta = (sevA !== null && sevB !== null) ? sevA - sevB : null;

    // Check if this threat was influenced by any correction in Run A
    const matchingRefs = refsA.filter(r => {
      const influence = (r.influence_on_assessment || '').toLowerCase();
      const trigger = (r.trigger_matched || '').toLowerCase();
      const threatLower = threat.toLowerCase();
      return influence.includes(threatLower) || trigger.includes(threatLower) ||
             threatLower.includes(trigger.split(' ')[0]?.toLowerCase() || '___none___');
    });

    comparisons.push({
      threat,
      severity_run_a: sevA,
      severity_run_b: sevB,
      delta,
      in_run_a_only: a && !b,
      in_run_b_only: !a && b,
      corrections_applied_run_a: matchingRefs.map(r => r.correction_id),
      confidence_a: a?.confidence || null,
      confidence_b: b?.confidence || null
    });
  }

  // Sort by absolute delta (largest differences first)
  comparisons.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));

  // Summary statistics
  const withDelta = comparisons.filter(c => c.delta !== null);
  const correctionLinked = comparisons.filter(c => c.corrections_applied_run_a.length > 0);
  const avgDeltaAll = withDelta.length > 0
    ? withDelta.reduce((sum, c) => sum + Math.abs(c.delta), 0) / withDelta.length
    : 0;
  const avgDeltaCorrectionLinked = correctionLinked.filter(c => c.delta !== null).length > 0
    ? correctionLinked.filter(c => c.delta !== null).reduce((sum, c) => sum + Math.abs(c.delta), 0) / correctionLinked.filter(c => c.delta !== null).length
    : 0;
  const avgDeltaNonLinked = withDelta.filter(c => c.corrections_applied_run_a.length === 0).length > 0
    ? withDelta.filter(c => c.corrections_applied_run_a.length === 0).reduce((sum, c) => sum + Math.abs(c.delta), 0) / withDelta.filter(c => c.corrections_applied_run_a.length === 0).length
    : 0;

  const summary = {
    test_timestamp: new Date().toISOString(),
    test_type: 'AB_TEST_OVERLEDGER_CAUSAL_IMPACT',
    level: 'LEVEL_2_RECURSIVE_LEARNING_PROOF',

    run_a: {
      label: 'WITH_CORRECTIONS_LEDGER',
      ledger_entries: correctionsLedger.length,
      corrections_referenced: refsA.length,
      corrections_ids_cited: [...refIdsA],
      scored_threats: scoredA.length,
      bear_pressure: runA.bear_pressure ?? null,
      bear_pressure_reasoning: runA.bear_pressure_reasoning || null
    },

    run_b: {
      label: 'WITHOUT_CORRECTIONS_LEDGER',
      ledger_entries: 0,
      corrections_referenced: refsB.length,
      corrections_ids_cited: [...refIdsB],
      scored_threats: scoredB.length,
      bear_pressure: runB.bear_pressure ?? null,
      bear_pressure_reasoning: runB.bear_pressure_reasoning || null
    },

    bear_pressure_delta: (runA.bear_pressure ?? 0) - (runB.bear_pressure ?? 0),

    threat_comparisons: comparisons,

    statistics: {
      total_threats_compared: allThreats.length,
      threats_with_severity_delta: withDelta.filter(c => c.delta !== 0).length,
      threats_correction_linked: correctionLinked.length,
      avg_absolute_delta_all_threats: Math.round(avgDeltaAll * 100) / 100,
      avg_absolute_delta_correction_linked: Math.round(avgDeltaCorrectionLinked * 100) / 100,
      avg_absolute_delta_non_linked: Math.round(avgDeltaNonLinked * 100) / 100,
      differential: Math.round((avgDeltaCorrectionLinked - avgDeltaNonLinked) * 100) / 100
    },

    conclusion: null // Set below
  };

  // Determine conclusion
  if (avgDeltaCorrectionLinked > avgDeltaNonLinked && correctionLinked.length > 0) {
    summary.conclusion = {
      result: 'CAUSAL_IMPACT_DEMONSTRATED',
      explanation: `Threats linked to correction triggers showed an average severity delta of ${summary.statistics.avg_absolute_delta_correction_linked} points, compared to ${summary.statistics.avg_absolute_delta_non_linked} for non-linked threats. The corrections ledger has measurable causal power over Layer 2 analytical output.`,
      confidence: correctionLinked.length >= 3 ? 'HIGH' : 'MEDIUM',
      level_2_proof: 'ACHIEVED'
    };
  } else if (withDelta.filter(c => c.delta !== 0).length === 0) {
    summary.conclusion = {
      result: 'NO_MEASURABLE_DIFFERENCE',
      explanation: 'Run A and Run B produced identical severity scores across all threats. The corrections ledger did not produce a measurable difference in this run. This could indicate model variance, or that the current market data does not trigger correction-relevant patterns.',
      confidence: 'LOW',
      level_2_proof: 'NOT_ACHIEVED'
    };
  } else {
    summary.conclusion = {
      result: 'INCONCLUSIVE',
      explanation: `Severity deltas were observed but correction-linked threats (avg delta: ${summary.statistics.avg_absolute_delta_correction_linked}) did not show a clear differential over non-linked threats (avg delta: ${summary.statistics.avg_absolute_delta_non_linked}). The signal may be present but is not definitive in this run.`,
      confidence: 'LOW',
      level_2_proof: 'NOT_ACHIEVED'
    };
  }

  return summary;
}

// ─── Console Report ──────────────────────────────────────────────────────────

function printReport(summary) {
  console.log('\n' + '═'.repeat(70));
  console.log('  A/B TEST RESULTS — OVERLEDGER CAUSAL IMPACT');
  console.log('  The Integrity Protocol — Level 2 Recursive Learning Proof');
  console.log('═'.repeat(70));

  console.log(`\nTimestamp: ${summary.test_timestamp}`);

  console.log('\n── RUN A (WITH CORRECTIONS LEDGER) ──');
  console.log(`   Ledger entries injected: ${summary.run_a.ledger_entries}`);
  console.log(`   Corrections referenced:  ${summary.run_a.corrections_referenced}`);
  console.log(`   Corrections cited:       ${summary.run_a.corrections_ids_cited.join(', ') || 'none'}`);
  console.log(`   Scored threats:          ${summary.run_a.scored_threats}`);
  console.log(`   Bear pressure:           ${summary.run_a.bear_pressure}`);

  console.log('\n── RUN B (WITHOUT CORRECTIONS LEDGER) ──');
  console.log(`   Ledger entries injected: ${summary.run_b.ledger_entries}`);
  console.log(`   Corrections referenced:  ${summary.run_b.corrections_referenced}`);
  console.log(`   Scored threats:          ${summary.run_b.scored_threats}`);
  console.log(`   Bear pressure:           ${summary.run_b.bear_pressure}`);

  console.log('\n── BEAR PRESSURE DELTA ──');
  console.log(`   Run A: ${summary.run_a.bear_pressure} | Run B: ${summary.run_b.bear_pressure} | Delta: ${summary.bear_pressure_delta}`);

  console.log('\n── THREAT-BY-THREAT COMPARISON ──');
  for (const c of summary.threat_comparisons) {
    const deltaStr = c.delta !== null ? (c.delta > 0 ? `+${c.delta}` : `${c.delta}`) : 'N/A';
    const corrStr = c.corrections_applied_run_a.length > 0
      ? ` ← ${c.corrections_applied_run_a.join(', ')}`
      : '';
    console.log(`   ${c.threat}`);
    console.log(`     Run A: ${c.severity_run_a ?? 'not scored'} | Run B: ${c.severity_run_b ?? 'not scored'} | Delta: ${deltaStr}${corrStr}`);
  }

  console.log('\n── STATISTICS ──');
  const s = summary.statistics;
  console.log(`   Threats compared:                  ${s.total_threats_compared}`);
  console.log(`   Threats with severity delta:       ${s.threats_with_severity_delta}`);
  console.log(`   Threats linked to corrections:     ${s.threats_correction_linked}`);
  console.log(`   Avg |delta| (all threats):         ${s.avg_absolute_delta_all_threats}`);
  console.log(`   Avg |delta| (correction-linked):   ${s.avg_absolute_delta_correction_linked}`);
  console.log(`   Avg |delta| (non-linked):          ${s.avg_absolute_delta_non_linked}`);
  console.log(`   Differential:                      ${s.differential}`);

  console.log('\n── CONCLUSION ──');
  console.log(`   Result:     ${summary.conclusion.result}`);
  console.log(`   Confidence: ${summary.conclusion.confidence}`);
  console.log(`   Level 2:    ${summary.conclusion.level_2_proof}`);
  console.log(`   ${summary.conclusion.explanation}`);

  console.log('\n' + '═'.repeat(70) + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ A/B TEST: Overledger Causal Impact ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // 1. Validate prerequisites
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    err('setup', 'ANTHROPIC_API_KEY not set — cannot run test');
    process.exit(1);
  }

  if (!fs.existsSync(DASHBOARD_PATH)) {
    err('setup', 'dashboard-data.json not found — run fetch-data.js first');
    process.exit(1);
  }

  if (!fs.existsSync(THESIS_CONTEXT_PATH)) {
    err('setup', 'thesis-context.md not found');
    process.exit(1);
  }

  // 2. Snapshot inputs (frozen — identical for both runs)
  const marketData = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  log('setup', 'Loaded dashboard-data.json (frozen snapshot)');

  const thesisContext = fs.readFileSync(THESIS_CONTEXT_PATH, 'utf8');
  log('setup', 'Loaded thesis-context.md (frozen snapshot)');

  let correctionsLedger = [];
  if (fs.existsSync(LEDGER_PATH)) {
    correctionsLedger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    log('setup', `Loaded corrections ledger: ${correctionsLedger.length} entries`);
  } else {
    err('setup', 'Corrections ledger not found — test requires active ledger entries');
    process.exit(1);
  }

  if (correctionsLedger.length === 0) {
    err('setup', 'Corrections ledger is empty — test requires active entries to measure impact');
    process.exit(1);
  }

  const previousBearScore = marketData.bear_case?.counter_thesis_score ?? 50;
  log('setup', `Previous bear pressure score: ${previousBearScore}`);

  const client = new Anthropic({ apiKey });

  // 3. Run Layer 1 SWEEP once (shared input for both runs)
  console.log('\n═══ PHASE 1: SHARED LAYER 1 SWEEP ═══');
  let sweepResults = await runSweepForTest(marketData, client);

  if (!sweepResults || sweepResults.length === 0) {
    err('setup', 'Layer 1 SWEEP returned empty — cannot proceed with A/B test');
    process.exit(1);
  }

  // Prune to top 15 (same logic as production)
  const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3 };
  if (sweepResults.length > 15) {
    sweepResults = sweepResults
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (SEVERITY_RANK[a.t.severity] ?? 9) - (SEVERITY_RANK[b.t.severity] ?? 9) || a.i - b.i)
      .slice(0, 15)
      .sort((a, b) => a.i - b.i)
      .map(({ t }) => t);
    log('setup', `Pruned sweep to 15 threats`);
  }

  log('setup', `Frozen sweep input: ${sweepResults.length} threats`);

  // 4. Build prompts
  const promptA = buildLayer2Prompt(sweepResults, marketData, previousBearScore, thesisContext, correctionsLedger);
  const promptB = buildLayer2Prompt(sweepResults, marketData, previousBearScore, thesisContext, []);

  log('setup', `Prompt A length: ${promptA.length} chars (with ${correctionsLedger.length} ledger entries)`);
  log('setup', `Prompt B length: ${promptB.length} chars (with empty ledger)`);

  // 5. Run A: Layer 2 WITH corrections ledger
  console.log('\n═══ PHASE 2: RUN A — WITH CORRECTIONS LEDGER ═══');
  const runA = await runLayer2(client, promptA, 'run-A');
  if (!runA) {
    err('test', 'Run A failed — test cannot proceed');
    process.exit(1);
  }

  // Brief pause to avoid rate limiting
  log('test', 'Pausing 10s between runs to avoid rate limits...');
  await new Promise(r => setTimeout(r, 10000));

  // 6. Run B: Layer 2 WITHOUT corrections ledger
  console.log('\n═══ PHASE 3: RUN B — WITHOUT CORRECTIONS LEDGER ═══');
  const runB = await runLayer2(client, promptB, 'run-B');
  if (!runB) {
    err('test', 'Run B failed — test cannot proceed');
    process.exit(1);
  }

  // 7. Analyze and compare results
  console.log('\n═══ PHASE 4: ANALYSIS ═══');
  const summary = analyzeResults(runA, runB, correctionsLedger);

  // 8. Write results
  const fullOutput = {
    ...summary,
    _raw_run_a: runA,
    _raw_run_b: runB,
    _sweep_input: sweepResults,
    _ledger_snapshot: correctionsLedger
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fullOutput, null, 2));
  log('io', `Full results written to ${OUTPUT_PATH}`);

  // 9. Print human-readable report
  printReport(summary);

  // Exit with status based on result
  if (summary.conclusion.result === 'CAUSAL_IMPACT_DEMONSTRATED') {
    console.log('✓ Level 2 proof achieved.');
    process.exit(0);
  } else {
    console.log(`⚠ Result: ${summary.conclusion.result} — see data/ab-test-results.json for full output.`);
    process.exit(0); // Still exit 0 — inconclusive is not a failure
  }
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
