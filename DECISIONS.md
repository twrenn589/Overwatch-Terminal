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

### Why kill switches are reviewed quarterly, not set permanently
**Decision:** Kill switches are defined during thesis construction (before data can influence thresholds) but are formally reviewed during quarterly audit cycles or when major structural changes occur.
**Why:** New information can create failure modes that didn't exist when original switches were set. The DSRV-SBI Korea corridor, for example, creates "Japan-Korea remittance volume" as a new monitorable metric — and if a competing platform captures that corridor instead of XRPL, that's a new kill switch that couldn't have been defined earlier. Reviews are formal and documented, not casual adjustments — the audit must justify why a threshold changed and what new information warranted the change. This prevents the dangerous pattern of quietly moving goalposts to avoid triggering a switch.
**Date:** Session 12 (Feb 24, 2026)

### Why the system casts wide before filtering and holds metrics longer than seems logical
**Decision:** The system monitors every credible counter-thesis narrative and potentially correlated metric without filtering. Metrics can only be deprioritized after sustained observation proves non-correlation — and the system must explain its reasoning before removing anything.
**Why:** A metric that appears uncorrelated for 60 days may suddenly move in lockstep with a thesis pillar when specific conditions emerge. China blacklisting Japanese shipbuilders doesn't obviously correlate to XRP settlement infrastructure until you trace the yen pressure transmission mechanism. Premature filtering creates blind spots in exactly the scenarios where you most need visibility. The system operates in three phases: (1) Cast wide — monitor everything, no filtering. (2) Earned correlation analysis — after 90 days, the audit recommends deprioritizing uncorrelated metrics with full reasoning. (3) Earned autonomy — after multiple audit cycles prove sound judgment, the system can deprioritize within defined boundaries without asking, but always logs what it removed and why. The user can override at any stage.
**Date:** Session 12 (Feb 24, 2026)
