# Packet: Shared-serve migration plan candidate for `opencode-bridge`

Date: 2026-03-23
Status: archived-contingent-candidate
Depends on: `docs/contracts/multi-project-shared-serve-contract-2026-03-23.md`
Intent: preserve the migration thinking for the shared-serve option explored during research

> Review note: this packet is **not** the active migration plan. It is retained only as the candidate migration path for the shared-serve option, which was not selected as the current default direction.

Related:
- Decision memo: `docs/packets/2026-03-23-serve-topology-decision-memo.md`
- Research plan: `docs/packets/2026-03-23-serve-topology-research-plan.md`

---

## 1. Why this file is retained

This file preserves the migration outline that would be relevant **if** `shared serve` is chosen in the future.

It should not be used as the active implementation plan for the current bridge direction.

---

## 2. Candidate objective

The candidate objective of this plan was to migrate `opencode-bridge` away from the assumption:
- `1 project = 1 OpenCode serve`

toward:
- `serve = shared runtime endpoint`
- `project context = attach-run / session / run correlation`

This remains a valid future candidate path, but is not the selected default today.

---

## 3. Why it is not active now

Research and decision review concluded that:
- shared serve is technically feasible
- but per-project serve is the safer current default for callback correctness, observability clarity, and operator ergonomics

Therefore this packet is archived as a contingent candidate only.

---

## 4. What remains useful here

If shared serve is revisited later, the following themes from the original plan remain useful:
- serve registry vs run/session registry split
- run/session-first observability
- tool semantic cleanup around serve identity
- compatibility-first migration thinking
- multi-project same-serve test matrix

---

## 5. Current instruction

Do not execute this migration plan unless a later decision memo explicitly re-activates shared serve as a chosen direction.

---

## 6. Summary

This file remains as an **archived contingent candidate** for future reference only.

The current chosen direction should be driven by the topology decision memo instead:
- `docs/packets/2026-03-23-serve-topology-decision-memo.md`
