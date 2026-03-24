# Packet: Migration plan for per-project serve default in `opencode-bridge`

Date: 2026-03-23
Status: draft-for-review
Depends on: `docs/contracts/per-project-serve-contract-2026-03-23.md`
Intent: align implementation and docs with the chosen default topology

Related:
- Decision memo: `docs/packets/2026-03-23-serve-topology-decision-memo.md`
- Shared-serve candidate migration plan (archived): `docs/packets/2026-03-23-shared-serve-migration-plan.md`

---

## 1. Objective

Align `opencode-bridge` with the chosen default topology:
- **per-project serve**

This plan focuses on improving correctness, wording, and operator clarity while retaining strong run/session correlation.

---

## 2. Migration goals

1. make per-project serve the explicit documented default
2. remove accidental ambiguity introduced by the shared-serve hypothesis phase
3. keep callback/origin session integrity strong
4. keep observability run/session-aware
5. preserve room for future shared-serve mode without making it default now

---

## 3. Phase plan

## Phase 1 — Doc cleanup
Update docs so the canonical message is:
- default = per-project serve
- shared serve = researched but non-default future option

Targets:
- README files
- architecture docs
- install/debug docs
- any contract text still implying unresolved topology choice

---

## Phase 2 — Tool semantics cleanup
Clarify tool descriptions and runtime comments.

Examples:
- `opencode_serve_spawn` should explicitly describe project-default serve behavior
- `opencode_execute_task` should clearly describe per-project default reuse/spawn semantics
- observability tools should mention run/session correlation as first-class

---

## Phase 3 — Runtime hardening
Review code paths for:
- stale serve registry handling
- safe project-bound reuse checks
- fail-closed behavior when binding cannot be confirmed
- stronger status artifact semantics where needed

---

## Phase 4 — Observability hardening
Ensure:
- run/session correlation remains primary for callback integrity
- serve-level assumptions are used carefully
- status/events/tail surfaces remain trustworthy under the default model

---

## Phase 5 — Test and smoke updates
Required focus:
- per-project serve default smoke
- stale registry recovery
- callback integrity
- current caller session integrity
- observability consistency

Optional future test bucket:
- experimental shared-serve mode, if revisited later

---

## 4. Non-goals

1. no shared-serve implementation as default
2. no broad registry redesign toward shared serve right now
3. no removal of run/session-aware correlation logic
4. no destructive migration of old files unless later required

---

## 5. Risks and mitigations

### Risk
Team confusion due to recently explored shared-serve direction.

### Mitigation
Add explicit cross-links and status markers across docs.

### Risk
Per-project serve may seem less efficient.

### Mitigation
Document that this is a deliberate safety-first default, not a claim about absolute technical efficiency.

---

## 6. Summary

This is the active migration plan for the currently selected default direction:
- **per-project serve by default**
- **run/session correlation remains first-class**
- **shared serve remains future optional territory only**
