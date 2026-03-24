# Packet: Comparative research plan for OpenCode serve topology in `opencode-bridge`

Date: 2026-03-23
Status: ready-for-review
Intent: compare `shared serve` vs `per-project serve` before selecting architecture

---

## 1. Research question

For `opencode-bridge`, which topology is better for our actual needs?

Option A:
- **shared serve**
- one OpenCode serve can host runs for multiple projects
- project context selected per attach-run/session

Option B:
- **per-project serve**
- each project gets its own OpenCode serve instance
- stronger isolation by default

This packet exists to prevent premature convergence on either option.

---

## 2. Why comparative research is required

A statement such as:
- “OpenCode technically supports many projects on one serve”

is **not enough** to conclude that shared serve is best for us.

Likewise:
- “per-project serve feels safer”

is **not enough** to conclude it is the best operating model.

We need to compare both options against our bridge requirements:
- callback correctness
- observability correctness
- execution isolation
- operational simplicity
- failure blast radius
- cost/overhead
- debugging clarity
- future scalability

---

## 3. Decision criteria

The topology choice should be evaluated against the following criteria.

## 3.1 Correctness
- Can we guarantee project/run/session correlation without ambiguity?
- Can callbacks return to the right caller session every time?
- Can observability avoid cross-project/session drift?

## 3.2 Safety
- What is the blast radius of a mis-correlation bug?
- What is the blast radius of a serve crash?
- Can permissions/config differences leak across projects?

## 3.3 Operational complexity
- How hard is startup/shutdown/reuse logic?
- How much registry complexity is required?
- How easy is debugging and operator mental model?

## 3.4 Performance and efficiency
- startup overhead
- memory/process overhead
- reuse efficiency
- contention risk under concurrent runs

## 3.5 Product fit for our workflow
- Telegram/operator workflows
- callback-driven continuation
- future multi-project orchestration
- testing and smoke reproducibility

---

## 4. Hypotheses to test

## Hypothesis A — Shared serve may be best
Shared serve may be better if:
- OpenCode session separation is reliable
- `--dir` is authoritative in practice
- observability can resolve by run/session without drift
- operational overhead reduction is meaningful

## Hypothesis B — Per-project serve may be best
Per-project serve may be better if:
- project isolation materially reduces correlation risk
- operational overhead is acceptable
- debugging and support become significantly simpler
- our product needs favor explicit project boundaries over maximum reuse

---

## 5. Research tracks

## Track 1 — Source/doc/API evidence
Collect evidence from:
- OpenCode CLI docs
- OpenCode server docs
- GitHub issues/PRs relevant to `--attach` and `--dir`
- repo-local evidence from our bridge/test observations

Key questions:
1. Does `run --attach --dir` define per-run working directory semantics clearly?
2. What OpenCode APIs are session-scoped vs server-scoped?
3. Do docs imply multi-client/multi-session support strongly enough to rely on shared serve?

---

## Track 2 — Runtime experiments
Run experiments for both topologies.

### Shared-serve experiments
1. one serve, repo A run
2. same serve, repo B run
3. inspect `/session`, `/session/status`, `/event`, `/global/event`
4. verify callback and observability separation
5. test interleaved runs and repeated runs

### Per-project-serve experiments
1. serve A for repo A
2. serve B for repo B
3. compare callback and observability clarity
4. compare startup overhead and lifecycle simplicity
5. compare failure isolation and operator ergonomics

---

## Track 3 — Bridge architecture impact
For each option, assess impact on:
- serve registry design
- run artifact design
- tool semantics
- smoke tests
- migration complexity
- long-term maintainability

---

## 6. Comparison rubric

Each option should be scored or discussed under:
- correctness
- safety
- operational simplicity
- performance
- debugging clarity
- migration effort
- future flexibility

Suggested qualitative scale:
- strong advantage
- moderate advantage
- neutral
- moderate disadvantage
- strong disadvantage

---

## 7. Expected outputs

Research should produce:
1. a comparison memo: `shared serve` vs `per-project serve`
2. a recommendation for **our** bridge, not just generic OpenCode behavior
3. a clear statement of chosen default model
4. optional note on whether the other model remains supported as a policy mode

---

## 8. Candidate outcome shapes

Possible conclusions:

### Outcome A
- Shared serve is default and recommended
- Per-project serve remains optional isolation mode

### Outcome B
- Per-project serve is default and recommended
- Shared serve remains an advanced optimization mode

### Outcome C
- Hybrid policy:
  - shared serve by default for light automation
  - per-project serve by default for callback-critical or high-isolation flows

We should not assume Outcome A in advance.

---

## 9. Immediate implication for current docs

Until research is complete:
- shared-serve contract doc is a **candidate contract**
- shared-serve migration plan is a **contingent plan**
- no architecture choice is considered final yet

---

## 10. Recommended next step after approval

1. perform comparative research
2. write decision memo
3. approve chosen topology
4. then update contract + migration plan accordingly

---

## 11. Summary

The next correct move is **not** to assume shared serve merely because it is technically possible.

The correct move is to answer:
- which topology is best for `opencode-bridge` and our operating workflow?

This packet defines the research needed to answer that question rigorously.