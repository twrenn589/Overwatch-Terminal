#!/usr/bin/env node
'use strict';

/**
 * Blind Auditor — Trajectory Review and Override Authority
 * Architecture Decision #14: Action Decisiveness Under Time Pressure
 *
 * The Blind Auditor is the exterior IC. Layer 4 is the interior officer.
 * The human operator is the post-incident review.
 *
 * This module has two layers:
 *   Layer A: DETERMINISTIC TRIGGERS. Pure code. Reads trajectory data,
 *     applies rules, detects mismatches. No AI calls. (AD #8)
 *   Layer B: CROSS-MODEL AI AUDIT. When triggers fire, calls a different
 *     model family (Gemini) to evaluate reasoning quality. (AD #12)
 *
 * Two phases:
 *   Phase 1 (Advisory): Detects mismatch between evidence trajectory and
 *     action trajectory. Writes advisory finding. Layer 4 must address it
 *     on the next run.
 *   Phase 2 (Override): If mismatch persists after advisory was delivered,
 *     the Auditor overrides the action recommendation directly. State-lock
 *     prevents Layer 4 from reversing it. Only human can release.
 *
 * Direction-agnostic: works identically for escalation and de-escalation.
 *
 * The Integrity Protocol — Patent Pending — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');
const { runAIAudit } = require('./ai-auditor');
const { loadLayerZeroRules, formatRulesForPrompt } = require('./layer-zero-gate');
const { detectSpendingBehavior } = require('./x402-spending-detectors');

// ─── Constants ──────────────────────────────────────────────────────────────

const AUDIT_FINDINGS_PATH = path.join(__dirname, '..', 'data', 'audit-findings.json');
const STATE_LOCK_PATH     = path.join(__dirname, '..', 'data', 'auditor-state-lock.json');

// Thesis status → directional value for trajectory comparison
// Positive = strengthening direction, Negative = weakening direction, 0 = neutral/contested
const STATUS_DIRECTION = {
  'STRENGTHENING':         1,
  'STABLE':                0,
  'WEAKENING':            -1,
  'CONTESTED':             0,   // Contested is not directional — it holds paradox
  'INSUFFICIENT_EVIDENCE': 0,
  'FALSIFIED':            -2,  // Terminal — worse than WEAKENING, forces EXIT_SIGNAL
};

// Action recommendation → escalation level (higher = more escalated)
// These are ordinal — the specific values don't matter, only the ordering
const ACTION_ESCALATION = {
  // Production domain
  'HOLD_POSITION':        0,
  'INCREASE_MONITORING':  1,
  'REDUCE_EXPOSURE':      2,
  'EXIT_SIGNAL':          3,
  // Water infrastructure domains (evolution scenarios)
  'MAINTAIN_OPERATIONS':  0,
  'REDUCE_LOAD':          2,
  'EMERGENCY_SHUTDOWN':   3,
};

// Kill switch status → severity level for jump detection
const KS_SEVERITY = {
  'safe':      0,
  'no_data':   0,
  'GREEN':     0,
  'warning':   1,
  'MONITORING':1,
  'WARNING':   2,
  'danger':    2,
  'TRIGGERED': 3,
  'triggered': 3,
};

function log(msg)  { console.log(`[auditor] ${msg}`); }
function warn(msg) { console.warn(`[auditor] WARN: ${msg}`); }
function err(msg)  { console.error(`[auditor] ERROR: ${msg}`); }

// ─── State Lock Management ──────────────────────────────────────────────────

/**
 * Check if a state-lock is currently active.
 * @param {string} [lockPath] — override path for evolution isolation
 * @returns {object|null} — lock object if active, null if not
 */
function checkStateLock(lockPath) {
  const p = lockPath || STATE_LOCK_PATH;
  try {
    if (fs.existsSync(p)) {
      const lock = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (lock.active) {
        log(`State-lock ACTIVE since ${lock.locked_at} — action locked to: ${lock.locked_action}`);
        return lock;
      }
    }
  } catch (e) {
    warn(`State-lock read failed: ${e.message}`);
  }
  return null;
}

/**
 * Write a state-lock.
 * @param {object} lockData
 * @param {string} [lockPath]
 */
function writeStateLock(lockData, lockPath) {
  const p = lockPath || STATE_LOCK_PATH;
  try {
    fs.writeFileSync(p, JSON.stringify(lockData, null, 2));
    log(`State-lock WRITTEN: action locked to ${lockData.locked_action}`);
  } catch (e) {
    err(`State-lock write failed: ${e.message}`);
  }
}

// ─── Audit Findings Management ──────────────────────────────────────────────

/**
 * Load existing audit findings.
 * @param {string} [findingsPath]
 * @returns {Array}
 */
function loadFindings(findingsPath) {
  const p = findingsPath || AUDIT_FINDINGS_PATH;
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    warn(`Audit findings read failed: ${e.message}`);
  }
  return [];
}

/**
 * Write audit findings.
 * @param {Array} findings
 * @param {string} [findingsPath]
 */
function writeFindings(findings, findingsPath) {
  const p = findingsPath || AUDIT_FINDINGS_PATH;
  try {
    // Keep last 100 findings
    const trimmed = findings.length > 100 ? findings.slice(-100) : findings;
    fs.writeFileSync(p, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    err(`Audit findings write failed: ${e.message}`);
  }
}

/**
 * Get the most recent UNRESOLVED advisory finding (if any).
 * @param {Array} findings
 * @returns {object|null}
 */
function getActiveAdvisory(findings) {
  // Walk backwards to find the most recent unresolved Phase 1 finding
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    if (f.phase === 1 && f.status === 'UNRESOLVED') {
      return f;
    }
    // If we hit a resolved finding or a Phase 2 override, stop looking
    if (f.status === 'RESOLVED' || f.phase === 2) {
      return null;
    }
  }
  return null;
}

// ─── Trajectory Analysis ────────────────────────────────────────────────────

/**
 * Extract trajectory data from a history array.
 * Returns an array of { thesis_status, action, direction, escalation, tensions_count, timestamp }
 *
 * @param {Array} history — array of 360-history entries
 * @param {number} lookback — how many entries to examine
 * @returns {Array}
 */
function extractTrajectory(history, lookback) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const recent = history.slice(-lookback);
  return recent.map(entry => ({
    thesis_status:    entry.thesis_status || null,
    action:           entry.action_recommendation || entry.tactical_recommendation || null,
    direction:        STATUS_DIRECTION[entry.thesis_status] ?? null,
    escalation:       ACTION_ESCALATION[entry.action_recommendation] ??
                      ACTION_ESCALATION[entry.tactical_recommendation] ?? null,
    tensions_count:   Array.isArray(entry.unresolved_tensions) ? entry.unresolved_tensions.length : 0,
    tensions_score_sum: Array.isArray(entry.unresolved_tensions)
      ? entry.unresolved_tensions.reduce((sum, t) => sum + (Number.isInteger(t.impact_score) ? t.impact_score : 3), 0)
      : 0,
    tensions:         Array.isArray(entry.unresolved_tensions) ? entry.unresolved_tensions : [],
    dispositions:     Array.isArray(entry.previous_tension_dispositions) ? entry.previous_tension_dispositions : [],
    bear_pressure:    entry.bear_pressure_score ?? null,
    kill_switches:    entry.kill_switches || [],
    timestamp:        entry.timestamp || entry._generated_at || null,
  }));
}

/**
 * Detect Evidence Type 1: Sustained directional status without corresponding action change.
 *
 * The system has assessed the same direction for multiple consecutive entries
 * but hasn't committed to acting on it.
 *
 * Direction-agnostic: detects BOTH failure to escalate AND failure to de-escalate.
 *
 * @param {Array} trajectory
 * @param {object} domainConfig
 * @returns {object|null} — mismatch finding or null
 */
function detectSustainedMismatch(trajectory, domainConfig) {
  if (trajectory.length < 2) return null;

  // Check for sustained WEAKENING without escalation
  const weakeningRuns = trajectory.filter(t => t.direction === -1);
  if (weakeningRuns.length >= 2) {
    // Is the action at the appropriate escalation level?
    const latestAction = trajectory[trajectory.length - 1].escalation;
    const severeLevel = ACTION_ESCALATION[domainConfig.action_severe] ?? 3;
    const monitorLevel = ACTION_ESCALATION[domainConfig.action_monitor] ?? 1;

    // If status is WEAKENING for 2+ runs but action is still at or below monitoring level
    if (latestAction !== null && latestAction <= monitorLevel) {
      return {
        type: 'SUSTAINED_WEAKENING_NO_ESCALATION',
        detail: `thesis_status has been WEAKENING for ${weakeningRuns.length} of the last ${trajectory.length} entries, but action_recommendation remains at escalation level ${latestAction} (${trajectory[trajectory.length - 1].action}). Expected escalation toward ${domainConfig.action_severe}.`,
        severity: weakeningRuns.length >= 3 ? 'HIGH' : 'MEDIUM',
        direction: 'escalate',
        consecutive_directional: weakeningRuns.length,
      };
    }
  }

  // Check for sustained STRENGTHENING/STABLE without de-escalation
  const positiveRuns = trajectory.filter(t => t.direction >= 0 && t.thesis_status !== 'CONTESTED' && t.thesis_status !== 'INSUFFICIENT_EVIDENCE');
  if (positiveRuns.length >= 2) {
    const latestAction = trajectory[trajectory.length - 1].escalation;
    const baselineLevel = ACTION_ESCALATION[domainConfig.action_baseline] ?? 0;
    const monitorLevel = ACTION_ESCALATION[domainConfig.action_monitor] ?? 1;

    // If status is positive for 2+ runs but action is still elevated above monitoring
    if (latestAction !== null && latestAction > monitorLevel) {
      return {
        type: 'SUSTAINED_POSITIVE_NO_DEESCALATION',
        detail: `thesis_status has been ${positiveRuns.map(r => r.thesis_status).join(' → ')} for ${positiveRuns.length} of the last ${trajectory.length} entries, but action_recommendation remains at escalation level ${latestAction} (${trajectory[trajectory.length - 1].action}). Expected de-escalation toward ${domainConfig.action_baseline}.`,
        severity: positiveRuns.length >= 3 ? 'HIGH' : 'MEDIUM',
        direction: 'deescalate',
        consecutive_directional: positiveRuns.length,
      };
    }
  }

  return null;
}

/**
 * AD #15: Behavioral pattern detectors for tension lifecycle.
 * Replaces the blunt cumulative score-sum trigger with six specific
 * patterns that understand tension identity, persistence, and lifecycle gaming.
 *
 * Each detector returns a mismatch finding or null.
 * The Integrity Protocol — Patent Pending — Timothy Joseph Wrenn
 */

/**
 * Detect critical tension persistence.
 * A score 4-5 tension persists N+ runs without the action escalating.
 */
function detectCriticalPersistence(trajectory, domainConfig) {
  if (trajectory.length < 3) return null;
  const threshold = (domainConfig && domainConfig.critical_persistence_threshold) || 3;

  const criticalIds = {};
  for (const entry of trajectory) {
    const currentCritical = new Set();
    for (const t of entry.tensions) {
      if (t.tension_id && t.impact_score >= 4) {
        currentCritical.add(t.tension_id);
        criticalIds[t.tension_id] = (criticalIds[t.tension_id] || 0) + 1;
      }
    }
    for (const id of Object.keys(criticalIds)) {
      if (!currentCritical.has(id)) {
        criticalIds[id] = 0;
      }
    }
  }

  const persistent = Object.entries(criticalIds)
    .filter(([, count]) => count >= threshold);

  if (persistent.length > 0) {
    return {
      type: 'CRITICAL_TENSION_PERSISTENCE',
      detail: `Critical tension(s) persisting ${threshold}+ runs without action escalation: ${persistent.map(([id, n]) => `${id} (${n} runs)`).join(', ')}.`,
      severity: 'HIGH',
      persistent_tensions: persistent.map(([id, count]) => ({ tension_id: id, runs: count })),
    };
  }
  return null;
}

/**
 * Detect score-language mismatch.
 */
function detectScoreLanguageMismatch(trajectory) {
  if (trajectory.length < 1) return null;
  const latest = trajectory[trajectory.length - 1];
  const mismatches = [];

  const criticalWords = ['flip', 'fundamentally', 'critical', 'collapse', 'existential', 'terminal', 'entire assessment'];
  const minorWords = ['informational', 'minor', 'negligible', 'no impact', 'marginal'];

  for (const t of latest.tensions) {
    if (!t.description) continue;
    const desc = t.description.toLowerCase();
    const score = t.impact_score || 3;

    if (criticalWords.some(w => desc.includes(w)) && score <= 2) {
      mismatches.push({ tension_id: t.tension_id, score, issue: 'critical language, low score' });
    }
    if (minorWords.some(w => desc.includes(w)) && score >= 4) {
      mismatches.push({ tension_id: t.tension_id, score, issue: 'minor language, high score' });
    }
  }

  if (mismatches.length > 0) {
    return {
      type: 'SCORE_LANGUAGE_MISMATCH',
      detail: `Tension language contradicts impact score: ${mismatches.map(m => `${m.tension_id} — ${m.issue} (score ${m.score})`).join('; ')}.`,
      severity: 'MEDIUM',
      mismatches,
    };
  }
  return null;
}

/**
 * Detect tension churn — created and resolved within one cycle, repeatedly.
 */
function detectTensionChurn(trajectory) {
  if (trajectory.length < 3) return null;

  let churnCount = 0;
  for (let i = 1; i < trajectory.length; i++) {
    const curr = trajectory[i];
    const prev = trajectory[i - 1];
    for (const d of curr.dispositions) {
      if (d.disposition === 'RESOLVE') {
        const wasNew = prev.tensions.some(t => t.tension_id === d.tension_id && t.is_new);
        if (wasNew) churnCount++;
      }
    }
  }

  if (churnCount >= 3) {
    return {
      type: 'TENSION_CHURN',
      detail: `${churnCount} tensions created and resolved within one cycle. Performative uncertainty.`,
      severity: 'MEDIUM',
      churn_count: churnCount,
    };
  }
  return null;
}

/**
 * Detect avoidance displacement — tensions displaced near window expiration.
 */
function detectAvoidanceDisplacement(trajectory) {
  if (trajectory.length < 2) return null;

  let avoidanceCount = 0;
  for (let i = 1; i < trajectory.length; i++) {
    const curr = trajectory[i];
    const prev = trajectory[i - 1];
    for (const d of curr.dispositions) {
      if (d.disposition === 'DISPLACE') {
        const displaced = prev.tensions.find(t => t.tension_id === d.tension_id);
        if (displaced && (displaced.window_status === 'approaching' || displaced.window_status === 'expired')) {
          avoidanceCount++;
        }
      }
    }
  }

  if (avoidanceCount >= 2) {
    return {
      type: 'AVOIDANCE_DISPLACEMENT',
      detail: `${avoidanceCount} tensions displaced near or past their resolution window. Possible avoidance behavior.`,
      severity: 'HIGH',
      avoidance_count: avoidanceCount,
    };
  }
  return null;
}

/**
 * Detect gap parking — tensions vanish without disposition.
 */
function detectGapParking(trajectory) {
  if (trajectory.length < 2) return null;

  let parkingCount = 0;
  for (let i = 1; i < trajectory.length; i++) {
    const prev = trajectory[i - 1];
    const curr = trajectory[i];
    for (const prevTension of prev.tensions) {
      if (!prevTension.tension_id) continue;
      const stillActive = curr.tensions.some(t => t.tension_id === prevTension.tension_id);
      const wasDispositioned = curr.dispositions.some(d => d.tension_id === prevTension.tension_id);
      if (!stillActive && !wasDispositioned) {
        parkingCount++;
      }
    }
  }

  if (parkingCount >= 2) {
    return {
      type: 'GAP_PARKING',
      detail: `${parkingCount} tensions disappeared without disposition. Possible reclassification to avoid cap or clock.`,
      severity: 'MEDIUM',
      parking_count: parkingCount,
    };
  }
  return null;
}

/**
 * Detect window gaming — repeated extensions without conditions changing.
 */
function detectWindowGaming(trajectory) {
  if (trajectory.length < 3) return null;

  let extensionCount = 0;
  for (const entry of trajectory) {
    for (const t of entry.tensions) {
      if (t.window_status === 'extended') {
        extensionCount++;
      }
    }
  }

  if (extensionCount >= 3) {
    return {
      type: 'WINDOW_GAMING',
      detail: `${extensionCount} window extensions across ${trajectory.length} runs. Tensions extended at expiration rather than resolved or escalated.`,
      severity: 'MEDIUM',
      extension_count: extensionCount,
    };
  }
  return null;
}

/**
 * AD #15: Run all behavioral tension detectors.
 * Returns array of all triggered findings (may be empty).
 */
function detectTensionBehavior(trajectory, domainConfig) {
  const findings = [];
  const detectors = [
    detectCriticalPersistence,
    detectScoreLanguageMismatch,
    detectTensionChurn,
    detectAvoidanceDisplacement,
    detectGapParking,
    detectWindowGaming,
  ];
  for (const detector of detectors) {
    const result = detector(trajectory, domainConfig);
    if (result) findings.push(result);
  }
  return findings;
}

/**
 * Detect Evidence Type 3: Trajectory and rate of change.
 *
 * Sequential changes in the same direction establish a clear trend.
 * The system should act on where it's heading, not just where it is.
 *
 * @param {Array} trajectory
 * @returns {object|null}
 */
function detectTrajectoryTrend(trajectory) {
  if (trajectory.length < 3) return null;

  // Check bear_pressure trajectory (if available)
  const pressures = trajectory.map(t => t.bear_pressure).filter(p => p !== null);
  if (pressures.length >= 3) {
    // Check for monotonic increase (deteriorating)
    let monotoneUp = true;
    let monotoneDown = true;
    for (let i = 1; i < pressures.length; i++) {
      if (pressures[i] <= pressures[i - 1]) monotoneUp = false;
      if (pressures[i] >= pressures[i - 1]) monotoneDown = false;
    }

    const latestAction = trajectory[trajectory.length - 1].escalation;
    const delta = pressures[pressures.length - 1] - pressures[0];

    if (monotoneUp && delta >= 15) {
      return {
        type: 'MONOTONIC_DETERIORATION',
        detail: `Bear pressure has increased monotonically: ${pressures.join(' → ')} (Δ${delta}). Consistent deterioration trajectory across ${pressures.length} entries without reversal.`,
        severity: delta >= 30 ? 'HIGH' : 'MEDIUM',
        direction: 'escalate',
        pressure_trajectory: pressures,
        total_delta: delta,
      };
    }

    if (monotoneDown && Math.abs(delta) >= 15) {
      return {
        type: 'MONOTONIC_IMPROVEMENT',
        detail: `Bear pressure has decreased monotonically: ${pressures.join(' → ')} (Δ${delta}). Consistent improvement trajectory across ${pressures.length} entries without reversal.`,
        severity: Math.abs(delta) >= 30 ? 'HIGH' : 'MEDIUM',
        direction: 'deescalate',
        pressure_trajectory: pressures,
        total_delta: delta,
      };
    }
  }

  // Check escalation trajectory (action level changes)
  const escalations = trajectory.map(t => t.escalation).filter(e => e !== null);
  if (escalations.length >= 3) {
    // Are actions stuck at the same level while status changes?
    const allSameAction = escalations.every(e => e === escalations[0]);
    const statusChanging = new Set(trajectory.map(t => t.thesis_status)).size > 1;

    if (allSameAction && statusChanging) {
      return {
        type: 'STAGNANT_ACTION_CHANGING_STATUS',
        detail: `Action has been ${trajectory[0].action} for ${trajectory.length} consecutive entries while thesis_status changed: ${trajectory.map(t => t.thesis_status).join(' → ')}. Action is not responding to evidence changes.`,
        severity: 'MEDIUM',
        direction: 'unknown',
      };
    }
  }

  return null;
}

/**
 * Check anomaly triggers for immediate off-cycle audit.
 *
 * @param {object} currentEntry — the latest 360-history entry
 * @param {object} previousEntry — the entry before it
 * @param {Array} anomalyTriggers — from domain config
 * @returns {Array} — list of triggered anomalies
 */
function checkAnomalyTriggers(currentEntry, previousEntry, anomalyTriggers) {
  if (!previousEntry || !Array.isArray(anomalyTriggers)) return [];

  const triggered = [];

  for (const trigger of anomalyTriggers) {
    switch (trigger.id) {
      case 'KILL_SWITCH_JUMP': {
        const currentKS = currentEntry.kill_switches || [];
        const previousKS = previousEntry.kill_switches || [];
        for (const ks of currentKS) {
          const prev = previousKS.find(p => p.name === ks.name);
          if (prev) {
            const currentSev = KS_SEVERITY[ks.status] ?? 0;
            const prevSev = KS_SEVERITY[prev.status] ?? 0;
            if (Math.abs(currentSev - prevSev) >= 2) {
              triggered.push({
                trigger_id: trigger.id,
                detail: `Kill switch "${ks.name}" jumped from ${prev.status} to ${ks.status} (Δ${currentSev - prevSev})`,
              });
            }
          }
        }
        break;
      }

      case 'COMPOUND_STRESS_ESCALATION': {
        // Compare bear_pressure as proxy for compound stress
        const currentBP = currentEntry.bear_pressure_score ?? null;
        const prevBP = previousEntry.bear_pressure_score ?? null;
        if (currentBP !== null && prevBP !== null && (currentBP - prevBP) >= 20) {
          triggered.push({
            trigger_id: trigger.id,
            detail: `Bear pressure jumped from ${prevBP} to ${currentBP} (Δ${currentBP - prevBP})`,
          });
        }
        break;
      }

      case 'ACTION_STATUS_DIVERGENCE': {
        const statusDir = STATUS_DIRECTION[currentEntry.thesis_status] ?? 0;
        const actionLevel = ACTION_ESCALATION[currentEntry.action_recommendation] ??
                           ACTION_ESCALATION[currentEntry.tactical_recommendation] ?? null;
        const prevActionLevel = ACTION_ESCALATION[previousEntry.action_recommendation] ??
                               ACTION_ESCALATION[previousEntry.tactical_recommendation] ?? null;

        if (actionLevel !== null && prevActionLevel !== null) {
          const actionDir = actionLevel > prevActionLevel ? 1 : actionLevel < prevActionLevel ? -1 : 0;
          // Status says weakening but action de-escalated, or status says strengthening but action escalated
          if ((statusDir === -1 && actionDir === -1) || (statusDir === 1 && actionDir === 1)) {
            // Status and action moving in same direction relative to thesis — no divergence
          } else if (statusDir !== 0 && actionDir !== 0 && statusDir !== actionDir) {
            triggered.push({
              trigger_id: trigger.id,
              detail: `thesis_status direction (${currentEntry.thesis_status}) diverges from action direction (${previousEntry.action_recommendation || previousEntry.tactical_recommendation} → ${currentEntry.action_recommendation || currentEntry.tactical_recommendation})`,
            });
          }
        }
        break;
      }
    }
  }

  return triggered;
}

// ─── Main Auditor Function ──────────────────────────────────────────────────

/**
 * Run the Blind Auditor trajectory review.
 *
 * Called AFTER Layer 4 completes. Reviews the trajectory of thesis_status
 * and action_recommendation across consecutive runs/steps. If a mismatch
 * is detected, writes Phase 1 advisory or executes Phase 2 override.
 *
 * @param {object} options
 * @param {Array}  options.history        — array of 360-history entries (chronological)
 * @param {object} options.currentOutput  — the current run's Layer 4 / bridge output
 * @param {object} options.domainConfig   — domain.json contents
 * @param {number} options.runIndex       — current run/step number (0-based)
 * @param {string} [options.findingsPath] — override findings file path (for evolution isolation)
 * @param {string} [options.lockPath]     — override state-lock file path (for evolution isolation)
 * @returns {object} — { audited, phase, finding, override, state_lock_active, anomalies_triggered }
 */
async function runBlindAuditor(options) {
  const {
    history,
    currentOutput,
    domainConfig,
    runIndex,
    findingsPath,
    lockPath,
    cognitiveTracePath,
  } = options;

  log(`=== BLIND AUDITOR — AD #14 Trajectory Review ===`);
  log(`Run index: ${runIndex}, History entries: ${history?.length || 0}`);

  const result = {
    audited: false,
    phase: 0,
    finding: null,
    override: false,
    override_action: null,
    override_reasoning: null,
    state_lock_active: false,
    anomalies_triggered: [],
    advisory_for_layer4: null,
  };

  // ── Check existing state-lock ─────────────────────────────────────────
  const existingLock = checkStateLock(lockPath);
  if (existingLock) {
    result.state_lock_active = true;
    result.override = true;
    result.override_action = existingLock.locked_action;
    result.override_reasoning = `State-lock active since ${existingLock.locked_at}. Action locked to ${existingLock.locked_action}. Only the human operator can release this lock.`;
    log(`State-lock enforced: ${existingLock.locked_action}`);
    return result;
  }

  // ── Validate inputs ───────────────────────────────────────────────────
  if (!Array.isArray(history) || history.length < 3) {
    log('Insufficient history for trajectory review (need >= 3 entries). Skipping.');
    return result;
  }

  if (!domainConfig) {
    warn('No domain config provided. Skipping audit.');
    return result;
  }

  const cadence = domainConfig.audit_cadence || 3;
  const anomalyTriggers = domainConfig.anomaly_triggers || [];

  // ── Check anomaly triggers (always, regardless of cadence) ────────────
  const currentEntry = history[history.length - 1];
  const previousEntry = history[history.length - 2];
  const anomalies = checkAnomalyTriggers(currentEntry, previousEntry, anomalyTriggers);

  if (anomalies.length > 0) {
    log(`ANOMALY TRIGGERS FIRED: ${anomalies.length}`);
    anomalies.forEach(a => log(`  → ${a.trigger_id}: ${a.detail}`));
    result.anomalies_triggered = anomalies;
  }

  // ── Determine if audit should run ─────────────────────────────────────
  const onCadence = (runIndex > 0) && ((runIndex + 1) % cadence === 0);
  const anomalyTriggered = anomalies.length > 0;

  if (!onCadence && !anomalyTriggered) {
    log(`Not on cadence (run ${runIndex + 1}, cadence ${cadence}) and no anomalies. Skipping.`);
    return result;
  }

  log(onCadence
    ? `ON CADENCE: run ${runIndex + 1} (cadence ${cadence}). Running trajectory review.`
    : `OFF-CYCLE: ${anomalies.length} anomaly trigger(s). Running immediate trajectory review.`
  );

  result.audited = true;

  // ── Extract trajectory ────────────────────────────────────────────────
  const lookback = Math.min(history.length, cadence + 2); // cadence window + buffer
  const trajectory = extractTrajectory(history, lookback);

  if (trajectory.length < 2) {
    log('Trajectory too short after extraction. No findings.');
    return result;
  }

  // ── Load x402 paper trade log and latest trace for spending detectors ──
  let paperTradeLog = null;
  let latestTrace = null;
  try {
    const ptPath = path.join(__dirname, '..', 'data', 'x402-paper-trades.json');
    if (fs.existsSync(ptPath)) {
      paperTradeLog = JSON.parse(fs.readFileSync(ptPath, 'utf8'));
    }
  } catch (e) {
    warn(`x402 paper trade log load failed (non-fatal): ${e.message}`);
  }
  try {
    const traceIndexPath = path.join(__dirname, '..', 'data', 'trace-index.json');
    if (fs.existsSync(traceIndexPath)) {
      const traceIndex = JSON.parse(fs.readFileSync(traceIndexPath, 'utf8'));
      if (traceIndex.length > 0) {
        const latestTracePath = path.join(__dirname, '..', 'data', traceIndex[0]);
        if (fs.existsSync(latestTracePath)) {
          latestTrace = JSON.parse(fs.readFileSync(latestTracePath, 'utf8'));
        }
      }
    }
  } catch (e) {
    warn(`Cognitive trace load failed (non-fatal): ${e.message}`);
  }

  // ── Run all three detection types ─────────────────────────────────────
  const mismatches = [];

  const sustained = detectSustainedMismatch(trajectory, domainConfig);
  if (sustained) mismatches.push(sustained);

  const tensionFindings = detectTensionBehavior(trajectory, domainConfig);
  mismatches.push(...tensionFindings);

  const trend = detectTrajectoryTrend(trajectory);
  if (trend) mismatches.push(trend);

  // x402: Spending behavioral pattern detection
  if (paperTradeLog) {
    const currentTensions = trajectory.length > 0 ? trajectory[trajectory.length - 1].tensions : [];
    const currentStatus = trajectory.length > 0 ? trajectory[trajectory.length - 1].thesis_status : null;
    const spendingFindings = detectSpendingBehavior(paperTradeLog, latestTrace, currentTensions, currentStatus, domainConfig);
    mismatches.push(...spendingFindings);
  }

  if (mismatches.length === 0) {
    log('No trajectory mismatch detected. Evidence trend and action trend are aligned.');
    return result;
  }

  log(`MISMATCH DETECTED: ${mismatches.length} finding(s)`);
  mismatches.forEach(m => log(`  → ${m.type}: ${m.severity}`));

  // ── AI Audit: Cross-model epistemological review (AD #12, AD #14) ──
  const findings = loadFindings(findingsPath);
  const activeAdvisory = getActiveAdvisory(findings);

  // Load Cognitive Trace
  let cognitiveTrace = null;
  if (cognitiveTracePath) {
    try {
      if (fs.existsSync(cognitiveTracePath)) {
        cognitiveTrace = JSON.parse(fs.readFileSync(cognitiveTracePath, 'utf8'));
        log(`Cognitive Trace loaded: ${cognitiveTracePath}`);
      } else {
        warn(`Cognitive Trace not found at: ${cognitiveTracePath}`);
      }
    } catch (e) {
      warn(`Cognitive Trace read failed: ${e.message}`);
    }
  }

  // Load Layer Zero rules
  const lzRules = loadLayerZeroRules();
  const lzRulesText = lzRules ? formatRulesForPrompt(lzRules) : 'LAYER ZERO RULES UNAVAILABLE';

  // Build model config
  const geminiKey = process.env.GEMINI_API_KEY;
  const modelConfig = {
    provider: domainConfig.auditor_model_provider || 'gemini',
    model: domainConfig.auditor_model_name || 'gemini-2.5-pro',
    apiKey: geminiKey,
  };

  // Attempt AI Audit if we have the prerequisites
  let aiVerdict = null;
  if (geminiKey && cognitiveTrace) {
    try {
      const aiResult = await runAIAudit({
        layerZeroRules: lzRulesText,
        cognitiveTrace,
        layer4Output: currentOutput,
        trajectory,
        triggerMismatches: mismatches,
        priorAdvisory: activeAdvisory,
        modelConfig,
      });

      if (!aiResult.audit_failed) {
        aiVerdict = aiResult;
        log(`AI Audit complete: ${aiResult.verdict} (model: ${aiResult.model_used})`);
      } else {
        warn(`AI Audit failed: ${aiResult.failure_reason}. Falling back to deterministic logic.`);
      }
    } catch (e) {
      warn(`AI Audit error: ${e.message}. Falling back to deterministic logic.`);
    }
  } else {
    if (!geminiKey) warn('GEMINI_API_KEY not set. Using deterministic logic only.');
    if (!cognitiveTrace) warn('No Cognitive Trace available. Using deterministic logic only.');
  }

  // ── Route based on AI verdict (or fall back to deterministic) ──────

  if (aiVerdict && aiVerdict.verdict === 'COMPLIANT') {
    // ── AI says action matches evidence — resolve any active advisory ──
    log('AI VERDICT: COMPLIANT. Action matches evidence trajectory.');
    if (activeAdvisory) {
      resolveAdvisory('AI_AUDIT_COMPLIANT', findingsPath);
      log('Previous advisory resolved by AI audit.');
    }
    result.ai_audit = aiVerdict.finding;
    result.ai_model_used = aiVerdict.model_used;
    return result;
  }

  if (aiVerdict && aiVerdict.verdict === 'OVERRIDE') {
    // ── AI says persistent mismatch — Phase 2 override ──────────────
    log('AI VERDICT: OVERRIDE. Persistent mismatch after advisory.');

    const overrideAction = aiVerdict.finding.recommended_action ||
      (aiVerdict.finding.recommended_direction === 'DE_ESCALATE'
        ? (domainConfig.auditor_override_actions?.deescalate_to || domainConfig.action_baseline || 'HOLD_POSITION')
        : (domainConfig.auditor_override_actions?.escalate_to || domainConfig.action_severe || 'EXIT_SIGNAL'));
    const overrideDirection = aiVerdict.finding.recommended_direction || 'ESCALATE';

    const overrideReasoning = `BLIND AUDITOR PHASE 2 OVERRIDE (AI). ` +
      `Model: ${aiVerdict.model_used}. ` +
      `${aiVerdict.finding.auditor_reasoning}`;

    if (activeAdvisory) {
      activeAdvisory.status = 'ESCALATED_TO_OVERRIDE';
      activeAdvisory.escalated_at = new Date().toISOString();
    }

    const phase2Finding = {
      phase: 2,
      status: 'OVERRIDE_ACTIVE',
      timestamp: new Date().toISOString(),
      run_index: runIndex,
      mismatches,
      ai_verdict: aiVerdict.finding,
      ai_model_used: aiVerdict.model_used,
      override_action: overrideAction,
      override_direction: overrideDirection,
      override_reasoning: overrideReasoning,
      prior_advisory_timestamp: activeAdvisory?.timestamp || null,
    };
    findings.push(phase2Finding);
    writeFindings(findings, findingsPath);

    const lockData = {
      active: true,
      locked_at: new Date().toISOString(),
      locked_action: overrideAction,
      locked_by: 'blind_auditor_ai_phase2',
      override_reasoning: overrideReasoning,
      ai_verdict: aiVerdict.finding,
      mismatches: mismatches.map(m => ({ type: m.type, severity: m.severity, detail: m.detail })),
      release_requires: 'human_operator',
    };
    writeStateLock(lockData, lockPath);

    result.phase = 2;
    result.finding = phase2Finding;
    result.override = true;
    result.override_action = overrideAction;
    result.override_reasoning = overrideReasoning;
    result.state_lock_active = true;
    result.ai_audit = aiVerdict.finding;
    result.ai_model_used = aiVerdict.model_used;

    log(`OVERRIDE EXECUTED: ${overrideAction} (${overrideDirection})`);
    log(`STATE-LOCK ACTIVE. Only human operator can release.`);

    return result;
  }

  if (aiVerdict && aiVerdict.verdict === 'ADVISORY') {
    // ── AI says mismatch detected — Phase 1 advisory ─────────────────
    log('AI VERDICT: ADVISORY. Mismatch detected, Layer 4 must address.');

    const phase1Finding = {
      phase: 1,
      status: 'UNRESOLVED',
      timestamp: new Date().toISOString(),
      run_index: runIndex,
      mismatches,
      ai_verdict: aiVerdict.finding,
      ai_model_used: aiVerdict.model_used,
      advisory_text: `The Blind Auditor (${aiVerdict.model_used}) has detected a mismatch between your evidence trajectory and your action trajectory. ${aiVerdict.finding.auditor_reasoning}`,
      trajectory_summary: trajectory.map(t => ({
        status: t.thesis_status,
        action: t.action,
        tensions: t.tensions_count,
        pressure: t.bear_pressure,
      })),
    };
    findings.push(phase1Finding);
    writeFindings(findings, findingsPath);

    result.phase = 1;
    result.finding = phase1Finding;
    result.advisory_for_layer4 = phase1Finding.advisory_text + '\n\nSpecific findings:\n' +
      mismatches.map(m => `- ${m.type} (${m.severity}): ${m.detail}`).join('\n') +
      '\n\nAuditor reasoning: ' + aiVerdict.finding.auditor_reasoning;
    result.ai_audit = aiVerdict.finding;
    result.ai_model_used = aiVerdict.model_used;

    log(`Advisory written: ${mismatches.length} trigger(s), AI verdict: ADVISORY.`);

    return result;
  }

  // ── FALLBACK: Deterministic logic (AI audit unavailable or failed) ──
  log('Using deterministic fallback (AI audit not available).');

  if (activeAdvisory) {
    log('PHASE 2 (deterministic): Previous advisory was UNRESOLVED. Executing override.');

    const highSeverity = mismatches.find(m => m.severity === 'HIGH') || mismatches[0];
    const overrideDirection = highSeverity.direction || 'escalate';

    const overrideActions = domainConfig.auditor_override_actions || {};
    const overrideAction = overrideDirection === 'deescalate'
      ? (overrideActions.deescalate_to || domainConfig.action_baseline || 'HOLD_POSITION')
      : (overrideActions.escalate_to || domainConfig.action_severe || 'EXIT_SIGNAL');

    const overrideReasoning = `BLIND AUDITOR PHASE 2 OVERRIDE (deterministic fallback). ` +
      `AI audit unavailable. ` +
      `Previous advisory (${activeAdvisory.timestamp}) was not resolved. ` +
      `Persistent mismatch: ${mismatches.map(m => m.type).join(', ')}. ` +
      `Direction: ${overrideDirection}. ` +
      `Action overridden to: ${overrideAction}. ` +
      `${highSeverity.detail}`;

    activeAdvisory.status = 'ESCALATED_TO_OVERRIDE';
    activeAdvisory.escalated_at = new Date().toISOString();

    const phase2Finding = {
      phase: 2,
      status: 'OVERRIDE_ACTIVE',
      timestamp: new Date().toISOString(),
      run_index: runIndex,
      mismatches,
      override_action: overrideAction,
      override_direction: overrideDirection,
      override_reasoning: overrideReasoning,
      prior_advisory_timestamp: activeAdvisory.timestamp,
      deterministic_fallback: true,
    };
    findings.push(phase2Finding);
    writeFindings(findings, findingsPath);

    const lockData = {
      active: true,
      locked_at: new Date().toISOString(),
      locked_action: overrideAction,
      locked_by: 'blind_auditor_deterministic_phase2',
      override_reasoning: overrideReasoning,
      mismatches: mismatches.map(m => ({ type: m.type, severity: m.severity, detail: m.detail })),
      release_requires: 'human_operator',
    };
    writeStateLock(lockData, lockPath);

    result.phase = 2;
    result.finding = phase2Finding;
    result.override = true;
    result.override_action = overrideAction;
    result.override_reasoning = overrideReasoning;
    result.state_lock_active = true;

    log(`OVERRIDE EXECUTED (deterministic): ${overrideAction} (${overrideDirection})`);
    log(`STATE-LOCK ACTIVE. Only human operator can release.`);

    return result;
  }

  log('PHASE 1 (deterministic): Writing advisory finding for Layer 4.');

  const phase1Finding = {
    phase: 1,
    status: 'UNRESOLVED',
    timestamp: new Date().toISOString(),
    run_index: runIndex,
    mismatches,
    advisory_text: domainConfig.auditor_phase1_instructions ||
      'The Blind Auditor has detected a mismatch between your evidence trajectory and your action trajectory. Address this finding.',
    trajectory_summary: trajectory.map(t => ({
      status: t.thesis_status,
      action: t.action,
      tensions: t.tensions_count,
      pressure: t.bear_pressure,
    })),
    deterministic_fallback: true,
  };
  findings.push(phase1Finding);
  writeFindings(findings, findingsPath);

  result.phase = 1;
  result.finding = phase1Finding;
  result.advisory_for_layer4 = phase1Finding.advisory_text + '\n\nSpecific findings:\n' +
    mismatches.map(m => `- ${m.type} (${m.severity}): ${m.detail}`).join('\n');

  log(`Advisory written (deterministic): ${mismatches.length} finding(s).`);

  return result;
}

/**
 * Apply auditor results to the pipeline output.
 * Called after runBlindAuditor() to modify the output object in place.
 *
 * @param {object} output — the pipeline output (360 report / bridge output)
 * @param {object} auditorResult — result from runBlindAuditor()
 */
function applyAuditorToOutput(output, auditorResult) {
  if (!auditorResult || !output) return;

  // Always attach auditor metadata
  output.auditor_advisory = auditorResult.finding?.advisory_text || null;
  output.auditor_override = auditorResult.override || false;
  output.auditor_override_reasoning = auditorResult.override_reasoning || null;
  output.state_lock_active = auditorResult.state_lock_active || false;

  // If Phase 2 override, replace the action recommendation
  if (auditorResult.override && auditorResult.override_action) {
    const originalAction = output.action_recommendation || output.tactical_recommendation;
    log(`Overriding action: ${originalAction} → ${auditorResult.override_action}`);

    output.action_recommendation = auditorResult.override_action;
    output.tactical_recommendation = auditorResult.override_action; // legacy field
    output._action_before_override = originalAction;
    output._auditor_override_applied = true;
  }
}

/**
 * Mark an advisory as resolved.
 * Called when Layer 4 has addressed the advisory (either committed or justified).
 *
 * @param {string} resolution — 'COMMITTED' or 'JUSTIFIED'
 * @param {string} [findingsPath]
 */
function resolveAdvisory(resolution, findingsPath) {
  const findings = loadFindings(findingsPath);
  const active = getActiveAdvisory(findings);
  if (active) {
    active.status = 'RESOLVED';
    active.resolved_at = new Date().toISOString();
    active.resolution = resolution;
    writeFindings(findings, findingsPath);
    log(`Advisory resolved: ${resolution}`);
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runBlindAuditor,
  applyAuditorToOutput,
  resolveAdvisory,
  checkStateLock,
  // Exported for testing / evolution runner
  extractTrajectory,
  detectSustainedMismatch,
  detectTensionBehavior,
  detectCriticalPersistence,
  detectScoreLanguageMismatch,
  detectTensionChurn,
  detectAvoidanceDisplacement,
  detectGapParking,
  detectWindowGaming,
  detectTrajectoryTrend,
  checkAnomalyTriggers,
  loadFindings,
  writeFindings,
  getActiveAdvisory,
  writeStateLock,
  // Constants for external use
  STATUS_DIRECTION,
  ACTION_ESCALATION,
};
