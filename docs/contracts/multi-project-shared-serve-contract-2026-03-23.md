# Shared-serve candidate contract for `opencode-bridge`

Date: 2026-03-23
Status: archived-candidate
Intent: preserve the shared-serve hypothesis explored during topology research

> Review note: this document records the `shared serve` candidate model explored during research. It is **not** the selected default architecture. See the decision memo for the chosen direction.

Related:
- Decision memo: `docs/packets/2026-03-23-serve-topology-decision-memo.md`
- Research plan: `docs/packets/2026-03-23-serve-topology-research-plan.md`

---

## 1. Why this document exists

Current bridge reasoning and parts of the implementation were built around the assumption:

- `1 OpenCode serve = 1 project`

That assumption is too strong if evaluated as a universal OpenCode runtime truth.

The alternative model explored in research was:

- **1 OpenCode serve can host executions for many projects**
- project context is selected at **attach-run/session/run time**
- `--dir` and per-run/session correlation are the canonical project-binding signals

This document keeps that explored model on record as a candidate, not as the chosen default.

---

## 2. Candidate mental model

## 2.1 Serve identity
A serve instance is a:
- runtime endpoint
- transport/control plane surface
- health + API host

In the shared-serve candidate model, a serve instance is **not** the canonical owner of a single project.

## 2.2 Project identity
Project execution context belongs to:
- the attach-run invocation
- the created OpenCode session
- the run artifact + callback correlation

Canonical project signals are:
- `repoRoot`
- `projectId` when provided by caller/bridge
- `runId`
- `taskId`
- OpenCode `sessionId`
- session title tags
- callback metadata

## 2.3 Research caveat
Runtime experiments showed an important asymmetry:
- session-level directory can point to repo B
- while server-level `/path` and `/project/current` can remain anchored to repo A

This is the main reason shared serve was not selected as the default architecture at this time.

---

## 3. Why this model was not selected as default

Shared serve remains interesting, but was not selected because:
- server-level project/path surfaces can be misleading under multi-project use
- observability and debugging become more correlation-sensitive
- current bridge maturity favors safer defaults over maximum reuse efficiency

---

## 4. Retained value from this candidate

Even though shared serve was not chosen as default, this candidate model contributed important design lessons:
- serve-level project identity is weaker than assumed
- run/session correlation must remain first-class
- callback routing must stay origin-session scoped
- observability should not over-trust server-level project/path surfaces

---

## 5. Future status

Shared serve may still return later as:
- optional optimization mode
- advanced operator policy
- explicitly enabled runtime topology

But not as the current default contract.

---

## 6. Summary

This file is retained as an **archived candidate contract** for future reference.

Chosen default direction is documented in:
- `docs/packets/2026-03-23-serve-topology-decision-memo.md`
