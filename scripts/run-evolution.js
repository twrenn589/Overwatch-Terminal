#!/usr/bin/env node
'use strict';

/**
 * Evolution Library Runner — Progressive Isolation Testing
 *
 * Feeds historical scenarios through the same four-layer pipeline
 * that production uses. Writes all output to isolated directories.
 * Never touches: Telegram, dashboard-data.json, 360-history.json,
 * git commits, or live API calls.
 *
 * Usage:
 *   node scripts/run-evolution.js evolutions/project-atlas
 *   node scripts/run-evolution.js evolutions/project-atlas --mode full
 *   node scripts/run-evolution.js evolutions/project-atlas --mode no-corrections
 *   node scripts/run-evolution.js evolutions/project-atlas --mode raw-llm
 *
 * Modes:
 *   full             (default) Full four-layer pipeline with corrections learning loop
 *   no-corrections   Full pipeline but corrections ledger stays empty throughout.
 *                    Isolates the learning loop's contribution to judgment quality.
 *   raw-llm          Single Claude prompt per step. No layers, no gates, no circuit
 *                    breakers, no corrections. Establishes baseline showing what the
 *                    architecture adds over a naive prompt.
 *
 * The scenario directory must contain:
 *   scenario.json      — manifest + time-step market data
 *   thesis-context.md  — domain thesis (replaces production thesis)
 *   domain.json        — domain config (action recommendations, terminology)
 *
 * The runner creates:
 *   results/run-NNN/    — per-step output (360-report, rejection-log, gate-ledger)
 *   corrections-ledger.json — evolves across steps (starts empty or from seed)
 *   summary.json        — final assessment of system performance
 *
 * Architecture: ARCHITECTURE-DECISION-EVOLUTION-LIBRARY.pdf
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── Import pipeline functions (single source of truth) ─────────────────────

const {
  runSweep,
  runContextualize,
  runInfer,
  runReconcile,
  buildDashboardCompatible,
  LAYER_ZERO_RULES,
} = require('./analyze-thesis');

const { runTier1Checks,
        checkCitationCount,
        checkContradictionResolution,
        checkNullHypothesisPresence,
        checkZeroGapOutput,
        checkConfidenceEvidenceRatio,
        checkAssumptionLimit,
} = require('./tier1-validators');

const { runLayerZeroGate } = require('./layer-zero-gate');

const { assembleTrace } = require('./assemble-trace');

// ─── Utilities ──────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[evo:${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[evo:${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[evo:${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Domain-Agnostic Tier 1 Validators ──────────────────────────────────────

/**
 * Run only the structural (domain-agnostic) Tier 1 checks.
 * Skips checkAnomalousInputData and checkTemporalGaps which
 * look for XRP-specific field names in dashboard-data.json.
 *
 * @param {number} layerNumber — 1, 2, 3, or 4
 * @param {*}      output      — the layer's JSON output
 * @returns {object} { flags, hard_fails, total_flags, layer }
 */
function runStructuralTier1Checks(layerNumber, output) {
  let flags = [];

  switch (layerNumber) {
    case 1:
      // Layer 1 has no structural checks — only data-shape checks
      // which are domain-specific. Clean pass.
      break;

    case 2:
      // Contradiction handling, zero-gap detection, confidence-evidence ratio
      if (output.contradictions) {
        flags.push(...checkContradictionResolution(output.contradictions));
      }
      flags.push(...checkZeroGapOutput(output, 'Layer 2'));
      if (Array.isArray(output.scored_signals || output.scored_threats)) {
        const scored = output.scored_signals || output.scored_threats;
        const withCitations = scored.filter(t => Array.isArray(t.evidence_citations));
        if (withCitations.length > 0) {
          flags.push(...checkConfidenceEvidenceRatio(withCitations, 'signal'));
        }
      }
      break;

    case 3:
      // Citation count, null hypothesis, zero-gap, confidence-evidence, assumption limit
      if (Array.isArray(output.strategic_inferences)) {
        flags.push(...checkCitationCount(output.strategic_inferences, 'finding_from_layer2'));
        flags.push(...checkNullHypothesisPresence(output.strategic_inferences));
        flags.push(...checkConfidenceEvidenceRatio(output.strategic_inferences, 'finding_from_layer2'));
        flags.push(...checkAssumptionLimit(output.strategic_inferences, 'finding_from_layer2'));
      }
      flags.push(...checkZeroGapOutput(output, 'Layer 3'));
      if (Array.isArray(output.hidden_moves)) {
        flags.push(...checkAssumptionLimit(output.hidden_moves, 'player'));
      }
      break;

    case 4:
      // Contradiction resolution, zero-gap, burden of proof rubber-stamp check
      if (Array.isArray(output.contradictions_resolved)) {
        flags.push(...checkContradictionResolution(output.contradictions_resolved));
      }
      flags.push(...checkZeroGapOutput(output, 'Layer 4'));
      if (Array.isArray(output.burden_of_proof_applied)) {
        const allFull = output.burden_of_proof_applied.every(b => b.final_weight === 'full');
        if (allFull && output.burden_of_proof_applied.length >= 5) {
          flags.push({
            rule_id: 'LZ-EPH-002',
            finding: 'Burden of Proof',
            detail: `All ${output.burden_of_proof_applied.length} inferences received full weight. Verify genuine skepticism.`,
            severity: 'FLAG',
            timestamp: new Date().toISOString()
          });
        }
      }
      break;
  }

  const hardFails = flags.filter(f => f.severity === 'HARD_FAIL').length;
  const totalFlags = flags.length;

  if (totalFlags > 0) {
    log('tier1', `Layer ${layerNumber}: ${totalFlags} flag(s) (${hardFails} HARD_FAIL)`);
  } else {
    log('tier1', `Layer ${layerNumber}: clean — no structural flags`);
  }

  return { flags, hard_fails: hardFails, total_flags: totalFlags, layer: layerNumber };
}

// ─── Rejection Promotion (isolated) ─────────────────────────────────────────

/**
 * Promote high-confidence rejections from a step's rejection log
 * into the scenario's corrections ledger. Mirrors production
 * promote-rejections.js but operates on isolated paths.
 *
 * @param {string} rejectionLogPath    — path to this step's rejection-log.json
 * @param {string} correctionsLedgerPath — path to scenario's corrections-ledger.json
 * @returns {number} count of promoted entries
 */
function promoteRejectionsIsolated(rejectionLogPath, correctionsLedgerPath) {
  if (!fs.existsSync(rejectionLogPath)) return 0;

  let rejections;
  try {
    rejections = JSON.parse(fs.readFileSync(rejectionLogPath, 'utf8'));
  } catch (e) {
    warn('promote', `Failed to read rejection log: ${e.message}`);
    return 0;
  }

  const autoCommits = rejections.filter(r => r.corrections_ledger_action === 'auto_commit');
  if (autoCommits.length === 0) return 0;

  // Load existing corrections ledger
  let ledger = [];
  try {
    if (fs.existsSync(correctionsLedgerPath)) {
      ledger = JSON.parse(fs.readFileSync(correctionsLedgerPath, 'utf8'));
    }
  } catch (e) {
    warn('promote', `Failed to read corrections ledger: ${e.message}`);
    ledger = [];
  }

  // Build correction entries from rejections
  const nextId = ledger.length + 1;
  const newEntries = autoCommits.map((r, i) => ({
    id: `CL-${String(nextId + i).padStart(3, '0')}`,
    status: 'active',
    belief: r.layer3_inference || 'unknown',
    reality: r.rejection_reason || 'unknown',
    root_cause: r.root_cause || 'UNKNOWN',
    prevention: `Apply skepticism to similar inferences. Root cause: ${r.root_cause}`,
    trigger: r.layer3_inference || 'unknown',
    source: 'evolution_layer4_reconcile',
    promoted_at: new Date().toISOString(),
    times_applied: 0
  }));

  ledger.push(...newEntries);
  fs.writeFileSync(correctionsLedgerPath, JSON.stringify(ledger, null, 2));
  log('promote', `Promoted ${newEntries.length} rejections to corrections ledger (${ledger.length} total)`);

  return newEntries.length;
}

// ─── Load Scenario ──────────────────────────────────────────────────────────

function loadScenario(scenarioDir) {
  const scenarioPath = path.join(scenarioDir, 'scenario.json');
  const thesisPath   = path.join(scenarioDir, 'thesis-context.md');
  const domainPath   = path.join(scenarioDir, 'domain.json');

  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`scenario.json not found in ${scenarioDir}`);
  }
  if (!fs.existsSync(thesisPath)) {
    throw new Error(`thesis-context.md not found in ${scenarioDir}`);
  }

  const scenario     = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const thesisContext = fs.readFileSync(thesisPath, 'utf8');

  let domainConfig = null;
  if (fs.existsSync(domainPath)) {
    domainConfig = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
  }

  // Validate scenario structure
  if (!scenario.name) throw new Error('scenario.json missing "name"');
  if (!Array.isArray(scenario.time_steps) || scenario.time_steps.length === 0) {
    throw new Error('scenario.json missing or empty "time_steps" array');
  }

  for (let i = 0; i < scenario.time_steps.length; i++) {
    const step = scenario.time_steps[i];
    if (!step.market_data) {
      throw new Error(`time_steps[${i}] missing "market_data" object`);
    }
    if (!step.step) {
      step.step = i + 1; // Auto-assign step numbers if missing
    }
  }

  log('load', `Scenario: ${scenario.display_name || scenario.name}`);
  log('load', `Time steps: ${scenario.time_steps.length}`);
  log('load', `Thesis context: ${thesisContext.length} chars`);
  log('load', `Domain config: ${domainConfig ? 'loaded' : 'none'}`);

  return { scenario, thesisContext, domainConfig };
}

// ─── Setup Isolated Output Directory ────────────────────────────────────────

function setupResultsDir(scenarioDir, stepNumber) {
  const runDir = path.join(scenarioDir, 'results', `run-${String(stepNumber).padStart(3, '0')}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

// ─── Run Single Time Step ───────────────────────────────────────────────────

/**
 * Execute one full pipeline run for a single time step.
 * Four layers, structural Tier 1 checks, four gates.
 * All output written to isolated run directory.
 *
 * @param {object} step              — time step from scenario.json
 * @param {string} thesisContext     — domain thesis context
 * @param {string} scenarioDir      — path to scenario directory
 * @param {string} correctionsLedgerPath — path to evolving corrections ledger
 * @param {number} previousScore    — previous bear pressure score (0 for first step)
 * @returns {Promise<object>}       — step result summary
 */
async function runTimeStep(step, thesisContext, scenarioDir, correctionsLedgerPath, previousScore, domainConfig, previousTensions) {
  const stepNum = step.step;
  const label = step.label || `Step ${stepNum}`;
  const marketData = step.market_data;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  EVOLUTION STEP ${stepNum}: ${label}`);
  console.log(`  Simulated date: ${step.simulated_date || 'not specified'}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Setup isolated output directory for this step
  const runDir = setupResultsDir(scenarioDir, stepNum);
  const rejectionLogPath = path.join(runDir, 'rejection-log.json');
  const gateLedgerPath   = path.join(runDir, 'gate-review-ledger.json');

  // Initialize empty rejection log and gate ledger for this step
  fs.writeFileSync(rejectionLogPath, '[]');
  fs.writeFileSync(gateLedgerPath, '[]');

  // Build isolation options for layer functions
  // AD #14: Isolated audit findings path for this scenario
  const auditFindingsPath = path.join(scenarioDir, 'audit-findings.json');

  const layerOptions = {
    correctionsLedgerPath,
    rejectionLogPath,
    enableTelegram: false,
    enablePromoteRejections: false,  // We handle promotion ourselves between steps
    domainConfig: domainConfig || null,
    findingsPath: auditFindingsPath,  // AD #14: Layer 4 reads advisory from isolated path
    previousTensions: previousTensions || [],
  };

  const gateOptions = {
    gateLedgerPath,
  };

  const stepResult = {
    step: stepNum,
    label,
    simulated_date: step.simulated_date,
    started_at: new Date().toISOString(),
    layers_completed: [],
    layer_outputs: {},
    tier1_results: {},
    gate_results: {},
    errors: [],
    thesis_status: null,
    corrections_promoted: 0,
  };

  try {
    // ── Layer 1: SWEEP ──────────────────────────────────────────────
    console.log('\n═══ LAYER 1: SWEEP ═══');
    const sweepResults = await runSweep(marketData, thesisContext);

    // Structural Tier 1 — Layer 1
    const tier1L1 = runStructuralTier1Checks(1, sweepResults);
    stepResult.tier1_results.layer1 = tier1L1;

    // Gate — Layer 1
    let gateL1 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
    if (sweepResults.length > 0) {
      try {
        gateL1 = await runLayerZeroGate(1, sweepResults, tier1L1, apiKey, gateOptions);
      } catch (e) {
        warn('gate', `Layer 1 gate failed: ${e.message}`);
        gateL1 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true };
      }
    }
    stepResult.gate_results.layer1 = gateL1;
    stepResult.layers_completed.push('SWEEP');
    stepResult.layer_outputs.sweep = sweepResults;

    if (sweepResults.length === 0) {
      warn('pipeline', 'Layer 1 SWEEP returned empty — pipeline cannot continue');
      stepResult.errors.push('Layer 1 returned empty');
      stepResult.completed_at = new Date().toISOString();
      writeStepResult(runDir, stepResult);
      return stepResult;
    }

    // ── Signal ID assignment (deterministic, code-assigned — AD #8)
    let prunedSignals = [];
    const runTs = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    if (Array.isArray(sweepResults)) {
      for (let i = 0; i < sweepResults.length; i++) {
        sweepResults[i].signal_ids = [`${runTs}-SIG-${String(i + 1).padStart(3, '0')}`];
      }
    }

    // Prune to top 15 (same as production)
    const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3 };
    let signalsToAssess = sweepResults;
    if (sweepResults.length > 15) {
      const sorted = sweepResults
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (SEVERITY_RANK[a.t.severity] ?? 9) - (SEVERITY_RANK[b.t.severity] ?? 9) || a.i - b.i);
      signalsToAssess = sorted.slice(0, 15).sort((a, b) => a.i - b.i).map(({ t }) => t);
      prunedSignals = sorted.slice(15).map(({ t }) => ({
        signal_ids: t.signal_ids, signal: t.signal, severity: t.severity,
        direction: t.direction, category: t.category, pruning_reason: 'severity_rank_cutoff'
      }));
      log('pipeline', `Pruned sweep from ${sweepResults.length} to 15 signals (${prunedSignals.length} pruned)`);
    }

    // ── Layer 2: CONTEXTUALIZE ──────────────────────────────────────
    console.log('\n═══ LAYER 2: CONTEXTUALIZE ═══');
    const contextualizeResult = await runContextualize(
      signalsToAssess, marketData, previousScore, thesisContext, layerOptions
    );

    if (!contextualizeResult) {
      stepResult.errors.push('Layer 2 failed');
      stepResult.completed_at = new Date().toISOString();
      writeStepResult(runDir, stepResult);
      return stepResult;
    }

    // Structural Tier 1 — Layer 2
    const tier1L2 = runStructuralTier1Checks(2, contextualizeResult);
    stepResult.tier1_results.layer2 = tier1L2;

    // Gate — Layer 2
    let gateL2 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
    try {
      gateL2 = await runLayerZeroGate(2, contextualizeResult, tier1L2, apiKey, gateOptions);
    } catch (e) {
      warn('gate', `Layer 2 gate failed: ${e.message}`);
      gateL2 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true };
    }
    stepResult.gate_results.layer2 = gateL2;
    stepResult.layers_completed.push('CONTEXTUALIZE');
    stepResult.layer_outputs.contextualize = contextualizeResult;

    // ── Layer 3: INFER ──────────────────────────────────────────────
    console.log('\n═══ LAYER 3: INFER ═══');
    const inferenceResult = await runInfer(
      contextualizeResult, marketData, thesisContext, layerOptions
    );

    if (!inferenceResult) {
      stepResult.errors.push('Layer 3 failed');
      stepResult.completed_at = new Date().toISOString();
      writeStepResult(runDir, stepResult);
      return stepResult;
    }

    // Structural Tier 1 — Layer 3
    const tier1L3 = runStructuralTier1Checks(3, inferenceResult);
    stepResult.tier1_results.layer3 = tier1L3;

    // Gate — Layer 3
    let gateL3 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
    try {
      gateL3 = await runLayerZeroGate(3, inferenceResult, tier1L3, apiKey, gateOptions);
    } catch (e) {
      warn('gate', `Layer 3 gate failed: ${e.message}`);
      gateL3 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true };
    }
    stepResult.gate_results.layer3 = gateL3;
    stepResult.layers_completed.push('INFER');
    stepResult.layer_outputs.infer = inferenceResult;

    // ── Layer 4: RECONCILE ──────────────────────────────────────────
    console.log('\n═══ LAYER 4: RECONCILE ═══');
    const reconcileResult = await runReconcile(
      contextualizeResult, inferenceResult, marketData, thesisContext, layerOptions
    );

    if (!reconcileResult) {
      stepResult.errors.push('Layer 4 failed');
      stepResult.completed_at = new Date().toISOString();
      writeStepResult(runDir, stepResult);
      return stepResult;
    }

    // Structural Tier 1 — Layer 4
    const tier1L4 = runStructuralTier1Checks(4, reconcileResult);
    stepResult.tier1_results.layer4 = tier1L4;

    // Gate — Layer 4
    let gateL4 = { violations: [], compliance: 'GATE_NOT_RUN', gate_failed: false };
    try {
      gateL4 = await runLayerZeroGate(4, reconcileResult, tier1L4, apiKey, gateOptions);
    } catch (e) {
      warn('gate', `Layer 4 gate failed: ${e.message}`);
      gateL4 = { violations: [], compliance: 'GATE_UNAVAILABLE', gate_failed: true };
    }
    stepResult.gate_results.layer4 = gateL4;
    stepResult.layers_completed.push('RECONCILE');
    stepResult.layer_outputs.reconcile = reconcileResult;

    // ── Extract key results ─────────────────────────────────────────
    stepResult.thesis_status = reconcileResult.thesis_status || null;
    stepResult.confidence_in_status = reconcileResult.confidence_in_status || null;
    stepResult.action_recommendation = reconcileResult.action_recommendation || reconcileResult.tactical_recommendation || null;
    stepResult.final_bear_pressure = reconcileResult.final_bear_pressure ?? null;
    stepResult.unresolved_tensions = reconcileResult.unresolved_tensions || [];
    stepResult.rejection_count = (reconcileResult.rejection_log || []).length;

    // ── Write 360 report for this step ──────────────────────────────
    const report360 = buildDashboardCompatible(
      reconcileResult, contextualizeResult, inferenceResult, previousScore
    );
    report360._layer1_raw = sweepResults;
    if (prunedSignals.length > 0) {
      report360._pruned_signals = prunedSignals;
    }
    fs.writeFileSync(
      path.join(runDir, '360-report.json'),
      JSON.stringify(report360, null, 2)
    );

    log('pipeline', `✓ Full four-layer pipeline complete for step ${stepNum}`);

    // ── Assemble Cognitive Trace for this step ──────────────────────
    try {
      const traceResult = assembleTrace({
        reportPath: path.join(runDir, '360-report.json'),
        gateLedgerPath: gateLedgerPath,
        outputDir: runDir,
      });
      if (traceResult) {
        log('trace', `Cognitive trace assembled: ${traceResult._signal_count} signals, outcomes: ${JSON.stringify(traceResult._outcomes)}`);
      } else {
        warn('trace', 'Trace assembly returned null — trace will be missing for this step');
      }
    } catch (traceErr) {
      warn('trace', `Trace assembly failed (non-fatal): ${traceErr.message}`);
    }

  } catch (e) {
    err('pipeline', `Step ${stepNum} failed with error: ${e.message}`);
    stepResult.errors.push(`Fatal error: ${e.message}`);
  }

  stepResult.completed_at = new Date().toISOString();
  writeStepResult(runDir, stepResult);
  return stepResult;
}

// ─── Write Step Result ──────────────────────────────────────────────────────

function writeStepResult(runDir, stepResult) {
  // Write full result (without raw layer outputs to keep size manageable)
  const resultForDisk = { ...stepResult };
  delete resultForDisk.layer_outputs; // Raw outputs are in 360-report.json
  fs.writeFileSync(
    path.join(runDir, 'step-result.json'),
    JSON.stringify(resultForDisk, null, 2)
  );
}

// ─── Raw LLM Step (Baseline — No Architecture) ─────────────────────────────

/**
 * Execute a single raw Claude prompt for one time step.
 * No layers, no gates, no Tier 1 checks, no corrections ledger,
 * no circuit breakers, no burden of proof, no epistemological constraints.
 *
 * This establishes the baseline: what does a capable LLM produce
 * when given the same data and thesis context but none of the
 * cognitive architecture? The 3×3 matrix compares this against
 * the full pipeline to measure what the architecture adds.
 *
 * @param {object} step          — time step from scenario.json
 * @param {string} thesisContext — domain thesis context
 * @param {string} scenarioDir  — path to scenario directory
 * @param {object} domainConfig — domain.json contents (for action enum)
 * @returns {Promise<object>}   — step result in comparable format
 */
async function runRawLLMStep(step, thesisContext, scenarioDir, domainConfig) {
  const stepNum = step.step;
  const label = step.label || `Step ${stepNum}`;
  const marketData = step.market_data;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RAW LLM STEP ${stepNum}: ${label}`);
  console.log(`  Simulated date: ${step.simulated_date || 'not specified'}`);
  console.log(`  Mode: raw-llm (no architecture)`);
  console.log(`${'═'.repeat(60)}\n`);

  // Setup isolated output directory for this step
  const runDir = setupResultsDir(scenarioDir, stepNum);

  const stepResult = {
    step: stepNum,
    label,
    simulated_date: step.simulated_date,
    started_at: new Date().toISOString(),
    layers_completed: [],
    layer_outputs: {},
    tier1_results: {},
    gate_results: {},
    errors: [],
    thesis_status: null,
    corrections_promoted: 0,
  };

  try {
    // Build action enum from domain config
    let actionEnum = 'MAINTAIN_OPERATIONS | INCREASE_MONITORING | REDUCE_LOAD | EMERGENCY_SHUTDOWN';
    if (domainConfig && Array.isArray(domainConfig.action_recommendations)) {
      actionEnum = domainConfig.action_recommendations.map(a => a.id).join(' | ');
    }

    const systemPrompt = `You are an analytical system monitoring the viability of a thesis. You will receive the thesis context and current data. Assess the thesis and provide your analysis.

Respond with ONLY valid JSON — no markdown, no code fences, no commentary outside the JSON.`;

    const userPrompt = `THESIS CONTEXT:
${thesisContext}

CURRENT DATA:
${JSON.stringify(marketData, null, 2)}

Assess the current status of this thesis based on the data provided.

Respond with this exact JSON structure:
{
  "thesis_status": "STRENGTHENING | STABLE | WEAKENING | CONTESTED | INSUFFICIENT_EVIDENCE",
  "confidence_in_status": "high | medium | low",
  "thesis_status_reasoning": "2-4 sentences explaining your assessment",
  "action_recommendation": "${actionEnum}",
  "action_reasoning": "1-2 sentences explaining why this action",
  "key_signals": [
    {
      "signal": "description of an important signal in the data",
      "direction": "positive | negative | ambiguous",
      "severity": "critical | high | moderate | low"
    }
  ],
  "biggest_uncertainty": "the single thing that most affects your confidence"
}`;

    // ── Single Claude API call — no architecture ────────────────────
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    log('raw-llm', `Calling Claude API for step ${stepNum}...`);
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Parse response
    const responseText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    let rawResult;
    try {
      // Strip markdown fences if present
      const cleaned = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      rawResult = JSON.parse(cleaned);
    } catch (parseErr) {
      err('raw-llm', `Failed to parse raw LLM response: ${parseErr.message}`);
      stepResult.errors.push(`Raw LLM JSON parse failed: ${parseErr.message}`);
      stepResult.completed_at = new Date().toISOString();
      writeStepResult(runDir, stepResult);
      return stepResult;
    }

    // Extract results into comparable format
    stepResult.thesis_status = rawResult.thesis_status || null;
    stepResult.confidence_in_status = rawResult.confidence_in_status || null;
    stepResult.action_recommendation = rawResult.action_recommendation || null;
    stepResult.final_bear_pressure = null; // Raw LLM does not produce this
    stepResult.unresolved_tensions = []; // Raw LLM has no tension tracking
    stepResult.rejection_count = 0; // No rejection mechanism
    stepResult.layers_completed.push('RAW_LLM');
    stepResult.layer_outputs.raw_llm = rawResult;

    // Write raw result to disk
    fs.writeFileSync(
      path.join(runDir, 'raw-llm-output.json'),
      JSON.stringify(rawResult, null, 2)
    );

    log('raw-llm', `✓ Raw LLM complete for step ${stepNum}: ${rawResult.thesis_status} (${rawResult.confidence_in_status})`);

  } catch (e) {
    err('raw-llm', `Step ${stepNum} failed with error: ${e.message}`);
    stepResult.errors.push(`Fatal error: ${e.message}`);
  }

  stepResult.completed_at = new Date().toISOString();
  writeStepResult(runDir, stepResult);
  return stepResult;
}

// ─── Parse Mode from CLI Arguments ──────────────────────────────────────────

/**
 * Parse --mode flag from process.argv.
 * Returns 'full' (default), 'no-corrections', or 'raw-llm'.
 */
function parseMode(argv) {
  const modeIdx = argv.indexOf('--mode');
  if (modeIdx === -1 || modeIdx + 1 >= argv.length) {
    return 'full';
  }

  const mode = argv[modeIdx + 1];
  const validModes = ['full', 'no-corrections', 'raw-llm'];

  if (!validModes.includes(mode)) {
    console.error(`Invalid mode: "${mode}". Valid modes: ${validModes.join(', ')}`);
    process.exit(1);
  }

  return mode;
}

// ─── Main: Run Evolution ────────────────────────────────────────────────────

async function main() {
  const scenarioDir = process.argv[2];
  if (!scenarioDir) {
    console.error('Usage: node scripts/run-evolution.js <scenario-directory> [--mode full|no-corrections|raw-llm]');
    console.error('Example: node scripts/run-evolution.js evolutions/project-atlas');
    console.error('Example: node scripts/run-evolution.js evolutions/project-atlas --mode no-corrections');
    console.error('Example: node scripts/run-evolution.js evolutions/project-atlas --mode raw-llm');
    process.exit(1);
  }

  const resolvedDir = path.resolve(scenarioDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`Scenario directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const mode = parseMode(process.argv);

  console.log('\n━━━ Evolution Library Runner ━━━');
  console.log(`Mode: ${mode}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  // Load scenario
  const { scenario, thesisContext, domainConfig } = loadScenario(resolvedDir);

  // ── Determine results base directory based on mode ──────────────────
  // setupResultsDir() appends results/run-NNN/ to the base directory.
  // full mode:           <scenarioDir>/results/run-NNN/
  // no-corrections mode: <scenarioDir>/no-corrections/results/run-NNN/
  // raw-llm mode:        <scenarioDir>/raw-llm/results/run-NNN/
  let resultsBaseDir = resolvedDir;
  if (mode === 'no-corrections') {
    resultsBaseDir = path.join(resolvedDir, 'no-corrections');
    fs.mkdirSync(resultsBaseDir, { recursive: true });
  } else if (mode === 'raw-llm') {
    resultsBaseDir = path.join(resolvedDir, 'raw-llm');
    fs.mkdirSync(resultsBaseDir, { recursive: true });
  }

  // ── Initialize corrections ledger (full and no-corrections modes) ──
  let correctionsLedgerPath = null;
  if (mode === 'full') {
    correctionsLedgerPath = path.join(resolvedDir, 'corrections-ledger.json');
    if (!fs.existsSync(correctionsLedgerPath)) {
      const seed = scenario.corrections_ledger_seed || [];
      fs.writeFileSync(correctionsLedgerPath, JSON.stringify(seed, null, 2));
      log('init', `Corrections ledger initialized: ${seed.length} seed entries`);
    } else {
      log('init', 'Corrections ledger exists — resuming from previous state');
    }
  } else if (mode === 'no-corrections') {
    // Create an isolated empty ledger that never gets written to
    correctionsLedgerPath = path.join(resultsBaseDir, 'corrections-ledger-empty.json');
    fs.writeFileSync(correctionsLedgerPath, '[]');
    log('init', 'No-corrections mode: empty corrections ledger created (will not be updated)');
  }
  // raw-llm mode: no corrections ledger needed

  // Create results directory
  fs.mkdirSync(path.join(resultsBaseDir, 'results'), { recursive: true });

  // ── AD #14: Clean auditor state before each evolution run ──────────────
  // Stale state-locks from previous runs carry over and taint all subsequent steps.
  // Each evolution run starts clean. The lock is scenario-specific.
  const auditStateLockPath = path.join(resultsBaseDir, 'auditor-state-lock.json');
  const auditFindingsCleanupPath = path.join(resultsBaseDir, 'audit-findings.json');
  for (const staleFile of [auditStateLockPath, auditFindingsCleanupPath]) {
    if (fs.existsSync(staleFile)) {
      log('init', `Cleaning stale auditor file: ${path.basename(staleFile)}`);
      fs.unlinkSync(staleFile);
    }
  }

  // Run each time step sequentially
  const stepResults = [];
  let previousScore = 0;
  let previousTensions = [];  // AD #15: Tension lifecycle across evolution steps

  for (const step of scenario.time_steps) {
    let result;

    if (mode === 'raw-llm') {
      // ── Raw LLM: single prompt, no architecture ──────────────────
      result = await runRawLLMStep(step, thesisContext, resultsBaseDir, domainConfig);
    } else {
      // ── Full or no-corrections: full four-layer pipeline ─────────
      result = await runTimeStep(
        step, thesisContext, resultsBaseDir, correctionsLedgerPath, previousScore, domainConfig, previousTensions
      );
    }

    stepResults.push(result);

    // Update previous score for next step
    if (result.final_bear_pressure != null) {
      previousScore = result.final_bear_pressure;
    }

    // AD #15: Pass this step's tensions to the next step
    previousTensions = result.unresolved_tensions || [];

    // Promote rejections between steps — ONLY in full mode (the learning loop)
    if (mode === 'full') {
      const stepRunDir = path.join(resultsBaseDir, 'results', `run-${String(step.step).padStart(3, '0')}`);
      const rejLogPath = path.join(stepRunDir, 'rejection-log.json');
      const promoted = promoteRejectionsIsolated(rejLogPath, correctionsLedgerPath);
      result.corrections_promoted = promoted;
    } else {
      result.corrections_promoted = 0;
      if (mode === 'no-corrections') {
        // Log that we skipped promotion for traceability
        const stepRunDir = path.join(resultsBaseDir, 'results', `run-${String(step.step).padStart(3, '0')}`);
        const rejLogPath = path.join(stepRunDir, 'rejection-log.json');
        if (fs.existsSync(rejLogPath)) {
          try {
            const rejections = JSON.parse(fs.readFileSync(rejLogPath, 'utf8'));
            const autoCommits = rejections.filter(r => r.corrections_ledger_action === 'auto_commit');
            if (autoCommits.length > 0) {
              log('no-corrections', `Skipped promotion of ${autoCommits.length} rejections (learning loop disabled)`);
            }
          } catch (e) {
            // Non-fatal — just skip the log
          }
        }
      }
    }

    // ── AD #14: Blind Auditor Trajectory Review ──────────────────────────
    if (mode === 'full') {
      try {
        const { runBlindAuditor, applyAuditorToOutput } = require('./blind-auditor');
        // Build history from accumulated stepResults (mimics 360-history.json)
        const auditHistory = stepResults.map(sr => ({
          timestamp: sr.completed_at || new Date().toISOString(),
          thesis_status: sr.thesis_status || null,
          confidence_in_status: sr.confidence_in_status || null,
          action_recommendation: sr.action_recommendation || sr.tactical_recommendation || null,
          tactical_recommendation: sr.tactical_recommendation || null,
          unresolved_tensions: sr.unresolved_tensions || [],
          bear_pressure_score: sr.final_bear_pressure || sr.bear_pressure || null,
          kill_switches: sr.kill_switches || [],
        }));
        const auditFindingsPath = path.join(resultsBaseDir, 'audit-findings.json');
        const auditLockPath = path.join(resultsBaseDir, 'auditor-state-lock.json');
        // Find most recent cognitive trace in the step's run directory
        const stepRunDir = path.join(resultsBaseDir, 'results', `run-${String(step.step).padStart(3, '0')}`);
        let auditTracePath = null;
        try {
          const traceFiles = fs.readdirSync(stepRunDir).filter(f => f.startsWith('cognitive-trace-') && f.endsWith('.json'));
          if (traceFiles.length > 0) {
            traceFiles.sort().reverse();
            auditTracePath = path.join(stepRunDir, traceFiles[0]);
          }
        } catch (e) { /* trace not available — auditor will use deterministic fallback */ }
        const auditorResult = await runBlindAuditor({
          history: auditHistory,
          currentOutput: result,
          domainConfig: domainConfig || {},
          runIndex: stepResults.length - 1,
          findingsPath: auditFindingsPath,
          lockPath: auditLockPath,
          cognitiveTracePath: auditTracePath,
        });
        // Attach auditor metadata to step result
        result.auditor_phase = auditorResult.phase;
        result.auditor_override = auditorResult.override || false;
        result.auditor_override_action = auditorResult.override_action || null;
        result.state_lock_active = auditorResult.state_lock_active || false;
        result.anomalies_triggered = auditorResult.anomalies_triggered || [];
        // If override, update the 360-report on disk
        if (auditorResult.override && auditorResult.override_action) {
          const stepRunDir = path.join(resultsBaseDir, 'results', `run-${String(step.step).padStart(3, '0')}`);
          const reportPath = path.join(stepRunDir, '360-report.json');
          if (fs.existsSync(reportPath)) {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            applyAuditorToOutput(report, auditorResult);
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            log('auditor', `Step ${step.step}: PHASE 2 OVERRIDE — action changed to ${auditorResult.override_action}`);
          }
          result.action_recommendation = auditorResult.override_action;
          result.tactical_recommendation = auditorResult.override_action;
        } else if (auditorResult.phase === 1) {
          log('auditor', `Step ${step.step}: Phase 1 advisory written. Next step Layer 4 must address.`);
        }
      // Re-write step-result.json with auditor metadata attached
        const stepResultDir = path.join(resultsBaseDir, 'results', `run-${String(step.step).padStart(3, '0')}`);
        const stepResultPath = path.join(stepResultDir, 'step-result.json');
        if (fs.existsSync(stepResultPath)) {
          fs.writeFileSync(stepResultPath, JSON.stringify(result, null, 2));
          log('auditor', `Step ${step.step}: step-result.json updated with auditor metadata`);
        }
      } catch (auditorErr) {
        warn('auditor', `Blind Auditor failed (non-fatal): ${auditorErr.message}`);
      }
    }

    // Brief pause between steps to respect API rate limits
    if (step !== scenario.time_steps[scenario.time_steps.length - 1]) {
      log('runner', 'Pausing 5s between steps...');
      await sleep(5000);
    }
  }

  // ── Build Summary ───────────────────────────────────────────────────────
  const summary = buildSummary(scenario, stepResults, mode);

  // Fill in final corrections ledger count
  if (correctionsLedgerPath && fs.existsSync(correctionsLedgerPath)) {
    try {
      const finalLedger = JSON.parse(fs.readFileSync(correctionsLedgerPath, 'utf8'));
      summary.corrections_ledger_final_count = finalLedger.length;
    } catch (e) {
      summary.corrections_ledger_final_count = 0;
    }
  } else {
    summary.corrections_ledger_final_count = 0;
  }

  // Write summary to mode-appropriate location
  const summaryPath = mode === 'full'
    ? path.join(resolvedDir, 'summary.json')
    : path.join(resultsBaseDir, 'summary.json');

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // ── Print Summary ───────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(60)}`);
  console.log('  EVOLUTION COMPLETE');
  console.log(`${'━'.repeat(60)}`);
  console.log(`  Scenario: ${scenario.display_name || scenario.name}`);
  console.log(`  Mode: ${mode}`);
  const completedCount = mode === 'raw-llm'
    ? stepResults.filter(r => r.layers_completed.includes('RAW_LLM')).length
    : stepResults.filter(r => r.layers_completed.length === 4).length;
  console.log(`  Steps completed: ${completedCount}/${scenario.time_steps.length}`);
  console.log(`  Thesis status progression:`);
  for (const r of stepResults) {
    const status = r.thesis_status || 'N/A';
    const confidence = r.confidence_in_status || 'N/A';
    const errNote = r.errors.length > 0 ? ` [ERRORS: ${r.errors.join(', ')}]` : '';
    console.log(`    Step ${r.step} (${r.label}): ${status} (confidence: ${confidence})${errNote}`);
  }
  console.log(`  Total corrections generated: ${stepResults.reduce((sum, r) => sum + r.corrections_promoted, 0)}`);
  console.log(`  Total rejections: ${stepResults.reduce((sum, r) => sum + (r.rejection_count || 0), 0)}`);
  console.log(`${'━'.repeat(60)}\n`);

  console.log(`Results written to: ${path.join(resultsBaseDir, 'results')}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Done: ${new Date().toISOString()}`);
}

// ─── Build Summary ──────────────────────────────────────────────────────────

function buildSummary(scenario, stepResults, mode) {
  const totalSteps = scenario.time_steps.length;

  const completedSteps = mode === 'raw-llm'
    ? stepResults.filter(r => r.layers_completed.includes('RAW_LLM')).length
    : stepResults.filter(r => r.layers_completed.length === 4).length;

  const failedSteps = stepResults.filter(r => r.errors.length > 0);

  // Thesis status progression
  const progression = stepResults.map(r => ({
    step: r.step,
    label: r.label,
    simulated_date: r.simulated_date,
    thesis_status: r.thesis_status,
    confidence: r.confidence_in_status,
    action: r.action_recommendation,
    bear_pressure: r.final_bear_pressure,
    rejection_count: r.rejection_count,
    corrections_promoted: r.corrections_promoted,
    gate_compliance: {
      layer1: r.gate_results?.layer1?.compliance || 'N/A',
      layer2: r.gate_results?.layer2?.compliance || 'N/A',
      layer3: r.gate_results?.layer3?.compliance || 'N/A',
      layer4: r.gate_results?.layer4?.compliance || 'N/A',
    },
    errors: r.errors,
  }));

  // Score against expected outcomes if provided
  let scoring = null;
  if (scenario.time_steps.some(s => s.expected_outcome)) {
    scoring = {
      method: scenario.scoring?.method || 'thesis_status_match',
      results: scenario.time_steps.map((step, i) => {
        const result = stepResults[i];
        const expected = step.expected_outcome;
        if (!expected) return { step: step.step, scoring: 'no_expectation' };

        const statusMatch = expected.thesis_status
          ? result?.thesis_status === expected.thesis_status
          : null;

        return {
          step: step.step,
          expected_status: expected.thesis_status || null,
          actual_status: result?.thesis_status || null,
          match: statusMatch,
          notes: expected.notes || null,
        };
      }),
    };
  }

  return {
    scenario_name: scenario.name,
    display_name: scenario.display_name || scenario.name,
    evolution_type: scenario.evolution_type || 'unknown',
    evolution_number: scenario.evolution_number || null,
    mode: mode || 'full',
    run_timestamp: new Date().toISOString(),
    total_steps: totalSteps,
    completed_steps: completedSteps,
    failed_steps: failedSteps.length,
    progression,
    scoring,
    corrections_ledger_final_count: null, // Filled below
    obscuration: scenario.obscuration || null,
  };
}

// ─── Entry Point ────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch(e => {
    console.error('\nFATAL:', e);
    process.exit(1);
  });
}

module.exports = {
  runTimeStep,
  runRawLLMStep,
  loadScenario,
  runStructuralTier1Checks,
  promoteRejectionsIsolated,
  buildSummary,
};
