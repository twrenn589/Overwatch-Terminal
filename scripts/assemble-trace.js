#!/usr/bin/env node
'use strict';

/**
 * Cognitive Trace Assembler — Loop 3: WHY
 *
 * Pure deterministic code. No AI judgment. Same inputs = same trace.
 *
 * Reads the raw layer outputs, gate review ledger, and rejection log
 * from a completed pipeline run. Produces a complete reasoning chain
 * for every signal — from Layer 1 perception through Layer 4 judgment.
 *
 * Input:
 *   data/360-report.json       — _layer1_raw, _layer2_raw, _layer3_raw, _layer4_raw, _pruned_signals
 *   data/gate-review-ledger.json — append-only ledger, last 4 entries (one per layer)
 *
 * Output:
 *   data/cognitive-trace-[timestamp].json
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const REPORT_PATH = path.join(DATA_DIR, '360-report.json');
const GATE_LEDGER = path.join(DATA_DIR, 'gate-review-ledger.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(label, msg) { console.log(`[trace-${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[trace-${label}] ⚠️ ${msg}`); }
function err(label, msg) { console.error(`[trace-${label}] 🚨 ${msg}`); }

/**
 * Check if a signal_id appears in an entry's signal_ids array.
 * Defensive: handles missing or malformed signal_ids.
 */
function entryContainsSignal(entry, signalId) {
  if (!entry || !Array.isArray(entry.signal_ids)) return false;
  return entry.signal_ids.includes(signalId);
}

/**
 * Pull the most recent gate entry for each layer (1-4) from the ledger.
 * Walks backwards from the end. Returns { 1: entry, 2: entry, 3: entry, 4: entry }.
 */
function getGateEntriesForCurrentRun(gateLedger) {
  const gates = {};
  // Walk backwards — most recent entries are at the end
  for (let i = gateLedger.length - 1; i >= 0; i--) {
    const entry = gateLedger[i];
    const layer = entry.layer;
    if (layer >= 1 && layer <= 4 && !gates[layer]) {
      gates[layer] = entry;
    }
    // Stop once we have all 4
    if (Object.keys(gates).length === 4) break;
  }
  return gates;
}

/**
 * Extract gate violations relevant to a specific signal_id.
 * Gate violations carry signal_ids arrays.
 */
function getGateViolationsForSignal(gateEntry, signalId) {
  if (!gateEntry || !gateEntry.gate_result || !Array.isArray(gateEntry.gate_result.violations)) {
    return { violations: [], compliance: gateEntry?.gate_result?.compliance || gateEntry?.compliance || 'UNKNOWN' };
  }
  const relevant = gateEntry.gate_result.violations.filter(v => {
    if (Array.isArray(v.signal_ids)) return v.signal_ids.includes(signalId);
    // If violation doesn't carry signal_ids, include it (pre-signal-id gate entries)
    return !v.signal_ids;
  });
  return {
    violations: relevant,
    compliance: gateEntry.gate_result.compliance || gateEntry.compliance || 'UNKNOWN',
    findings_reviewed: gateEntry.gate_result.findings_reviewed || 0
  };
}

// ─── Assembler ────────────────────────────────────────────────────────────────

function assembleTrace(options) {
  const opts = options || {};
  const reportPath = opts.reportPath || REPORT_PATH;
  const gateLedgerPath = opts.gateLedgerPath || GATE_LEDGER;
  const outputDir = opts.outputDir || DATA_DIR;

  log('init', '=== COGNITIVE TRACE ASSEMBLER ===');

  // ── Load 360 report ──
  if (!fs.existsSync(reportPath)) {
    err('init', '360-report.json not found — cannot assemble trace');
    return null;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const generatedAt = report._generated_at;
  if (!generatedAt) {
    err('init', '360-report.json missing _generated_at — cannot identify run');
    return null;
  }
  log('init', `Run timestamp: ${generatedAt}`);

  // ── Validate raw layer data exists ──
  const layer1 = report._layer1_raw;
  const layer2 = report._layer2_raw;
  const layer3 = report._layer3_raw;
  const layer4 = report._layer4_raw;

  if (!layer1 || !Array.isArray(layer1)) {
    err('init', '_layer1_raw missing or not an array — trace requires Layer 1 data');
    process.exit(1);
  }
  if (!layer2) { warn('init', '_layer2_raw missing — trace will have gaps'); }
  if (!layer3) { warn('init', '_layer3_raw missing — trace will have gaps'); }
  if (!layer4) { warn('init', '_layer4_raw missing — trace will have gaps'); }

  log('init', `Layer 1: ${layer1.length} signals`);
  if (layer2) log('init', `Layer 2: scored=${(layer2.scored_signals || []).length}, audit=${(layer2.knowledge_audit || []).length}`);
  if (layer3) log('init', `Layer 3: inferences=${(layer3.strategic_inferences || []).length}, hidden=${(layer3.hidden_moves || []).length}`);
  if (layer4) log('init', `Layer 4: matrix=${(layer4.final_signal_matrix || []).length}, rejections=${(layer4.rejection_log || []).length}`);

  // ── Load gate ledger ──
  let gates = {};
  if (fs.existsSync(gateLedgerPath)) {
    const gateLedger = JSON.parse(fs.readFileSync(gateLedgerPath, 'utf8'));
    gates = getGateEntriesForCurrentRun(gateLedger);
    const found = Object.keys(gates).length;
    log('init', `Gate ledger: found ${found}/4 gate entries for current run`);
    if (found < 4) {
      const missing = [1, 2, 3, 4].filter(n => !gates[n]);
      warn('init', `Missing gate entries for layer(s): ${missing.join(', ')}`);
    }
  } else {
    warn('init', 'gate-review-ledger.json not found — trace will lack gate data');
  }

  // ── Load pruned signals ──
  const prunedSignals = report._pruned_signals || [];
  if (prunedSignals.length > 0) {
    log('init', `Pruned signals: ${prunedSignals.length}`);
  }

  // ── Collect all signal IDs ──
  // Start with Layer 1 signals (these are the canonical set)
  // Also include pruned signals (they were perceived but dropped before Layer 2)
  const allSignalIds = [];

  for (const signal of layer1) {
    if (Array.isArray(signal.signal_ids) && signal.signal_ids[0]) {
      allSignalIds.push(signal.signal_ids[0]);
    }
  }
  for (const pruned of prunedSignals) {
    if (Array.isArray(pruned.signal_ids) && pruned.signal_ids[0]) {
      if (!allSignalIds.includes(pruned.signal_ids[0])) {
        allSignalIds.push(pruned.signal_ids[0]);
      }
    }
  }

  log('assemble', `Tracing ${allSignalIds.length} signals (${layer1.length} active + ${prunedSignals.length} pruned)`);

  // ── Build trace for each signal ──
  const trace = [];

  for (const sigId of allSignalIds) {

    // — Check if pruned —
    const prunedEntry = prunedSignals.find(p => entryContainsSignal(p, sigId));
    if (prunedEntry) {
      trace.push({
        signal_ids: [sigId],
        perception: {
          signal: prunedEntry.signal,
          severity: prunedEntry.severity,
          direction: prunedEntry.direction,
          category: prunedEntry.category,
          pruning_reason: prunedEntry.pruning_reason || 'below_top_15'
        },
        perception_gate: null,
        contextualization: null,
        contextualization_gate: null,
        inference: null,
        inference_gate: null,
        judgment: null,
        judgment_gate: null,
        corrections_applied: [],
        outcome: 'PRUNED'
      });
      continue;
    }

    // — Layer 1: Perception —
    const l1Signal = layer1.find(s => entryContainsSignal(s, sigId));
    const perception = l1Signal ? {
      signal: l1Signal.signal || l1Signal.threat,
      description: l1Signal.description,
      direction: l1Signal.direction,
      severity: l1Signal.severity,
      proximity: l1Signal.proximity,
      confidence: l1Signal.confidence,
      evidence: l1Signal.evidence,
      blind_spot: l1Signal.blind_spot,
      category: l1Signal.category
    } : null;

    // — Layer 1 Gate —
    const perceptionGate = getGateViolationsForSignal(gates[1], sigId);

    // — Layer 2: Contextualization —
    let contextualization = null;
    const correctionsApplied = [];

    if (layer2) {
      const auditEntry = (layer2.knowledge_audit || []).find(e => entryContainsSignal(e, sigId));
      const scoredEntry = (layer2.scored_signals || layer2.scored_threats || []).find(e => entryContainsSignal(e, sigId));
      const unscoredEntry = (layer2.unscored_signals || layer2.unscored_threats || []).find(e => entryContainsSignal(e, sigId));

      contextualization = {
        knowledge_audit: auditEntry ? {
          knowledge_check: auditEntry.knowledge_check,
          gap_identified: auditEntry.gap_identified,
          gap_type: auditEntry.gap_type,
          pre_audit_assessment: auditEntry.pre_audit_assessment,
          post_audit_assessment: auditEntry.post_audit_assessment,
          audit_impact: auditEntry.audit_impact,
          lesson_applied: auditEntry.lesson_applied,
          status: auditEntry.status
        } : null,
        scored: scoredEntry ? {
          severity: scoredEntry.severity,
          source_tier: scoredEntry.source_tier,
          weighted_severity: scoredEntry.weighted_severity,
          thesis_relevance: scoredEntry.thesis_relevance,
          confidence: scoredEntry.confidence,
          reasoning: scoredEntry.reasoning,
          knowledge_verified: scoredEntry.knowledge_verified
        } : null,
        unscored: unscoredEntry ? {
          reason: unscoredEntry.reason,
          knowledge_needed: unscoredEntry.knowledge_needed,
          acquisition_type: unscoredEntry.acquisition_type
        } : null
      };

      // Collect corrections that fired on this signal in Layer 2
      const l2Corrections = (layer2.corrections_referenced || []).filter(c => entryContainsSignal(c, sigId));
      for (const c of l2Corrections) {
        correctionsApplied.push({
          layer: 2,
          correction_id: c.correction_id,
          trigger_matched: c.trigger_matched,
          influence: c.influence_on_assessment
        });
      }
    }

    // — Layer 2 Gate —
    const contextualizationGate = getGateViolationsForSignal(gates[2], sigId);

    // — Layer 3: Inference —
    let inference = null;

    if (layer3) {
      // Find all inferences this signal contributed to
      const relatedInferences = (layer3.strategic_inferences || []).filter(inf => entryContainsSignal(inf, sigId));
      const relatedHidden = (layer3.hidden_moves || []).filter(hm => entryContainsSignal(hm, sigId));

      if (relatedInferences.length > 0 || relatedHidden.length > 0) {
        inference = {
          strategic_inferences: relatedInferences.map(inf => ({
            finding: inf.finding_from_layer2,
            null_hypothesis: inf.null_hypothesis,
            null_holds: inf.null_holds,
            which_is_more_likely: inf.which_is_more_likely,
            assumptions: inf.assumptions,
            assumption_count: inf.assumption_count,
            classification: inf.classification,
            expected_timeline: inf.expected_timeline,
            materialization_signal: inf.materialization_signal,
            confidence: inf.confidence,
            connected_signals: inf.signal_ids  // all signals that merged into this inference
          })),
          hidden_moves: relatedHidden.map(hm => ({
            player: hm.player,
            likely_action: hm.likely_action,
            assumption_count: hm.assumption_count,
            classification: hm.classification,
            confidence: hm.confidence,
            connected_signals: hm.signal_ids
          }))
        };
      }

      // Collect corrections that fired on this signal in Layer 3
      const l3Corrections = (layer3.corrections_referenced || []).filter(c => entryContainsSignal(c, sigId));
      for (const c of l3Corrections) {
        correctionsApplied.push({
          layer: 3,
          correction_id: c.correction_id,
          trigger_matched: c.trigger_matched,
          influence: c.influence_on_assessment
        });
      }
    }

    // — Layer 3 Gate —
    const inferenceGate = getGateViolationsForSignal(gates[3], sigId);

    // — Layer 4: Judgment —
    let judgment = null;
    let outcome = 'SURVIVED';  // default, may be overridden

    if (layer4) {
      // Check final signal matrix
      const matrixEntry = (layer4.final_signal_matrix || layer4.final_threat_matrix || []).find(e => entryContainsSignal(e, sigId));

      // Check burden of proof
      const bopEntry = (layer4.burden_of_proof_applied || []).find(e => entryContainsSignal(e, sigId));

      // Check rejection log
      const rejectionEntry = (layer4.rejection_log || []).find(e => entryContainsSignal(e, sigId));

      judgment = {
        final_signal_matrix: matrixEntry ? {
          signal: matrixEntry.signal,
          layer2_composite: matrixEntry.layer2_composite,
          layer3_adjustment: matrixEntry.layer3_adjustment,
          adjustment_direction: matrixEntry.adjustment_direction,
          final_composite: matrixEntry.final_composite,
          confidence: matrixEntry.confidence
        } : null,
        burden_of_proof: bopEntry ? {
          inference: bopEntry.inference,
          layer3_classification: bopEntry.layer3_classification,
          data_support: bopEntry.data_support,
          contradicts_data: bopEntry.contradicts_data,
          final_weight: bopEntry.final_weight,
          reasoning: bopEntry.reasoning
        } : null,
        rejection: rejectionEntry ? {
          layer3_inference: rejectionEntry.layer3_inference,
          rejection_reason: rejectionEntry.rejection_reason,
          root_cause: rejectionEntry.root_cause,
          confidence_in_rejection: rejectionEntry.confidence_in_rejection
        } : null
      };

      // Determine outcome
      // REJECTED: explicit overrule in rejection_log (feeds corrections ledger auto-commits)
      // STRIPPED: burden_of_proof final_weight is 'stripped' (removed from scoring, no formal rejection)
      // Edge case: final_weight 'rejected' without a rejection_log entry is a data integrity issue
      if (rejectionEntry) {
        outcome = 'REJECTED';
      } else if (bopEntry && bopEntry.final_weight === 'stripped') {
        outcome = 'STRIPPED';
      } else if (bopEntry && bopEntry.final_weight === 'rejected') {
        // final_weight says rejected but no rejection_log entry — Layer 4 compliance gap
        outcome = 'REJECTED';
        warn('outcome', `${sigId}: burden_of_proof says 'rejected' but no rejection_log entry — data integrity issue`);
      }
    }

    // — Layer 4 Gate —
    const judgmentGate = getGateViolationsForSignal(gates[4], sigId);

    // — Check for gate flags on survived signals —
    if (outcome === 'SURVIVED') {
      const allViolations = [
        ...perceptionGate.violations,
        ...contextualizationGate.violations,
        ...inferenceGate.violations,
        ...judgmentGate.violations
      ];
      if (allViolations.length > 0) {
        outcome = 'FLAGGED';
      }
    }

    // — Assemble the trace entry —
    trace.push({
      signal_ids: [sigId],
      perception,
      perception_gate: perceptionGate,
      contextualization,
      contextualization_gate: contextualizationGate,
      inference,
      inference_gate: inferenceGate,
      judgment,
      judgment_gate: judgmentGate,
      corrections_applied: correctionsApplied,
      outcome
    });
  }

  // ── Summary ──
  const outcomes = { SURVIVED: 0, REJECTED: 0, STRIPPED: 0, FLAGGED: 0, PRUNED: 0 };
  for (const entry of trace) {
    outcomes[entry.outcome] = (outcomes[entry.outcome] || 0) + 1;
  }
  log('summary', `Outcomes: ${JSON.stringify(outcomes)}`);

  // ── Write trace file ──
  // Timestamp format for filename: strip colons and periods for filesystem safety
  const tsForFile = generatedAt.replace(/[:.]/g, '-');
  const traceFilename = `cognitive-trace-${tsForFile}.json`;
  const tracePath = path.join(outputDir, traceFilename);

  const traceOutput = {
    _trace_version: '1.0',
    _assembled_at: new Date().toISOString(),
    _run_timestamp: generatedAt,
    _signal_count: trace.length,
    _outcomes: outcomes,
    signals: trace
  };

  fs.writeFileSync(tracePath, JSON.stringify(traceOutput, null, 2));
  log('io', `Wrote ${tracePath}`);
  log('io', `${trace.length} signals traced`);

  // ── Update trace index ──
  try {
    const traceFiles = fs.readdirSync(outputDir)
      .filter(f => f.startsWith('cognitive-trace-') && f.endsWith('.json'))
      .sort()
      .reverse();
    const index = traceFiles;
    fs.writeFileSync(path.join(outputDir, 'trace-index.json'), JSON.stringify(index, null, 2));
    log('io', `Updated trace-index.json: ${index.length} entries`);
  } catch (indexErr) {
    warn('io', `Failed to update trace-index.json (non-fatal): ${indexErr.message}`);
  }

  return traceOutput;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  assembleTrace();
}

module.exports = { assembleTrace };
