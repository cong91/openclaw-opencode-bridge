# Decision memo: OpenCode serve topology for `opencode-bridge`

Date: 2026-03-23
Status: draft-for-review
Decision scope: choose the recommended default topology for bridge architecture

---

## 1. Question

Which topology is better for `opencode-bridge`?

Option A:
- **shared serve**
- one OpenCode serve hosts runs for multiple projects

Option B:
- **per-project serve**
- each project gets its own OpenCode serve by default

---

## 2. Research evidence collected

## 2.1 External doc evidence

### OpenCode CLI docs
Observed evidence from OpenCode CLI docs:
- `opencode run --attach <url>` is a supported automation path
- `opencode attach` documents `--dir`
- OpenCode server docs describe the serve endpoint as a headless HTTP server that supports multiple clients

Interpretation:
- OpenCode clearly supports remote/server-backed interaction
- docs are consistent with multi-client usage
- docs do **not** by themselves prove that shared-serve is the best architecture for our bridge

### External issue evidence
Observed issue surfaces:
- feature request for `opencode run --attach --dir` support
- issue showing `opencode attach --dir` does not fully pick up some project commands in attached mode

Interpretation:
- `--dir` matters and is actively relevant to OpenCode workflows
- attached/remote directory semantics may still have edge cases
- this weakens confidence in using shared serve as the default safety model for our bridge today

---

## 2.2 Runtime experiment evidence

### Experiment setup
We ran a direct experiment:
1. start one OpenCode serve in `repo-a`
2. attach a run to the same serve with `--dir repo-b`
3. inspect server-level and session-level surfaces

### Observed facts
#### Server-level surfaces stayed anchored to repo A
Before and after the attached run, the serve reported:
- `/path.directory = repo-a`
- `/project/current.worktree = repo-a`

#### Session-level surface recorded repo B correctly
The attached run created a session with:
- `directory = repo-b`
- title tags pointing to repo B
- attach exit code `0`

#### Important asymmetry
This means the same serve can host a session for repo B while server-level project/path endpoints still reflect repo A.

### Interpretation
This is the strongest finding from research:
- **shared serve is technically possible**
- but **server-level project/path surfaces are not authoritative proof of the active project context for all sessions on that serve**

This creates a real operator and implementation risk:
- any code or human workflow that reasons from serve-level project binding can be misled

---

## 3. Comparative evaluation

## 3.1 Shared serve

### Advantages
- lower process overhead
- faster warm reuse potential
- simpler infrastructure footprint
- technically compatible with session-level project separation

### Disadvantages
- server-level project/path surfaces become misleading for multi-project interpretation
- observability must be much more careful and correlation-heavy
- debugging becomes less obvious to operators
- one mistake in correlation logic has larger blast radius
- attached-mode project behavior appears to have edge cases in upstream issue history

### Assessment
Shared serve looks like a **valid advanced capability**, but currently a **higher-risk default** for our bridge.

---

## 3.2 Per-project serve

### Advantages
- clearer mental model for operators
- safer default for callback/observability correctness
- `/project/current` and `/path` remain aligned with the project being served
- easier debugging and incident triage
- smaller blast radius when something drifts
- better fit for current bridge maturity level

### Disadvantages
- more processes
- more startup/reuse overhead
- more lifecycle management cost
- potentially less efficient under high fan-out workloads

### Assessment
Per-project serve is operationally heavier, but offers a much safer and clearer default for the bridge we have today.

---

## 4. Recommendation

## Recommended default
For `opencode-bridge`, the recommended default topology is:
- **per-project serve**

## Why
Because our current priorities are:
1. callback correctness
2. observability correctness
3. operator clarity
4. failure containment

On those axes, per-project serve currently wins.

## Important nuance
This recommendation does **not** mean shared serve is impossible or useless.

It means:
- shared serve should be treated as an **optional future optimization / advanced mode**
- not the default architecture until the bridge has stronger session/run correlation guarantees and stronger multi-project same-serve hardening

---

## 5. Chosen position

### Default position
- `per-project serve` is the canonical default operating model for now

### Allowed future extension
- `shared serve` may be supported later as an explicit policy mode
- only after stronger tests, observability guarantees, and operator ergonomics are in place

---

## 6. Implications for docs and architecture

## 6.1 What changes from earlier drafts
The earlier shared-serve hypothesis docs should now be interpreted as:
- useful research artifacts
- not the selected default direction

## 6.2 What the official contract should say
The official contract should say:
- default topology = per-project serve
- shared serve is not forbidden, but is non-default
- bridge correctness must still remain run/session-aware
- project safety must never rely on weak cross-project assumptions

## 6.3 Why this is not a total rollback
Even with per-project serve as default, the research still taught us something important:
- **serve-level project identity is weaker than we first assumed**
- session/run correlation remains important

So the official design should keep:
- strong run/session correlation
- explicit callback target session identity
- fail-closed safety around project/run mismatch

---

## 7. Approval requested

Please review/approve the following:

1. default topology for `opencode-bridge` should be `per-project serve`
2. shared serve remains a possible future advanced mode, not default
3. official contract/migration docs should be rewritten accordingly
4. implementation should continue from the per-project default model, with better wording and stronger correlation discipline

---

## 8. Summary

### Research conclusion
- shared serve is **technically feasible**
- per-project serve is **currently the better default for us**

### Final recommendation
- choose **per-project serve as default**
- keep **shared serve as future optional optimization mode**
- update official contract and migration plan to reflect that decision
