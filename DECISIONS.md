# DECISIONS.md
### Overwatch Terminal — Architectural Decision Log

---

## RECURSIVE LEARNING ARCHITECTURE

### Why the monthly audit reads previous audit results, not just analysis history
**Decision:** The monthly audit reads both analysis-history.json (last 60 entries) and audit-log.json (all previous audit results including deviation scores, corrections issued, and bias patterns flagged).
**Why:** Without audit history, each monthly review is independent — it might flag the same bias pattern repeatedly without knowing a correction was already issued. With audit history, the system evaluates whether its own corrections worked: Did last month's correction reduce this month's deviation? Is a bias recurring despite an active correction (meaning the correction needs rewriting)? Did retiring a correction cause a previously-fixed bias to reappear? This is second-order feedback — the audit grading itself, not just grading the analyst. This is what makes the system genuinely recursive rather than merely repetitive.
**Date:** Session 12 (Feb 24, 2026)
