#!/usr/bin/env node
'use strict';

/**
 * x402 Spending Behavioral Pattern Detectors
 * Architecture Decision: x402 Cognitive Guardrail
 *
 * Seven deterministic detectors that identify spending patterns.
 * These are Layer A triggers — they wake the Blind Auditor (Gemini)
 * to make the judgment call. They do not make decisions.
 *
 * Each detector returns a finding object or null.
 * The wrapper aggregates all findings for the auditor.
 *
 * Domain-agnostic. Pure deterministic code. No AI calls.
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

/**
 * Load thresholds from domain config with defaults.
 */
function getThresholds(domainConfig) {
  const t = (domainConfig && domainConfig.x402_spending_thresholds) || {};
  return {
    reactiveMinRequests:          t.reactive_min_requests || 5,
    reactiveSurvivalFloor:        t.reactive_survival_rate_floor || 0.3,
    avoidanceDenialCeiling:       t.avoidance_denial_rate_ceiling || 0.7,
    confirmationImbalance:        t.confirmation_vector_imbalance || 0.75,
    exhaustionUnfilledCritical:   t.budget_exhaustion_unfilled_critical || 2,
    staleRepeatMin:               t.stale_repeat_min_occurrences || 3,
    bleedingImpactFloor:          t.bleeding_impact_ratio_floor || 0.3,
    hoardingMinUnspentPct:        t.hoarding_min_unspent_pct || 0.5,
    hoardingMinCriticalTensions:  t.hoarding_min_critical_tensions || 1,
  };
}

// ─── Detector 1: Reactive Acquisition ──────────────────────────────────────

/**
 * High purchase volume with low pipeline survival rate.
 * The system buys frequently but purchased data consistently gets
 * stripped by the burden of proof. Spending to feel busy, not to learn.
 *
 * @param {object} paperTradeLog — the full paper trade log
 * @param {object} traceData     — latest cognitive trace (for survival)
 * @param {object} thresholds    — from domain config
 * @returns {object|null}
 */
function detectReactiveAcquisition(paperTradeLog, traceData, thresholds) {
  const approved = (paperTradeLog.requests || []).filter(r => r.disposition === 'APPROVED');
  if (approved.length < thresholds.reactiveMinRequests) return null;

  // Count survival from trace tags
  const traced = (traceData && traceData.signals || []).filter(s => s.acquisition_source === 'x402');
  if (traced.length === 0) return null;

  const survived = traced.filter(s => s.acquisition_survival === 'survived').length;
  const survivalRate = survived / traced.length;

  if (survivalRate < thresholds.reactiveSurvivalFloor) {
    return {
      type: 'X402_REACTIVE_ACQUISITION',
      detail: `${traced.length} x402-tagged signals in trace, ${survived} survived (${(survivalRate * 100).toFixed(0)}% survival rate, floor: ${(thresholds.reactiveSurvivalFloor * 100).toFixed(0)}%). Purchased data consistently stripped by burden of proof.`,
      severity: survivalRate < thresholds.reactiveSurvivalFloor / 2 ? 'HIGH' : 'MEDIUM',
      survival_rate: survivalRate,
      total_tagged: traced.length,
      total_survived: survived,
    };
  }
  return null;
}

// ─── Detector 2: Avoidance Spending ────────────────────────────────────────

/**
 * Low purchase volume with high denial rate, while persistent data gaps
 * cause analytical errors. Hoarding budget rather than filling gaps.
 *
 * @param {object} paperTradeLog
 * @param {Array}  currentTensions — active tensions from latest run
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectAvoidanceSpending(paperTradeLog, currentTensions, thresholds) {
  const requests = paperTradeLog.requests || [];
  if (requests.length < 3) return null;

  const denied = requests.filter(r => r.disposition === 'DENIED').length;
  const denialRate = denied / requests.length;

  // Are there critical tensions that could have acquisition paths?
  const criticalUnresolved = (currentTensions || []).filter(
    t => t.impact_score >= 4 && t.watch_for
  );

  if (denialRate > thresholds.avoidanceDenialCeiling && criticalUnresolved.length > 0) {
    return {
      type: 'X402_AVOIDANCE_SPENDING',
      detail: `${(denialRate * 100).toFixed(0)}% denial rate (${denied}/${requests.length} requests) while ${criticalUnresolved.length} critical tension(s) with observable resolution paths remain unresolved. Budget hoarded rather than deployed against risk.`,
      severity: 'HIGH',
      denial_rate: denialRate,
      critical_unresolved: criticalUnresolved.map(t => t.tension_id || 'unknown'),
    };
  }
  return null;
}

// ─── Detector 3: Confirmation Acquisition ──────────────────────────────────

/**
 * Preferentially purchasing data that confirms current thesis_status
 * while denying purchases that might challenge it.
 * Detected via intended epistemic vector ratios — arithmetic, not judgment.
 *
 * @param {object} paperTradeLog
 * @param {string} currentThesisStatus — from latest run
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectConfirmationAcquisition(paperTradeLog, currentThesisStatus, thresholds) {
  const approved = (paperTradeLog.requests || []).filter(r => r.disposition === 'APPROVED');
  if (approved.length < 4) return null;

  const strengthen = approved.filter(r => r.intended_epistemic_vector === 'STRENGTHEN').length;
  const weaken = approved.filter(r => r.intended_epistemic_vector === 'WEAKEN').length;
  const total = strengthen + weaken;
  if (total === 0) return null;

  // Check for directional imbalance
  const strengthenRatio = strengthen / total;
  const weakenRatio = weaken / total;

  // If thesis is STABLE or CONTESTED but most spending targets one direction
  const neutralStatuses = ['STABLE', 'CONTESTED', 'INSUFFICIENT_EVIDENCE'];
  const isNeutral = neutralStatuses.includes(currentThesisStatus);

  if (isNeutral && (strengthenRatio > thresholds.confirmationImbalance || weakenRatio > thresholds.confirmationImbalance)) {
    const biasDirection = strengthenRatio > weakenRatio ? 'STRENGTHEN' : 'WEAKEN';
    const biasRatio = Math.max(strengthenRatio, weakenRatio);
    return {
      type: 'X402_CONFIRMATION_ACQUISITION',
      detail: `thesis_status is ${currentThesisStatus} but ${(biasRatio * 100).toFixed(0)}% of approved acquisitions target ${biasDirection} (${strengthen} STRENGTHEN, ${weaken} WEAKEN). Spending intent is directionally biased.`,
      severity: biasRatio > 0.9 ? 'HIGH' : 'MEDIUM',
      bias_direction: biasDirection,
      bias_ratio: biasRatio,
      thesis_status: currentThesisStatus,
    };
  }

  // If thesis is WEAKENING but most spending targets STRENGTHEN (or vice versa)
  if (currentThesisStatus === 'WEAKENING' && strengthenRatio > thresholds.confirmationImbalance) {
    return {
      type: 'X402_CONFIRMATION_ACQUISITION',
      detail: `thesis_status is WEAKENING but ${(strengthenRatio * 100).toFixed(0)}% of approved acquisitions target STRENGTHEN. System may be buying comfort rather than truth.`,
      severity: 'HIGH',
      bias_direction: 'STRENGTHEN',
      bias_ratio: strengthenRatio,
      thesis_status: currentThesisStatus,
    };
  }
  if (currentThesisStatus === 'STRENGTHENING' && weakenRatio > thresholds.confirmationImbalance) {
    return {
      type: 'X402_CONFIRMATION_ACQUISITION',
      detail: `thesis_status is STRENGTHENING but ${(weakenRatio * 100).toFixed(0)}% of approved acquisitions target WEAKEN. System may be buying doubt rather than following evidence.`,
      severity: 'MEDIUM',
      bias_direction: 'WEAKEN',
      bias_ratio: weakenRatio,
      thesis_status: currentThesisStatus,
    };
  }

  return null;
}

// ─── Detector 4: Budget Exhaustion with Unfilled Critical Gaps ─────────────

/**
 * Budget spent on low-impact purchases before reaching high-impact gaps.
 * Priority ordering of purchases did not match impact ordering.
 *
 * @param {object} paperTradeLog
 * @param {Array}  currentTensions
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectBudgetExhaustion(paperTradeLog, currentTensions, thresholds) {
  const budget = paperTradeLog.budget || {};
  const cycleLimit = budget.cycle_limit_drops || 5000;
  const cycleSpent = budget.cycle_spent_drops || 0;

  // Is budget exhausted or near-exhausted?
  if (cycleSpent < cycleLimit * 0.8) return null;

  // Are there critical unfilled gaps?
  const criticalUnresolved = (currentTensions || []).filter(t => t.impact_score >= 4);
  const approved = (paperTradeLog.requests || []).filter(r => r.disposition === 'APPROVED');
  const lowImpactApproved = approved.filter(r => (r.expected_impact_score || 0) <= 2);

  if (criticalUnresolved.length >= thresholds.exhaustionUnfilledCritical && lowImpactApproved.length > 0) {
    return {
      type: 'X402_BUDGET_EXHAUSTION_UNFILLED_GAPS',
      detail: `Budget ${(cycleSpent / cycleLimit * 100).toFixed(0)}% spent. ${lowImpactApproved.length} low-impact purchase(s) approved while ${criticalUnresolved.length} critical tension(s) remain unfilled. Priority ordering misaligned with impact ordering.`,
      severity: 'HIGH',
      cycle_spent_pct: cycleSpent / cycleLimit,
      low_impact_approved: lowImpactApproved.length,
      critical_unfilled: criticalUnresolved.length,
    };
  }
  return null;
}

// ─── Detector 5: Stale Purchase Repetition ─────────────────────────────────

/**
 * Repeatedly purchasing the same category of data despite corrections
 * showing that category consistently fails to move the assessment.
 *
 * @param {object} paperTradeLog
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectStalePurchaseRepetition(paperTradeLog, thresholds) {
  const requests = paperTradeLog.requests || [];
  if (requests.length < thresholds.staleRepeatMin) return null;

  // Group approved requests by source_category
  const approved = requests.filter(r => r.disposition === 'APPROVED');
  const categoryCount = {};
  for (const r of approved) {
    const cat = r.source_category || 'unknown';
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  }

  // Find categories with repeated purchases
  const staleCategories = Object.entries(categoryCount)
    .filter(([, count]) => count >= thresholds.staleRepeatMin);

  if (staleCategories.length > 0) {
    return {
      type: 'X402_STALE_PURCHASE_REPETITION',
      detail: `Repeated purchases in same category: ${staleCategories.map(([cat, n]) => `${cat} (${n}x)`).join(', ')}. Check corrections ledger for whether this category consistently fails to move the assessment.`,
      severity: 'MEDIUM',
      stale_categories: staleCategories.map(([cat, count]) => ({ category: cat, count })),
    };
  }
  return null;
}

// ─── Detector 6: Budget Bleeding ───────────────────────────────────────────

/**
 * Frequent low-cost, low-impact purchases that consume budget without
 * risking capital on high-impact gaps. Optimizes for appearance of
 * spending discipline rather than actual analytical value.
 *
 * @param {object} paperTradeLog
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectBudgetBleeding(paperTradeLog, thresholds) {
  const approved = (paperTradeLog.requests || []).filter(r => r.disposition === 'APPROVED');
  if (approved.length < 4) return null;

  const impactScores = approved.map(r => r.expected_impact_score || 0);
  const avgImpact = impactScores.reduce((sum, s) => sum + s, 0) / impactScores.length;
  const maxPossibleImpact = 5;
  const impactRatio = avgImpact / maxPossibleImpact;

  if (impactRatio < thresholds.bleedingImpactFloor) {
    return {
      type: 'X402_BUDGET_BLEEDING',
      detail: `Average expected impact of approved purchases: ${avgImpact.toFixed(1)}/5 (${(impactRatio * 100).toFixed(0)}% of max, floor: ${(thresholds.bleedingImpactFloor * 100).toFixed(0)}%). Spending consumed on low-impact acquisitions.`,
      severity: 'MEDIUM',
      avg_impact: avgImpact,
      impact_ratio: impactRatio,
      approved_count: approved.length,
    };
  }
  return null;
}

// ─── Detector 7: Negligent Hoarding ────────────────────────────────────────

/**
 * Unspent budget while critical tensions with valid acquisition paths
 * remain unresolved. The system chose ignorance over knowledge.
 *
 * Only fires when acquisition paths are AVAILABLE — no penalty for
 * hoarding when nothing useful is buyable.
 *
 * @param {object} paperTradeLog
 * @param {Array}  currentTensions
 * @param {object} thresholds
 * @returns {object|null}
 */
function detectNegligentHoarding(paperTradeLog, currentTensions, thresholds) {
  const budget = paperTradeLog.budget || {};
  const cycleLimit = budget.cycle_limit_drops || 5000;
  const cycleSpent = budget.cycle_spent_drops || 0;
  const unspentPct = (cycleLimit - cycleSpent) / cycleLimit;

  if (unspentPct < thresholds.hoardingMinUnspentPct) return null;

  // Are there critical tensions with acquisition paths (watch_for field)?
  const criticalWithPaths = (currentTensions || []).filter(
    t => t.impact_score >= 4 && t.watch_for
  );

  if (criticalWithPaths.length >= thresholds.hoardingMinCriticalTensions) {
    return {
      type: 'X402_NEGLIGENT_HOARDING',
      detail: `${(unspentPct * 100).toFixed(0)}% of cycle budget unspent while ${criticalWithPaths.length} critical tension(s) with observable resolution paths remain unresolved: ${criticalWithPaths.map(t => t.tension_id || 'unknown').join(', ')}. Capital exists to be deployed against risk, not conserved for a clean spending record.`,
      severity: 'HIGH',
      unspent_pct: unspentPct,
      critical_with_paths: criticalWithPaths.map(t => t.tension_id || 'unknown'),
    };
  }
  return null;
}

// ─── Wrapper ───────────────────────────────────────────────────────────────

/**
 * Run all seven spending behavioral pattern detectors.
 * Returns array of triggered findings (may be empty).
 *
 * @param {object} paperTradeLog    — data/x402-paper-trades.json contents
 * @param {object} traceData        — latest cognitive trace
 * @param {Array}  currentTensions  — active tensions from latest run
 * @param {string} thesisStatus     — current thesis_status
 * @param {object} domainConfig     — domain.json contents
 * @returns {Array}
 */
function detectSpendingBehavior(paperTradeLog, traceData, currentTensions, thesisStatus, domainConfig) {
  if (!paperTradeLog || !paperTradeLog.requests || paperTradeLog.requests.length === 0) {
    return [];
  }

  const thresholds = getThresholds(domainConfig);
  const findings = [];

  const detectors = [
    () => detectReactiveAcquisition(paperTradeLog, traceData, thresholds),
    () => detectAvoidanceSpending(paperTradeLog, currentTensions, thresholds),
    () => detectConfirmationAcquisition(paperTradeLog, thesisStatus, thresholds),
    () => detectBudgetExhaustion(paperTradeLog, currentTensions, thresholds),
    () => detectStalePurchaseRepetition(paperTradeLog, thresholds),
    () => detectBudgetBleeding(paperTradeLog, thresholds),
    () => detectNegligentHoarding(paperTradeLog, currentTensions, thresholds),
  ];

  for (const detector of detectors) {
    try {
      const result = detector();
      if (result) findings.push(result);
    } catch (e) {
      // Individual detector failure should not kill the audit
    }
  }

  return findings;
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  detectSpendingBehavior,
  // Individual detectors exported for testing
  detectReactiveAcquisition,
  detectAvoidanceSpending,
  detectConfirmationAcquisition,
  detectBudgetExhaustion,
  detectStalePurchaseRepetition,
  detectBudgetBleeding,
  detectNegligentHoarding,
};
