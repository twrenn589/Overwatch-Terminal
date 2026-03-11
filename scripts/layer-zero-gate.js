#!/usr/bin/env node
'use strict';

/**
 * Layer Zero Epistemological Gate — Tier 2 AI Review
 *
 * After each analytical layer produces output and Tier 1 code checks run,
 * this gate reviews the output against all 17 immutable Layer Zero rules.
 * It asks one question: did this layer follow the rules?
 *
 * The gate does NOT re-analyze data. It does NOT score signals. It does NOT
 * perform game theory. It reviews reasoning quality against epistemological
 * standards.
 *
 * Architecture Decision #11: Layer Zero as Active Gatekeeper
 *   - Reviews individual findings, not the layer as a whole
 *   - Fully independent — no gate sees another gate's work
 *   - Does not know its position in the pipeline
 *   - Sonnet by default, Opus when Tier 1 code flags are present
 *   - Pipeline never stops — flagged findings carry violation tags forward
 *   - All verdicts logged to gate-review-ledger.json for Sunday audit
 *
 * The Integrity Protocol (Patent Pending)
 */

const path = require('path');
const fs   = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Default Paths ──────────────────────────────────────────────────────────

const DEFAULT_GATE_LEDGER_PATH = path.join(__dirname, '..', 'data', 'gate-review-ledger.json');

// ─── Load Layer Zero Rules ──────────────────────────────────────────────────

function loadLayerZeroRules() {
  const rulesPath = path.join(__dirname, '..', 'data', 'layer-zero.json');
  try {
    const data = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const rulesByCategory = data.layer_zero?.rules;
    if (!rulesByCategory) {
      console.error('[gate] layer-zero.json missing layer_zero.rules structure');
      return null;
    }
    // Flatten all categories into a single array of rules
    const allRules = [];
    for (const category of Object.keys(rulesByCategory)) {
      const categoryRules = rulesByCategory[category];
      if (Array.isArray(categoryRules)) {
        allRules.push(...categoryRules);
      }
    }
    console.log(`[gate] Loaded ${allRules.length} Layer Zero rules from ${Object.keys(rulesByCategory).length} categories`);
    return allRules;
  } catch (e) {
    console.error(`[gate] Failed to load layer-zero.json: ${e.message}`);
    return null;
  }
}

/**
 * Format Layer Zero rules for the gate prompt.
 * Uses the canonical data/layer-zero.json file.
 */
function formatRulesForPrompt(rules) {
  if (!Array.isArray(rules)) return 'RULES UNAVAILABLE — layer-zero.json failed to load.';

  let text = '';
  for (const rule of rules) {
    text += `[${rule.id}] ${rule.rule}\n`;
    if (rule.rationale) text += `  Rationale: ${rule.rationale}\n`;
    text += '\n';
  }
  return text;
}

// ─── Gate Review Ledger ─────────────────────────────────────────────────────

function appendToGateLedger(entry, ledgerPath) {
  const targetPath = ledgerPath || DEFAULT_GATE_LEDGER_PATH;
  try {
    let ledger = [];
    if (fs.existsSync(targetPath)) {
      ledger = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    }
    if (!Array.isArray(ledger)) ledger = [];
    ledger.push(entry);
    // Keep last 500 entries (~2 months at 8 entries/day)
    if (ledger.length > 500) {
      ledger = ledger.slice(-500);
    }
    fs.writeFileSync(targetPath, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.error(`[gate] Failed to write gate review ledger: ${e.message}`);
  }
}

// ─── Build Gate Prompt ──────────────────────────────────────────────────────

function buildGatePrompt(layerOutput, tier1Flags, rulesText) {
  const tier1Section = tier1Flags.length > 0
    ? `CODE-LEVEL FLAGS (Tier 1 checks found these structural issues — examine these areas closely):
${JSON.stringify(tier1Flags, null, 2)}

These flags indicate specific areas where the code detected potential rule violations. Focus your review on these findings first, then review the rest of the output.`
    : `CODE-LEVEL FLAGS: None. Tier 1 structural checks passed. Perform standard epistemological review.`;

  return `You are an epistemological compliance reviewer. You are NOT an analyst. You do NOT evaluate whether conclusions are correct, whether signals are real, or whether the thesis is valid. You review whether the reasoning process followed the rules.

You have one job: review the following analytical output against 17 immutable epistemological rules and identify any violations.

RULES:
${rulesText}

ANALYTICAL OUTPUT TO REVIEW:
${JSON.stringify(layerOutput)}

${tier1Section}

INSTRUCTIONS:

1. Review EACH distinct finding, inference, or assessment in the output individually. Do not evaluate the output as a whole.

2. For each finding, check whether the reasoning process violated any of the 17 rules. Focus on:
   - Is confidence proportional to evidence cited? (LZ-EPH-002)
   - Are assumptions counted honestly? (LZ-EPH-003)
   - Is the null hypothesis tested before complex explanations? (LZ-RC-004)
   - Are correlations presented as causation? (LZ-RC-001)
   - Is a single data point treated as a trend? (LZ-RC-002)
   - Is a coherent narrative presented without real-world anchoring? (LZ-CC-001 — the Plausibility Trap)
   - Is "I don't know" avoided when it would be the honest answer? (LZ-EPH-001)
   - Are contradictions resolved without independent tie-breaking evidence? (LZ-EH-005)
   - Are predictions given the same weight as measurements? (LZ-RC-005)

3. For each violation found, cite:
   - The specific finding that violated the rule
   - The specific rule ID violated
   - What the violation is (what the reasoning did wrong)
   - How severe this violation is: MINOR (reasoning slightly off but conclusion likely holds), MODERATE (reasoning flaw that could affect the conclusion), SERIOUS (fundamental epistemological error that undermines the finding)

4. If a finding follows all rules correctly, mark it PASS. You do not need to explain why it passed.

5. If the entire output follows all rules, return an empty violations array. A clean review is a valid, high-quality output. Do not invent violations to appear thorough.

6. Do NOT evaluate whether the analytical conclusions are correct. You are checking the reasoning PROCESS, not the RESULT. A finding can reach the wrong conclusion through sound reasoning (that is acceptable). A finding can reach the right conclusion through flawed reasoning (that is a violation).

Respond with ONLY valid JSON — no markdown, no code fences, no commentary:
{
  "findings_reviewed": 0,
  "violations": [
    {
      "finding": "name or description of the specific finding that violated a rule",
      "rule_violated": "LZ-XX-XXX",
      "violation": "what the reasoning did wrong",
      "severity": "MINOR | MODERATE | SERIOUS"
    }
  ],
  "clean_findings": 0,
  "overall_compliance": "COMPLIANT | MINOR_ISSUES | MODERATE_ISSUES | SERIOUS_ISSUES",
  "reviewer_notes": "optional — only if something about this output is unusual enough to flag for the Sunday audit"
}`;
}

// ─── Parse Gate Response ────────────────────────────────────────────────────

function parseGateResponse(rawText, label) {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`[${label}] Gate response JSON parse failed: ${e.message}`);
    return null;
  }
}

// ─── Run Gate ───────────────────────────────────────────────────────────────

/**
 * Run the Layer Zero Epistemological Gate on a layer's output.
 *
 * @param {number} layerNumber  — which layer (1-4), used only for logging and ledger
 * @param {*}      layerOutput  — the layer's JSON output to review
 * @param {object} tier1Result  — result from runTier1Checks() { flags, hard_fails, total_flags }
 * @param {string} apiKey       — Anthropic API key
 * @param {object} [options]    — optional config for isolation
 * @param {string} [options.gateLedgerPath] — path to gate review ledger (default: data/gate-review-ledger.json)
 * @returns {Promise<object>}   — { violations, compliance, model_used, gate_failed }
 */
async function runLayerZeroGate(layerNumber, layerOutput, tier1Result, apiKey, options) {
  const opts = options || {};
  const ledgerPath = opts.gateLedgerPath || DEFAULT_GATE_LEDGER_PATH;

  const label = `gate-L${layerNumber}`;
  console.log(`[${label}] === LAYER ZERO GATE — Layer ${layerNumber} ===`);

  // Load rules from canonical file
  const rules = loadLayerZeroRules();
  if (!rules) {
    console.error(`[${label}] Cannot run gate — Layer Zero rules failed to load`);
    const failResult = {
      violations: [],
      compliance: 'GATE_UNAVAILABLE',
      model_used: 'none',
      gate_failed: true,
      failure_reason: 'layer-zero.json failed to load'
    };
    appendToGateLedger({
      timestamp: new Date().toISOString(),
      layer: layerNumber,
      result: failResult,
      tier1_flags: tier1Result.flags,
      gate_error: 'rules_load_failure'
    }, ledgerPath);
    return failResult;
  }

  const rulesText = formatRulesForPrompt(rules);
  const tier1Flags = tier1Result.flags || [];

  // Model selection: Sonnet by default, Opus when code flags present
  const hasCodeFlags = tier1Result.total_flags > 0;
  const model = hasCodeFlags ? 'claude-opus-4-6' : 'claude-sonnet-4-5-20250929';
  console.log(`[${label}] Model: ${model} (${hasCodeFlags ? `${tier1Result.total_flags} code flag(s) — elevated` : 'no code flags — routine'})`);

  const prompt = buildGatePrompt(layerOutput, tier1Flags, rulesText);

  const client = new Anthropic({ apiKey });

  let gateResult = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[${label}] API call (attempt ${attempt})...`);
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content[0].text;
      gateResult = parseGateResponse(raw, label);

      if (gateResult) {
        const vCount = (gateResult.violations || []).length;
        console.log(`[${label}] Complete: ${gateResult.findings_reviewed || 0} findings reviewed, ${vCount} violation(s), compliance: ${gateResult.overall_compliance}`);
        if (vCount > 0) {
          for (const v of gateResult.violations) {
            const icon = v.severity === 'SERIOUS' ? '🚨' : v.severity === 'MODERATE' ? '⚠️' : 'ℹ️';
            console.log(`[${label}]   ${icon} ${v.rule_violated}: ${v.finding} — ${v.violation.substring(0, 120)}`);
          }
        }
        break;
      }

      console.warn(`[${label}] Attempt ${attempt} returned unparseable response`);
    } catch (e) {
      console.error(`[${label}] Attempt ${attempt} failed: ${e.message}`);
      if (attempt === 2) {
        console.error(`[${label}] Gate FAILED after 2 attempts`);
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // Build result
  const result = gateResult
    ? {
        violations: gateResult.violations || [],
        compliance: gateResult.overall_compliance || 'UNKNOWN',
        model_used: model,
        gate_failed: false,
        findings_reviewed: gateResult.findings_reviewed || 0,
        clean_findings: gateResult.clean_findings || 0,
        reviewer_notes: gateResult.reviewer_notes || null
      }
    : {
        violations: [],
        compliance: 'GATE_UNAVAILABLE',
        model_used: model,
        gate_failed: true,
        failure_reason: 'All attempts failed or returned unparseable response'
      };

  // Log to gate review ledger
  appendToGateLedger({
    timestamp: new Date().toISOString(),
    layer: layerNumber,
    model_used: model,
    tier1_flags_count: tier1Result.total_flags,
    tier1_hard_fails: tier1Result.hard_fails,
    tier1_flags: tier1Flags,
    gate_result: result,
    violations_count: result.violations.length,
    compliance: result.compliance,
    gate_failed: result.gate_failed
  }, ledgerPath);

  return result;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runLayerZeroGate,
  loadLayerZeroRules,
  formatRulesForPrompt,
};
