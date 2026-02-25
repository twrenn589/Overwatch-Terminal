# DECISIONS.md
### Overwatch Terminal — Architectural Decision Log

---

## RECURSIVE LEARNING ARCHITECTURE

### Why the monthly audit reads previous audit results, not just analysis history
**Decision:** The monthly audit reads both analysis-history.json (last 60 entries) and audit-log.json (all previous audit results including deviation scores, corrections issued, and bias patterns flagged).
**Why:** Without audit history, each monthly review is independent — it might flag the same bias pattern repeatedly without knowing a correction was already issued. With audit history, the system evaluates whether its own corrections worked: Did last month's correction reduce this month's deviation? Is a bias recurring despite an active correction (meaning the correction needs rewriting)? Did retiring a correction cause a previously-fixed bias to reappear? This is second-order feedback — the audit grading itself, not just grading the analyst. This is what makes the system genuinely recursive rather than merely repetitive.
**Date:** Session 12 (Feb 24, 2026)

---

## COUNTER-THESIS ARCHITECTURE

### Why competing infrastructure is evaluated every cycle
**Decision:** SWIFT GPI, Visa B2B Connect, JPMorgan Kinexys, BIS Project Nexus, and Ethereum institutional adoption are evaluated in every analysis cycle.
**Why:** The biggest risk to the XRP thesis isn't that XRP fails — it's that something else succeeds. Competitive displacement is harder to detect than internal failure because it happens outside your monitoring perimeter. Forcing evaluation of 5 specific competitors in every cycle ensures this blind spot gets regular attention.
**Date:** Session 11 Phase 5

### Why kill switches are reviewed quarterly, not set permanently
**Decision:** Kill switches are defined during thesis construction (before data can influence thresholds) but are formally reviewed during quarterly audit cycles or when major structural changes occur.
**Why:** New information can create failure modes that didn't exist when original switches were set. The DSRV-SBI Korea corridor, for example, creates "Japan-Korea remittance volume" as a new monitorable metric — and if a competing platform captures that corridor instead of XRPL, that's a new kill switch that couldn't have been defined earlier. Reviews are formal and documented, not casual adjustments — the audit must justify why a threshold changed and what new information warranted the change. This prevents the dangerous pattern of quietly moving goalposts to avoid triggering a switch.
**Date:** Session 12 (Feb 24, 2026)

### Why the system casts wide before filtering and holds metrics longer than seems logical
**Decision:** The system monitors every credible counter-thesis narrative and potentially correlated metric without filtering. Metrics can only be deprioritized after sustained observation proves non-correlation — and the system must explain its reasoning before removing anything.
**Why:** A metric that appears uncorrelated for 60 days may suddenly move in lockstep with a thesis pillar when specific conditions emerge. China blacklisting Japanese shipbuilders doesn't obviously correlate to XRP settlement infrastructure until you trace the yen pressure transmission mechanism. Premature filtering creates blind spots in exactly the scenarios where you most need visibility. The system operates in three phases: (1) Cast wide — monitor everything, no filtering. (2) Earned correlation analysis — after 90 days, the audit recommends deprioritizing uncorrelated metrics with full reasoning. (3) Earned autonomy — after multiple audit cycles prove sound judgment, the system can deprioritize within defined boundaries without asking, but always logs what it removed and why. The user can override at any stage.
**Date:** Session 12 (Feb 24, 2026)

---

## AGENT ECONOMY / x402

### x402 micropayment agent — XRPL mainnet
**Status:** Live on XRPL mainnet. First transaction Feb 25, 2026. Multi-endpoint (3 routes), differentiated pricing, spending guardrails (balance floor, session cap, per-tx max, payment-type whitelist).
**Decision:** The Overwatch analyst agent autonomously pays for premium data feeds using x402 micropayments settled on XRPL mainnet via the T54 facilitator. Three paywalled endpoints with differentiated pricing: `/api/v1/premium-analysis` (1,000 drops), `/api/v1/bear-case` (1,500 drops), `/api/v1/stress-report` (500 drops). Spending guardrails enforce a balance floor (11 XRP), session cap (10,000 drops), per-transaction max (5,000 drops), and payment-type whitelist (Payment only). Lifetime spend is tracked in `dashboard-data.json`.
**Why:** This is the thesis made executable. If XRPL is critical infrastructure for machine-to-machine payments, the thesis monitor should itself be an economic actor on that ledger. The agent validates the x402 protocol in a real-money context while generating observable on-chain proof that the system is operational.
**Date:** Session 13 (Feb 25, 2026)

---

## FUTURE DECISIONS (PENDING)

### Humility Logic — preventing silent intelligence degradation
**Status:** Designed, not yet built.
**Intent:** When the x402 agent cannot acquire data (guardrail hit, merchant down, insufficient balance, or endpoint unavailable), the system must practice epistemic humility — acknowledging what it does *not* know rather than building a thesis on stale assumptions. The failure mode this prevents is "silent intelligence degradation": the system continuing to operate with confidence on incomplete or outdated data without telling anyone.

**Three-layer response (PACE framework):**

**Layer 1 — Flag the gap.** The agent writes a `data_gaps` array to dashboard-data.json listing which endpoints it couldn't reach and why (e.g., "bear-case: balance floor hit", "stress-report: merchant timeout"). The analyst reads this array *before* the thesis assessment — forcing a statement of limitation at the start of every briefing, not buried in a footnote.

**Layer 2 — Degrade confidence.** Missing data automatically widens uncertainty in the probability framework. If the bear-case data is stale or missing, the analyst cannot maintain high confidence in its counter-thesis score. The system should output: "Bear case assessment based on data from {timestamp} — confidence degraded. Probability ranges should be treated as ±{n}% wider than stated." This prevents the system from being confidently wrong when it's flying blind.

**Layer 3 — PACE fallbacks.** The agent maintains a data triage list per endpoint: Primary (premium source), Alternate (summary endpoint, cheaper), Contingency (free/cached data), Emergency (explicit "no data available" flag). If the primary is blocked by a guardrail, the agent works down the list. A degraded signal is better than no signal — but the system must label it as degraded rather than treating it as equivalent to the primary source.

**Why this matters:** In firefighting, a commander who loses radio contact with a crew doesn't assume they're safe — they assume the worst and adjust the plan. Overwatch follows the same principle: it is adversarial to its own certainty. Every AI agent demo shows autonomous action. None of them show autonomous restraint — the ability to say "I don't have enough information to be confident" and adjust accordingly. An agent that silently operates on stale data is more dangerous than one that refuses to operate and says why.

**Design principle:** The system should never be more confident than its data quality justifies. Humility is not a limitation — it's a feature that prevents the most dangerous failure mode in any decision system: acting with false certainty.

**Date:** Session 13 (Feb 25, 2026)
