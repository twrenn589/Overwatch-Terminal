# Overwatch Terminal — Claude Code Context

## What This Is
Autonomous AI intelligence system monitoring an institutional adoption thesis. Four-layer cognitive architecture (SWEEP → CONTEXTUALIZE → INFER → RECONCILE) with epistemological guardrails, circuit breakers, and a corrections ledger. Running in production on GitHub Actions, twice daily. Built entirely by directing AI tools — the builder has zero coding background.

The deeper IP is The Integrity Protocol — a cognitive transfer methodology for decomposing expert human judgment into layered AI systems with epistemological guardrails. Overwatch Terminal is TIP's first proof of concept. Patent Pending — filed March 5, 2026.

## Critical Build Rules
- NEVER modify a file without stating: what changes, what it affects downstream, what could break
- One change at a time. Verify before moving to next.
- After ANY commit touching fetch-data.js, analyze-thesis.js, index.html, or dashboard-data.json: trace the change forward AND backward
- No silent failures. Every error must surface. No empty catch blocks.
- If restoring a file from a prior commit, validate the FULL data contract between that file and everything it connects to
- Tim cannot read code. Provide complete file replacements, not diffs. Explain changes in plain language.
- Do NOT recalibrate thresholds without explicit instruction.
- Comments explain WHY, not WHAT. Reference architectural decision documents.

## File Map
- scripts/fetch-data.js — Data pipeline, 12+ active API sources, writes dashboard-data.json, runs data contract validation
- scripts/analyze-thesis.js — Four-layer Claude API pipeline (SWEEP → CONTEXTUALIZE → INFER → RECONCILE), LAYER_ZERO_RULES constant (17 rules injected into L2-L4 prompts), enforceCorrectionsReferenced() helper, writes 360-report.json + 360-history.json + rejection-log.json, sends Telegram briefing with pipeline health line
- scripts/apply-analysis.js — Merges analysis results into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress fields)
- scripts/x402-agent.js — XRPL mainnet payment agent (manual trigger only)
- scripts/promote-rejections.js — Transforms Layer 4 auto_commit rejections into corrections ledger entries, runs after every Layer 4 pass
- scripts/ab-test-overledger.js — Isolated A/B test script proving Overledger causal impact on Layer 2 output. Does NOT import from or modify production code.
- scripts/thesis-context.md — Thesis context fed to Claude API analyst. Lives in scripts/, NOT repo root.
- scripts/pipeline-health.json — Written by fetch-data.js validation, read by analyze-thesis.js for Telegram heartbeat
- data-contract.json — Lists every field index.html expects from dashboard-data.json. Source of truth for validation.
- data/360-report.json — Latest analysis output (includes _layer2_raw, _layer3_raw, _layer4_raw)
- data/360-history.json — Archive of all assessments (last 60 entries)
- data/layer-zero.json — 17 immutable epistemological rules across 5 categories. Canonical reference for gate function. Commit b61a69b.
- data/corrections-ledger.json — 19 active corrections, read by Layers 2 and 3 during live analysis
- data/rejection-log.json — Layer 4 rejection log, feeds corrections ledger pipeline
- data/ab-test-results.json — Results of Level 2 causal impact A/B test
- data/schema-layer2-output.json — Layer 2 CONTEXTUALIZE output schema (verified against production)
- data/schema-layer3-output.json — Layer 3 INFER output schema (10 required fields, circuit breaker enums)
- data/schema-layer4-output.json — Layer 4 RECONCILE output schema (17 required fields, strict)
- index.html — Dashboard frontend, reads dashboard-data.json on load
- .github/workflows/analyze-thesis.yml — Production pipeline (cron 2x daily)
- .github/workflows/ab-test.yml — Manual-trigger A/B test workflow (isolated from production)

## Data Flow
fetch-data.js writes dashboard-data.json (partial: macro, rlusd, xrp, thesis_scores) → validates against data-contract.json → writes pipeline-health.json → analyze-thesis.js runs four-layer pipeline → writes 360-report.json + 360-history.json + rejection-log.json → promote-rejections.js auto-promotes high-confidence rejections to corrections-ledger.json → sends Telegram with pipeline health appended → apply-analysis.js merges analysis into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress) → git commit + push

## GitHub Actions
- Cron: 12:00 UTC and 00:00 UTC daily
- Production workflow: .github/workflows/analyze-thesis.yml
- A/B test workflow: .github/workflows/ab-test.yml (manual trigger only, requires YES confirmation)
- Steps (production): checkout → setup node → cd scripts && npm install → fetch-data.js → analyze-thesis.js → apply-analysis.js → git commit/push

## Key Field Names
- index.html reads thesis_scores (NOT thesis). Bug fixed March 3, 2026.
- fetch-data.js owns 18 fields. analyze-thesis.js/apply-analysis.js own 73 fields. x402-agent.js owns 23 fields. See data-contract.json for full list.
- kill_switches in dashboard-data.json is written by fetch-data.js but NOT read by index.html. Kill switch display comes from data/360-report.json.

## Corrections Ledger — Valid Enum Values

When Layer 4 writes entries to data/rejection-log.json, and when any code writes to data/corrections-ledger.json, use only these valid enum values:

corrections_ledger_action: auto_commit | flag_for_review | discard

root_cause_type: KNOWLEDGE_GAP | DATA_GAP | ASSUMPTION_FAILURE | APOPHENIA | BIAS | STALE_BELIEF | NARRATIVE_WEIGHT_BIAS | TEMPORAL_ILLUSION | OVERCORRECTION | SOURCE_CREDIBILITY_ERROR | CONTRADICTED_BY_DATA | INSUFFICIENT_EVIDENCE

lesson_type: FALSE_THREAT | MISSED_THREAT | MISSED_OPPORTUNITY | FALSE_CONFIDENCE | UNDER_CONFIDENCE | OVERCORRECTION | STALE_ANCHOR

status (corrections ledger): ACTIVE | SUPERSEDED | RETIRED

lesson_type definitions:
- FALSE_THREAT: System flagged a threat that was not a threat. Bear case inflated by noise.
- MISSED_THREAT: System failed to identify a genuine threat. Bear case understated.
- MISSED_OPPORTUNITY: System dismissed a positive signal. Bull case understated.
- FALSE_CONFIDENCE: System expressed high confidence in a conclusion that did not hold. Bidirectional.
- UNDER_CONFIDENCE: System assigned low severity to a signal that proved materially significant in a positive direction. Systematic UNDER_CONFIDENCE indicates bearish suppression bias.
- OVERCORRECTION: A previous lesson caused the system to overweight or dismiss a signal category, creating a new error. Bidirectional.
- STALE_ANCHOR: System anchored on outdated framing or status from a prior cycle without verifying against current data. Bidirectional.

## What's Built and Running
- Four-layer pipeline LIVE: SWEEP → CONTEXTUALIZE → INFER → RECONCILE (analyze-thesis.js)
- Layer Zero LIVE: 17 immutable rules in data/layer-zero.json, injected into L2-L4 prompts via LAYER_ZERO_RULES constant
- corrections_referenced field ENFORCED in Layer 2 and Layer 3 output (enforceCorrectionsReferenced helper with one-shot Sonnet retry)
- Automated twice-daily analysis via GitHub Actions
- Telegram briefing with pipeline health heartbeat and chunking for 4K limit
- Data contract validation (18 fetch fields checked every run)
- Corrections ledger LIVE: data/corrections-ledger.json (19 active entries)
- Rejection log LIVE: data/rejection-log.json, feeds corrections ledger pipeline
- promote-rejections.js LIVE: auto-promotes Layer 4 high-confidence rejections to corrections ledger
- Output schemas committed: Layer 2, Layer 3, Layer 4
- Dashboard on GitHub Pages
- x402 agent (12 mainnet transactions, 9,000 drops lifetime spend)

## Recursive Learning — Proof Status
- Level 1 — Loop Closure: ACHIEVED (2026-03-06T03:13:59Z). Error → lesson → application cycle completed. Layer 2 natively produced 10 corrections_referenced entries. Documented in MILESTONE-FIRST-LESSON-APPLIED.docx.
- Level 2 — Causal Impact: ACHIEVED (2026-03-06, A/B test). Bear pressure 57 (with ledger) vs 62 (without). RLUSD Cannibalization moved from scored (7) to unscored — ledger prevented confident answer to unanswerable question. Results in data/ab-test-results.json. Documented in MILESTONE-LEVEL2-CAUSAL-IMPACT.docx.
- Level 3 — Accuracy Improvement Over Time: REQUIRES WEEKS. Sunday audit tracks error rate vs Overledger size.

## Build State (as of March 6, 2026)

### Completed
- Four-layer pipeline built and live (4-layer-v1)
- Layer Zero committed (17 immutable rules, 5 categories, commit b61a69b)
- LAYER_ZERO_RULES constant wired into analyze-thesis.js (L2-L4 prompts, commit d45c455)
- corrections_referenced field enforced in Layer 2 and Layer 3
- Output schemas committed: Layer 2, Layer 3, Layer 4
- Corrections ledger live with 19 active entries
- promote-rejections.js live
- Level 1 recursive learning proof (loop closure)
- Level 2 recursive learning proof (causal impact via A/B test)
- Architecture Decision #11 documented (Layer Zero Epistemological Gate)
- Layer 2 max_tokens increased to 12000, Layer 3 and Layer 4 to 16000
- Patent filed (Patent Pending, March 5, 2026)

### Still To Build (in order)
1. Code validators (Tier 1) — deterministic checks for 8 Layer Zero rules with code-enforceable aspects
2. Gate function — runLayerZeroGate() in analyze-thesis.js, Sonnet default / Opus when code flags present
3. Gate review ledger — data/gate-review-ledger.json, Sunday audit classifies VALID_FLAG vs FALSE_FLAG
4. Wire full pipeline — Layer → code validator → gate → next layer, tags stored in orchestrator
5. Sunday audit expansion — gate flag review (HOW loop), corrections_referenced verification, hit counter updates
6. Compound indices — built on validated, gate-enforced foundation
7. Evolution Library — synthetic scenarios testing gates and validators

### Domain-Agnostic Audit Flags
- Layer 4 schema: tactical_recommendation (investment-specific enum values) and final_bear_pressure (investment terminology) should be moved to domain config file in future refactor
- All other schema fields are domain-agnostic

## Architectural Authority
If code contradicts an architectural decision document, the document wins. The code has a bug. Architectural documents live in the Claude.ai project files, not in this repo. Key documents:
- OVERWATCH-4-LAYER-ARCHITECTURE.md
- OVERWATCH-CIRCUIT-BREAKERS.md
- ARCHITECTURE-DECISION-CORRECTIONS-LEDGER.md
- ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md
- ARCHITECTURE-DECISIONS-7-AND-8.docx (Layer Zero + Structural Enforcement)
- ARCHITECTURE-DECISION-9-LESSON-TYPE-TAXONOMY.docx
- ARCHITECTURE-DECISION-10-HIT-TRACKING.docx (Recursive learning verification)
- ARCHITECTURE-DECISION-11-LAYER-ZERO-GATE.docx (Epistemological gate — DESIGNED, NOT YET BUILT)
- ARCHITECTURE-DECISION-X402-DUAL-CHANNEL-ACQUISITION.docx
- ARCHITECTURE-DECISION-DOMAIN-SELF-CALIBRATION.docx
- ARCHITECTURE-DECISION-GUIDED-THESIS-CONSTRUCTION.docx
- MILESTONE-FIRST-LESSON-APPLIED.docx (Level 1 proof)
- MILESTONE-LEVEL2-CAUSAL-IMPACT.docx (Level 2 proof)
- LAYER-2-3-4-PROMPTS-DRAFT.md (PRIVATE — never commit to public repo)
