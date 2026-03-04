# Overwatch Terminal — Claude Code Context

## What This Is
Autonomous AI intelligence system monitoring an institutional adoption thesis. Four-layer cognitive architecture (SWEEP → CONTEXTUALIZE → INFER → RECONCILE) with epistemological guardrails, circuit breakers, and a corrections ledger. Running in production on GitHub Actions, twice daily. Built entirely by directing AI tools — the builder has zero coding background.

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
- scripts/fetch-data.js — Data pipeline, 7 active API sources, writes dashboard-data.json, runs data contract validation
- scripts/analyze-thesis.js — Four-layer Claude API pipeline (SWEEP → CONTEXTUALIZE → INFER → RECONCILE), writes 360-report.json + 360-history.json, sends Telegram briefing with pipeline health line
- scripts/apply-analysis.js — Merges analysis results into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress fields)
- scripts/x402-agent.js — XRPL mainnet payment agent (manual trigger only)
- scripts/promote-rejections.js — Transforms Layer 4 auto_commit rejections into corrections ledger entries, runs after every Layer 4 pass
- scripts/thesis-context.md — Thesis context fed to Claude API analyst. Lives in scripts/, NOT repo root.
- scripts/pipeline-health.json — Written by fetch-data.js validation, read by analyze-thesis.js for Telegram heartbeat
- data-contract.json — Lists every field index.html expects from dashboard-data.json. Source of truth for validation.
- data/360-report.json — Latest analysis output
- data/360-history.json — Archive of all assessments (last 60 entries)
- data/corrections-ledger.json — 8 active corrections (CL-001 through CL-008), read by Layers 2 and 3 during live analysis
- data/rejection-log.json — Layer 4 rejection log, 11 entries all resolved
- index.html — Dashboard frontend, reads dashboard-data.json on load

## Data Flow
fetch-data.js writes dashboard-data.json (partial: macro, rlusd, xrp, thesis_scores) → validates against data-contract.json → writes pipeline-health.json → analyze-thesis.js runs Claude API → writes 360-report.json + 360-history.json → sends Telegram with pipeline health appended → apply-analysis.js merges analysis into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress) → git commit + push

## GitHub Actions
- Cron: 12:00 UTC and 00:00 UTC daily
- Workflow: .github/workflows/analyze-thesis.yml
- Steps: checkout → setup node → npm install → fetch-data.js → analyze-thesis.js → apply-analysis.js → git commit/push

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
- Automated twice-daily analysis via GitHub Actions
- Telegram briefing with pipeline health heartbeat and chunking for 4K limit
- Data contract validation (21 fetch fields checked every run)
- Corrections ledger LIVE: data/corrections-ledger.json (8 active entries, CL-001 through CL-008)
- Rejection log LIVE: data/rejection-log.json (11 entries, all resolved)
- promote-rejections.js LIVE: auto-promotes Layer 4 high-confidence rejections to corrections ledger
- Dashboard on GitHub Pages
- x402 agent (12 mainnet transactions, 9,000 drops lifetime spend)

## Build State (as of March 4, 2026)

### Completed (Sessions through March 4, 2026)
- Four-layer pipeline built and live: SWEEP → CONTEXTUALIZE → INFER → RECONCILE
- Corrections ledger live with 8 active entries (CL-001 through CL-008)
- Rejection log live with 11 entries, all resolved
- promote-rejections.js live: auto-promotes high-confidence Layer 4 rejections
- thesis-context.md updated with March 2026 market data and compound stress matrix
- Data contract validation wired into fetch-data.js
- Pipeline heartbeat appended to Telegram briefings
- Architecture Decision #9 documented: bidirectional lesson_type taxonomy

### Current State (as of March 4, 2026)
Four-layer pipeline is live and running in production. The git stash from the Layer 2 session has been popped and committed. All four layers (runSweep, runContextualize, runInfer, runReconcile) are wired and running. Pipeline version: 4-layer-v1.

### Still To Build
- Layer Zero definition (layer-zero.json) — immutable epistemological foundation
- Output schemas: schema-layer2-output.json, schema-layer3-output.json, schema-layer4-output.json
- Validation functions: validateLayer2Output(), validateLayer3Output(), validateLayer4Output() wired into analyze-thesis.js
- Compound kill switch indices (5 designed, pending schema enforcement foundation)
- Evolution Library Phase 1 (first synthetic scenario)
- Verified Facts Ledger

### Key Decision: Option C3 — COMPLETED
All four layers were built and tested before dashboard changes. One coordinated commit. Progressive isolation testing was used — each layer tested against the previous layer's output before integration.

### Test Approach
- Local test scripts call the API with real pipeline data as fixtures
- Opus times out locally (SDK default timeout) — add timeout: 300000 to Anthropic client, or test with Sonnet locally and let GitHub Actions validate Opus
- Each layer's test output becomes the next layer's test input

## Architectural Authority
If code contradicts an architectural decision document, the document wins. The code has a bug. Architectural documents live in the Claude.ai project files, not in this repo. Key documents:
- OVERWATCH-4-LAYER-ARCHITECTURE.md
- OVERWATCH-CIRCUIT-BREAKERS.md
- ARCHITECTURE-DECISION-CORRECTIONS-LEDGER.md
- ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md
- ARCHITECTURE-DECISIONS-7-AND-8.docx
- ARCHITECTURE-DECISION-X402-DUAL-CHANNEL-ACQUISITION.docx
- ARCHITECTURE-DECISION-DOMAIN-SELF-CALIBRATION.docx
- ARCHITECTURE-DECISION-GUIDED-THESIS-CONSTRUCTION.docx
- ARCHITECTURE-DECISION-9-LESSON-TYPE-TAXONOMY.docx
- LAYER-2-3-4-PROMPTS-DRAFT.md (PRIVATE — never commit to public repo)
