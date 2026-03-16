#!/usr/bin/env node
'use strict';

/**
 * Tier 1 Code Validators — Deterministic Layer Zero Enforcement
 *
 * Eight independent check functions, each enforcing one Layer Zero rule
 * that has a code-enforceable structural aspect. These run BEFORE the
 * AI gate (Tier 2) and produce a flag list that the gate receives.
 *
 * Architecture Decision #11: Two-Tier Enforcement Within the Gate
 *   Tier 1 — Code checks: Free, deterministic, instant.
 *   Tier 2 — AI gate: Receives output + code flags.
 *
 * Design: Modular composability (Strategy Pattern).
 *   - 8 utility functions that don't know what layer they're checking
 *   - 4 layer-specific routers that know which checks apply
 *   - 1 entry point for the pipeline orchestrator
 *
 * The Integrity Protocol (Patent Pending)
 */

// ─── Flag Builder ────────────────────────────────────────────────────────────

/**
 * Creates a standardized flag object.
 * @param {string} ruleId    — Layer Zero rule ID (e.g., 'LZ-EPH-003')
 * @param {string} finding   — Which specific finding triggered the flag
 * @param {string} detail    — What was found
 * @param {string} severity  — 'HARD_FAIL' (code fully enforces) or 'FLAG' (gate reviews)
 * @returns {object}
 */
function createFlag(ruleId, finding, detail, severity = 'FLAG') {
  return { rule_id: ruleId, finding, detail, severity, timestamp: new Date().toISOString() };
}

// ─── 8 Independent Check Functions ───────────────────────────────────────────

/**
 * LZ-EH-001: Multiple sources more reliable than single.
 * Counts evidence citations per finding. Flags findings with HIGH confidence
 * but only 0-1 citations. Calibration data — not pass/fail.
 *
 * @param {Array} findings — array of objects with evidence_citations and confidence fields
 * @param {string} findingNameField — which field contains the finding name (e.g., 'signal', 'finding_from_layer2')
 * @returns {Array} flags
 */
function checkCitationCount(findings, findingNameField = 'signal') {
  const flags = [];
  if (!Array.isArray(findings)) return flags;

  for (const f of findings) {
    const citations = Array.isArray(f.evidence_citations) ? f.evidence_citations : [];
    const confidence = (f.confidence || '').toLowerCase();
    const name = f[findingNameField] || 'unnamed finding';

    if (confidence === 'high' && citations.length <= 1) {
      flags.push(createFlag(
        'LZ-EH-001',
        name,
        `HIGH confidence with ${citations.length} citation(s). Multiple independent sources expected for high-confidence claims.`
      ));
    }
  }
  return flags;
}

/**
 * LZ-EH-004: Anomalous data should be treated as sensor failure first.
 * Flags input data values that appear anomalous: nulls in critical fields,
 * extreme outliers, or stale timestamps (>24h old).
 *
 * @param {object} inputData — dashboard-data.json contents
 * @returns {Array} flags
 */
function checkAnomalousInputData(inputData) {
  const flags = [];
  if (!inputData) return flags;

  // Check critical numeric fields for null/undefined
  const criticalPaths = [
    { path: 'xrp.price', label: 'XRP Price' },
    { path: 'macro.usd_jpy.value', label: 'USD/JPY' },
    { path: 'macro.jpn_10y.value', label: 'JGB 10Y' },
    { path: 'macro.fear_greed.value', label: 'Fear & Greed' },
    { path: 'macro.dxy.value', label: 'DXY' },
    { path: 'macro.sp500.value', label: 'S&P 500' },
  ];

  for (const { path, label } of criticalPaths) {
    const value = getNestedValue(inputData, path);
    if (value === null || value === undefined) {
      flags.push(createFlag(
        'LZ-EH-004',
        label,
        `Critical input data is null/missing. Any analysis referencing ${label} should treat this as a data gap, not assume a value.`
      ));
    }
  }

  // Check for extreme outliers in known ranges
  const rangeChecks = [
    { path: 'xrp.price', label: 'XRP Price', min: 0.01, max: 50 },
    { path: 'macro.usd_jpy.value', label: 'USD/JPY', min: 80, max: 200 },
    { path: 'macro.jpn_10y.value', label: 'JGB 10Y', min: -1, max: 5 },
    { path: 'macro.fear_greed.value', label: 'Fear & Greed', min: 0, max: 100 },
    { path: 'macro.dxy.value', label: 'DXY', min: 70, max: 130 },
  ];

  for (const { path, label, min, max } of rangeChecks) {
    const value = getNestedValue(inputData, path);
    if (typeof value === 'number' && (value < min || value > max)) {
      flags.push(createFlag(
        'LZ-EH-004',
        label,
        `Value ${value} is outside expected range [${min}-${max}]. Treat as potential measurement/source failure until independently verified.`
      ));
    }
  }

  // Check for stale timestamps (>24h old)
  const now = Date.now();
  const stalePaths = [
    { path: 'macro.brent_crude.updated', label: 'Brent Crude timestamp' },
    { path: 'macro.usd_jpy.updated', label: 'USD/JPY timestamp' },
    { path: 'macro.jpn_10y.updated', label: 'JGB 10Y timestamp' },
  ];

  for (const { path, label } of stalePaths) {
    const ts = getNestedValue(inputData, path);
    if (ts) {
      const age = now - new Date(ts).getTime();
      const hoursOld = age / (1000 * 60 * 60);
      if (hoursOld > 24) {
        flags.push(createFlag(
          'LZ-EH-004',
          label,
          `Data is ${Math.round(hoursOld)} hours old. Stale data should be flagged as a data gap, not treated as current.`
        ));
      }
    }
  }

  return flags;
}

/**
 * LZ-EH-005: Equal-weight contradictions must be flagged, not arbitrarily resolved.
 * Checks contradiction resolution structures for cases where contradictions
 * were resolved without noting independent tie-breaking evidence.
 *
 * @param {Array} contradictions — array of objects with resolution and reasoning fields
 * @returns {Array} flags
 */
function checkContradictionResolution(contradictions) {
  const flags = [];
  if (!Array.isArray(contradictions)) return flags;

  for (const c of contradictions) {
    const resolution = (c.resolution || '').toLowerCase();
    const reasoning = (c.reasoning || '').toLowerCase();
    const dataSays = c.data_says || 'unknown';

    // If resolved (not held as paradox) but reasoning is very short or
    // doesn't mention independent/additional/corroborating evidence
    if (resolution !== 'paradox_held' && reasoning.length < 50) {
      flags.push(createFlag(
        'LZ-EH-005',
        `Contradiction: ${dataSays.substring(0, 80)}`,
        `Contradiction resolved as "${resolution}" with brief reasoning (${reasoning.length} chars). Verify independent tie-breaking evidence was used, not arbitrary preference.`
      ));
    }
  }
  return flags;
}

/**
 * LZ-RC-004: Simplest explanation must be tested first.
 * Checks that null_hypothesis fields exist and are populated in inferences.
 *
 * @param {Array} inferences — array of objects with null_hypothesis and null_holds fields
 * @returns {Array} flags
 */
function checkNullHypothesisPresence(inferences) {
  const flags = [];
  if (!Array.isArray(inferences)) return flags;

  for (const inf of inferences) {
    const name = inf.finding_from_layer2 || inf.inference || 'unnamed inference';
    const nullHyp = inf.null_hypothesis;
    const nullHolds = inf.null_holds;

    if (!nullHyp || (typeof nullHyp === 'string' && nullHyp.trim().length === 0)) {
      flags.push(createFlag(
        'LZ-RC-004',
        name,
        'null_hypothesis field is missing or empty. The simplest explanation must be tested before more complex alternatives.'
      ));
    }

    if (nullHolds === undefined || nullHolds === null) {
      flags.push(createFlag(
        'LZ-RC-004',
        name,
        'null_holds field is missing. Must explicitly declare whether the null hypothesis is sufficient.'
      ));
    }
  }
  return flags;
}

/**
 * LZ-MR-003: Simultaneous vs staggered measurement.
 * Flags temporal gaps between input data source timestamps.
 * Requires the input data (dashboard-data.json), not the layer output.
 *
 * @param {object} inputData — dashboard-data.json contents
 * @param {number} maxGapHours — maximum acceptable gap between data sources (default: 6)
 * @returns {Array} flags
 */
function checkTemporalGaps(inputData, maxGapHours = 6) {
  const flags = [];
  if (!inputData) return flags;

  const timestampPaths = [
    { path: 'macro.brent_crude.updated', label: 'Brent Crude' },
    { path: 'macro.usd_jpy.updated', label: 'USD/JPY' },
    { path: 'macro.jpn_10y.updated', label: 'JGB 10Y' },
    { path: 'macro.dxy.updated', label: 'DXY' },
    { path: 'macro.sp500.updated', label: 'S&P 500' },
    { path: 'xrp.updated', label: 'XRP' },
    { path: 'rlusd.updated', label: 'RLUSD' },
  ];

  const timestamps = [];
  for (const { path, label } of timestampPaths) {
    const ts = getNestedValue(inputData, path);
    if (ts) {
      const ms = new Date(ts).getTime();
      if (!isNaN(ms)) {
        timestamps.push({ label, ms });
      }
    }
  }

  if (timestamps.length < 2) return flags;

  // Find the max gap between any two data sources
  const sorted = timestamps.sort((a, b) => a.ms - b.ms);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const gapHours = (newest.ms - oldest.ms) / (1000 * 60 * 60);

  if (gapHours > maxGapHours) {
    flags.push(createFlag(
      'LZ-MR-003',
      `${oldest.label} vs ${newest.label}`,
      `${Math.round(gapHours)} hour gap between oldest (${oldest.label}) and newest (${newest.label}) data sources. Staggered measurement introduces temporal distortion. Compound stress assessment should note this explicitly.`
    ));
  }

  return flags;
}

/**
 * LZ-EPH-001: "I don't know" is a high-quality output.
 * Flags outputs where every finding has HIGH confidence and zero knowledge gaps.
 * Suspiciously perfect output suggests the model isn't admitting uncertainty.
 *
 * @param {object} layerOutput — full layer output object
 * @param {string} layerName — which layer for the flag message
 * @returns {Array} flags
 */
function checkZeroGapOutput(layerOutput, layerName) {
  const flags = [];
  if (!layerOutput) return flags;

  // Check scored signals (Layer 2)
  const scored = layerOutput.scored_signals;
  if (Array.isArray(scored) && scored.length > 0) {
    const allHigh = scored.every(t => (t.confidence || '').toUpperCase() === 'HIGH');
    const unscored = layerOutput.unscored_signals;
    const noGaps = !Array.isArray(unscored) || unscored.length === 0;
    const knowledgeAudit = layerOutput.knowledge_audit;
    const noKnowledgeGaps = !Array.isArray(knowledgeAudit) ||
      knowledgeAudit.every(k => (k.gap_identified || '').toUpperCase() === 'NONE' || k.gap_identified === '');

    if (allHigh && noGaps && noKnowledgeGaps && scored.length >= 5) {
      flags.push(createFlag(
        'LZ-EPH-001',
        `${layerName} output`,
        `All ${scored.length} signals scored HIGH confidence with zero knowledge gaps and zero unscored signals. Suspiciously perfect — verify the model is admitting uncertainty where warranted.`
      ));
    }
  }

  // Check strategic inferences (Layer 3)
  const inferences = layerOutput.strategic_inferences;
  if (Array.isArray(inferences) && inferences.length > 0) {
    const allHigh = inferences.every(i => (i.confidence || '').toLowerCase() === 'high');
    const noNull = inferences.every(i => i.null_holds === false);
    const noInsufficient = inferences.every(i => (i.classification || '') !== 'INSUFFICIENT_EVIDENCE');

    if (allHigh && noNull && noInsufficient && inferences.length >= 5) {
      flags.push(createFlag(
        'LZ-EPH-001',
        `${layerName} output`,
        `All ${inferences.length} inferences are HIGH confidence, no null hypotheses held, no insufficient evidence. Suspiciously zero-gap — verify epistemic honesty.`
      ));
    }
  }

  return flags;
}

/**
 * LZ-EPH-002: Confidence must be proportional to evidence.
 * Checks the ratio of confidence level to evidence citation count.
 * HIGH confidence with 0-1 citations is a flag.
 *
 * @param {Array} findings — array of objects with confidence and evidence_citations
 * @param {string} findingNameField — field name for the finding identifier
 * @returns {Array} flags
 */
function checkConfidenceEvidenceRatio(findings, findingNameField = 'signal') {
  const flags = [];
  if (!Array.isArray(findings)) return flags;

  for (const f of findings) {
    const confidence = (f.confidence || '').toLowerCase();
    const citations = Array.isArray(f.evidence_citations) ? f.evidence_citations.length : 0;
    const name = f[findingNameField] || 'unnamed finding';

    // HIGH confidence should have 2+ citations
    if (confidence === 'high' && citations < 2) {
      flags.push(createFlag(
        'LZ-EPH-002',
        name,
        `HIGH confidence with ${citations} evidence citation(s). Confidence must be proportional to evidence — high confidence requires multiple independent sources.`
      ));
    }

    // MEDIUM confidence with 0 citations is also concerning
    if (confidence === 'medium' && citations === 0) {
      flags.push(createFlag(
        'LZ-EPH-002',
        name,
        `MEDIUM confidence with zero evidence citations. Even moderate confidence should reference verifiable evidence.`
      ));
    }
  }
  return flags;
}

/**
 * LZ-EPH-003: 3+ assumptions = SPECULATIVE. FULL ENFORCEMENT.
 * If assumption_count >= 3 and classification is not SPECULATIVE, this is a HARD FAIL.
 * This is the only rule the code enforces completely — no gate review needed.
 *
 * @param {Array} inferences — array of objects with assumption_count and classification
 * @param {string} findingNameField — field name for the finding identifier
 * @returns {Array} flags
 */
function checkAssumptionLimit(inferences, findingNameField = 'finding_from_layer2') {
  const flags = [];
  if (!Array.isArray(inferences)) return flags;

  for (const inf of inferences) {
    const count = inf.assumption_count;
    const classification = (inf.classification || '').toUpperCase();
    const name = inf[findingNameField] || inf.player || 'unnamed inference';

    if (typeof count !== 'number') {
      flags.push(createFlag(
        'LZ-EPH-003',
        name,
        'assumption_count is missing or not a number. Cannot verify speculation cap.',
        'FLAG'
      ));
      continue;
    }

    // FULL ENFORCEMENT: 3+ assumptions MUST be classified SPECULATIVE
    if (count >= 3 && classification !== 'SPECULATIVE') {
      flags.push(createFlag(
        'LZ-EPH-003',
        name,
        `assumption_count is ${count} but classification is "${classification}" (should be SPECULATIVE). This is a structural violation — 3+ unproven assumptions MUST be classified SPECULATIVE regardless of plausibility.`,
        'HARD_FAIL'
      ));
    }

    // Verify assumption count matches assumptions array length if both present
    const assumptions = inf.assumptions;
    if (Array.isArray(assumptions) && assumptions.length !== count) {
      flags.push(createFlag(
        'LZ-EPH-003',
        name,
        `assumption_count is ${count} but assumptions array has ${assumptions.length} entries. Miscount detected.`,
        'FLAG'
      ));
    }
  }
  return flags;
}

// ─── Helper: safely traverse nested object paths ─────────────────────────────

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}

// ─── 4 Layer-Specific Routers ────────────────────────────────────────────────

/**
 * Layer 1 (SWEEP) validator.
 * Layer 1 is raw intake — minimal code checks apply.
 * Main concern: input data quality.
 *
 * @param {Array}  output    — Layer 1 signal array
 * @param {object} inputData — dashboard-data.json
 * @returns {Array} flags
 */
function validateLayer1(output, inputData) {
  const flags = [];

  // LZ-EH-004: Check input data for anomalies
  flags.push(...checkAnomalousInputData(inputData));

  // LZ-MR-003: Check temporal gaps in input data
  flags.push(...checkTemporalGaps(inputData));

  return flags;
}

/**
 * Layer 2 (CONTEXTUALIZE) validator.
 * Knowledge audit + contextual scoring. Checks scored signals for
 * confidence-evidence calibration and zero-gap suspicion.
 *
 * @param {object} output    — Layer 2 output object
 * @param {object} inputData — dashboard-data.json
 * @returns {Array} flags
 */
function validateLayer2(output, inputData) {
  const flags = [];

  // LZ-EH-004: Check input data for anomalies
  flags.push(...checkAnomalousInputData(inputData));

  // LZ-MR-003: Check temporal gaps in input data
  flags.push(...checkTemporalGaps(inputData));

  // LZ-EH-005: Check contradiction handling (if Layer 2 reports any)
  if (output.contradictions) {
    flags.push(...checkContradictionResolution(output.contradictions));
  }

  // LZ-EPH-001: Check for suspiciously zero-gap output
  flags.push(...checkZeroGapOutput(output, 'Layer 2'));

  // LZ-EPH-002: Check confidence-to-evidence ratio on scored signals
  // Layer 2 scored_signals may not have evidence_citations (that's Layer 3),
  // but if they do, check them
  if (Array.isArray(output.scored_signals)) {
    const withCitations = output.scored_signals.filter(t => Array.isArray(t.evidence_citations));
    if (withCitations.length > 0) {
      flags.push(...checkConfidenceEvidenceRatio(withCitations, 'signal'));
    }
  }

  return flags;
}

/**
 * Layer 3 (INFER) validator.
 * Game theory with circuit breakers. This is where most code checks fire:
 * null hypothesis, assumption count, citation count, confidence ratio.
 *
 * @param {object} output    — Layer 3 output object
 * @param {object} inputData — dashboard-data.json (passed through for completeness)
 * @returns {Array} flags
 */
function validateLayer3(output, inputData) {
  const flags = [];

  // LZ-EH-001: Citation count on strategic inferences
  if (Array.isArray(output.strategic_inferences)) {
    flags.push(...checkCitationCount(output.strategic_inferences, 'finding_from_layer2'));
  }

  // LZ-RC-004: Null hypothesis presence on strategic inferences
  if (Array.isArray(output.strategic_inferences)) {
    flags.push(...checkNullHypothesisPresence(output.strategic_inferences));
  }

  // LZ-EPH-001: Suspiciously zero-gap output
  flags.push(...checkZeroGapOutput(output, 'Layer 3'));

  // LZ-EPH-002: Confidence-to-evidence ratio on strategic inferences
  if (Array.isArray(output.strategic_inferences)) {
    flags.push(...checkConfidenceEvidenceRatio(output.strategic_inferences, 'finding_from_layer2'));
  }

  // LZ-EPH-003: FULL ENFORCEMENT — assumption count on strategic inferences
  if (Array.isArray(output.strategic_inferences)) {
    flags.push(...checkAssumptionLimit(output.strategic_inferences, 'finding_from_layer2'));
  }

  // LZ-EPH-003: Also check hidden_moves (they have assumption_count too)
  if (Array.isArray(output.hidden_moves)) {
    flags.push(...checkAssumptionLimit(output.hidden_moves, 'player'));
  }

  return flags;
}

/**
 * Layer 4 (RECONCILE) validator.
 * Final judgment. Checks burden of proof application and contradiction resolution.
 *
 * @param {object} output    — Layer 4 output object
 * @param {object} inputData — dashboard-data.json (passed through for completeness)
 * @returns {Array} flags
 */
function validateLayer4(output, inputData, domainConfig) {
  const flags = [];

  // LZ-EH-005: Check contradiction resolution
  if (Array.isArray(output.contradictions_resolved)) {
    flags.push(...checkContradictionResolution(output.contradictions_resolved));
  }

  // LZ-EPH-001: Suspiciously zero-gap output
  flags.push(...checkZeroGapOutput(output, 'Layer 4'));

  // LZ-EPH-002: Check if burden of proof was actually applied meaningfully
  // If every inference got "full" weight, that's suspicious
  if (Array.isArray(output.burden_of_proof_applied)) {
    const allFull = output.burden_of_proof_applied.every(b => b.final_weight === 'full');
    if (allFull && output.burden_of_proof_applied.length >= 5) {
      flags.push(createFlag(
        'LZ-EPH-002',
        'Burden of Proof',
        `All ${output.burden_of_proof_applied.length} inferences received full weight. No skeptic discount, no stripping, no rejection. Verify that burden of proof was applied with genuine skepticism, not rubber-stamped.`
      ));
    }
  }

  // AD #14: Tension impact_score validation
  if (Array.isArray(output.active_tensions)) {
    for (const tension of output.active_tensions) {
      if (tension.impact_score === undefined || tension.impact_score === null) {
        flags.push(createFlag(
          'AD14-TENSION-NO-SCORE',
          `Tension: ${(tension.description || 'unnamed').substring(0, 80)}`,
          'unresolved_tension is missing impact_score. Each tension must declare its materiality (1-5).'
        ));
      } else if (!Number.isInteger(tension.impact_score) || tension.impact_score < 1 || tension.impact_score > 5) {
        flags.push(createFlag(
          'AD14-TENSION-INVALID-SCORE',
          `Tension: ${(tension.description || 'unnamed').substring(0, 80)}`,
          `impact_score is ${tension.impact_score} — must be an integer 1-5.`
        ));
      }
    }
  }

  // AD #15: Tension lifecycle structural checks
  const tensionCap = (domainConfig && domainConfig.active_tension_cap) || 8;

  // Cap enforcement
  if (Array.isArray(output.active_tensions) && output.active_tensions.length > tensionCap) {
    flags.push(createFlag(
      'AD15-TENSION-CAP-EXCEEDED',
      'Tension Lifecycle',
      `${output.active_tensions.length} active tensions exceeds cap of ${tensionCap}. Layer 4 must prioritize and displace.`,
      'HARD_FAIL'
    ));
  }

  // Tension ID format and uniqueness
  if (Array.isArray(output.active_tensions)) {
    const ids = output.active_tensions.map(t => t.tension_id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      flags.push(createFlag(
        'AD15-TENSION-ID-COLLISION',
        'Tension Lifecycle',
        `Duplicate tension_id(s): ${dupes.join(', ')}. Each active tension must have a unique ID.`,
        'HARD_FAIL'
      ));
    }
  }

  // Classification validation
  if (Array.isArray(output.active_tensions)) {
    for (const t of output.active_tensions) {
      if (t.classification && t.classification !== 'ACTIVE') {
        flags.push(createFlag(
          'AD15-WRONG-CLASSIFICATION',
          `Tension ${t.tension_id || 'unknown'}`,
          `Active tension has classification "${t.classification}" — must be "ACTIVE". Structural gaps belong in structural_gaps array.`,
          'HARD_FAIL'
        ));
      }
    }
  }

  // Disposition validation for previous tensions
  if (Array.isArray(output.previous_tension_dispositions)) {
    const validDispositions = ['RESOLVE', 'MAINTAIN', 'ESCALATE', 'DISPLACE'];
    for (const d of output.previous_tension_dispositions) {
      if (!d.disposition || !validDispositions.includes(d.disposition)) {
        flags.push(createFlag(
          'AD15-INVALID-DISPOSITION',
          `Tension ${d.tension_id || 'unknown'}`,
          `Disposition "${d.disposition}" is invalid. Must be one of: ${validDispositions.join(', ')}.`,
          'HARD_FAIL'
        ));
      }
      if (!d.disposition_reason || d.disposition_reason.trim() === '') {
        flags.push(createFlag(
          'AD15-DISPOSITION-NO-REASONING',
          `Tension ${d.tension_id || 'unknown'}`,
          'Disposition has no reasoning. Every disposition is a judgment that must be justified.'
        ));
      }
      if (d.disposition === 'DISPLACE' && !d.displaced_by) {
        flags.push(createFlag(
          'AD15-DISPLACE-NO-REFERENCE',
          `Tension ${d.tension_id || 'unknown'}`,
          'DISPLACE disposition must reference displaced_by with the tension_id of the new tension that replaced it.',
          'HARD_FAIL'
        ));
      }
    }
  }

  // Resolution window validation
  if (Array.isArray(output.active_tensions)) {
    const validWindows = ['hours', 'days', 'weeks', 'months'];
    const validWindowStatus = ['within', 'approaching', 'expired', 'extended'];
    for (const t of output.active_tensions) {
      if (t.expected_resolution_window && !validWindows.includes(t.expected_resolution_window)) {
        flags.push(createFlag(
          'AD15-INVALID-WINDOW',
          `Tension ${t.tension_id || 'unknown'}`,
          `expected_resolution_window "${t.expected_resolution_window}" is invalid. Must be: ${validWindows.join(', ')}.`
        ));
      }
      if (t.window_status && !validWindowStatus.includes(t.window_status)) {
        flags.push(createFlag(
          'AD15-INVALID-WINDOW-STATUS',
          `Tension ${t.tension_id || 'unknown'}`,
          `window_status "${t.window_status}" is invalid. Must be: ${validWindowStatus.join(', ')}.`
        ));
      }
    }
  }

  // Thesis status enum validation
  const VALID_THESIS_STATUSES = ['STRENGTHENING', 'STABLE', 'WEAKENING', 'CONTESTED', 'INSUFFICIENT_EVIDENCE', 'FALSIFIED'];
  if (output.thesis_status && !VALID_THESIS_STATUSES.includes(output.thesis_status)) {
    flags.push(createFlag(
      'LZ-THESIS-STATUS-INVALID',
      'Thesis Status',
      `thesis_status "${output.thesis_status}" is not a valid enum value. Must be one of: ${VALID_THESIS_STATUSES.join(', ')}.`,
      'HARD_FAIL'
    ));
  }

  // FALSIFIED requires action_severe — no exceptions
  if (output.thesis_status === 'FALSIFIED') {
    const actionSevere = (domainConfig && domainConfig.action_severe) || 'EXIT_SIGNAL';
    const action = output.action_recommendation || output.tactical_recommendation;
    if (action !== actionSevere) {
      flags.push(createFlag(
        'LZ-FALSIFIED-ACTION-MISMATCH',
        'FALSIFIED Status',
        `thesis_status is FALSIFIED but action_recommendation is "${action}" — must be ${actionSevere}. FALSIFIED is terminal.`,
        'HARD_FAIL'
      ));
    }
  }

  // AD #14: Auditor override consistency check
  if (output.auditor_override === true) {
    if (!output.state_lock_active) {
      flags.push(createFlag(
        'AD14-OVERRIDE-NO-LOCK',
        'Auditor Override',
        'auditor_override is true but state_lock_active is false. A Phase 2 override must always activate the state-lock.',
        'HARD_FAIL'
      ));
    }
    if (!output.auditor_override_reasoning || output.auditor_override_reasoning.trim() === '') {
      flags.push(createFlag(
        'AD14-OVERRIDE-NO-REASONING',
        'Auditor Override',
        'auditor_override is true but auditor_override_reasoning is empty. Every override must include the Auditor reasoning.',
        'HARD_FAIL'
      ));
    }
  }

  return flags;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Run Tier 1 deterministic code checks for a given layer.
 * Called by the pipeline orchestrator before the AI gate (Tier 2).
 *
 * @param {number} layerNumber — 1, 2, 3, or 4
 * @param {*}      output      — the layer's JSON output
 * @param {object} inputData   — dashboard-data.json (for input quality checks)
 * @returns {object} { flags: Array, hard_fails: number, total_flags: number, layer: number }
 */
function runTier1Checks(layerNumber, output, inputData, domainConfig) {
  let flags = [];

  switch (layerNumber) {
    case 1: flags = validateLayer1(output, inputData); break;
    case 2: flags = validateLayer2(output, inputData); break;
    case 3: flags = validateLayer3(output, inputData); break;
    case 4: flags = validateLayer4(output, inputData, domainConfig); break;
    default:
      console.error(`[tier1] Unknown layer number: ${layerNumber}`);
      return { flags: [], hard_fails: 0, total_flags: 0, layer: layerNumber };
  }

  const hardFails = flags.filter(f => f.severity === 'HARD_FAIL').length;
  const totalFlags = flags.length;

  if (totalFlags > 0) {
    console.log(`[tier1] Layer ${layerNumber}: ${totalFlags} flag(s) (${hardFails} HARD_FAIL)`);
    for (const f of flags) {
      const prefix = f.severity === 'HARD_FAIL' ? '🚨' : '⚠️';
      console.log(`[tier1]   ${prefix} ${f.rule_id}: ${f.finding} — ${f.detail.substring(0, 120)}`);
    }
  } else {
    console.log(`[tier1] Layer ${layerNumber}: clean — no flags`);
  }

  return {
    flags,
    hard_fails: hardFails,
    total_flags: totalFlags,
    layer: layerNumber
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  runTier1Checks,

  // Export individual checks for testing and Evolution Library
  checkCitationCount,
  checkAnomalousInputData,
  checkContradictionResolution,
  checkNullHypothesisPresence,
  checkTemporalGaps,
  checkZeroGapOutput,
  checkConfidenceEvidenceRatio,
  checkAssumptionLimit,

  // Export layer validators for direct use
  validateLayer1,
  validateLayer2,
  validateLayer3,
  validateLayer4,
};
