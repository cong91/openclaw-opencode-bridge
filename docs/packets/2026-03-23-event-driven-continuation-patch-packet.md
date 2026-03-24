# Packet: Event-driven continuation contract for `opencode-bridge`

Date: 2026-03-23
Project: `opencode-bridge`
Status: ready-for-execution
Owner intent: remove bridge-side watcher/supervisor loop permanently and complete callback-driven continuation groundwork

---

## 1. Objective

Patch `opencode-bridge` so that:

1. bridge execution stays fire-and-record only
2. OpenCode-side plugin remains the only terminal callback authority
3. callback payload carries structured continuation metadata
4. run artifact persists continuation intent for the origin session
5. observability surfaces expose continuation state
6. no bridge-side watcher/supervisor/retry loop is reintroduced

This packet prepares the repo for event-driven continuation. It does **not** require implementing a full outer-session state machine inside this repo.

---

## 2. Confirmed source facts from current repo

### 2.1 Execution launch path
- `opencode_execute_task` resolves agent, spawns serve, builds envelope, builds prompt, then calls `startExecutionRun(...)`.
- File: `src/registrar.ts`
- Runtime entry: `src/runtime.ts`

### 2.2 Current `startExecutionRun()` behavior
Current runtime already has watcher path removed from execution path.
It now:
- writes initial run artifact
- runs `runAttachExecutionForEnvelope(...)`
- resolves `sessionId` from tagged session list
- patches run artifact to `running` or `failed`
- returns immediately

No active bridge-side callback loop is started.

### 2.3 Plugin callback authority
`opencode-plugin/openclaw-bridge-callback.ts`:
- caches tags from session title
- only callbacks on terminal events: `session.idle` or `session.error`
- dedupes callbacks via `sessionId|runId`
- POSTs to `/hooks/agent`

### 2.4 Current callback payload limitation
Current plugin callback payload only contains:
- `message`
- `name`
- `agentId`
- `sessionKey`
- `sessionId`
- `wakeMode`
- `deliver`

The payload does **not** yet carry rich machine-readable continuation metadata as a first-class contract.

### 2.5 Current observability/read surfaces
Repo already exposes:
- `opencode_run_status`
- `opencode_run_events`
- `opencode_session_tail`

These surfaces already prioritize callback/origin session correlation over execution session correlation.

### 2.6 Known contract drift
- `opencode_execute_task` description in `src/registrar.ts` still mentions SSE watcher/callback loop behavior.
- `buildHookPolicyChecklist()` still suggests `allowedSessionKeyPrefixes: [HOOK_PREFIX]`, while actual callback target session key is origin-session scoped, not execution-session scoped.

---

## 3. Non-goals

This patch must **not**:
- reintroduce `watchRunToTerminal()` into the execution path
- reintroduce auto-retry supervisor logic into the bridge execution path
- make bridge poll in background waiting for terminal events
- implement a long-lived workflow daemon inside the gateway
- assume callback text parsing without a structured contract

---

## 4. Desired end state

After patch:

### 4.1 `opencode_execute_task`
Should:
- accept optional continuation metadata
- persist continuation metadata into run artifact
- return immediately after execution launch
- explicitly report `callbackAuthority: "opencode_plugin"`
- explicitly report continuation enabled/disabled

### 4.2 OpenCode-side plugin callback
Should:
- still callback only once on terminal event
- include structured callback metadata in a deterministic machine-readable format
- include correlation fields required for origin-session continuation

### 4.3 Run artifact
Should persist:
- workflow id / step id if provided
- success/failure continuation instructions if provided
- callback event kind marker

### 4.4 Read surfaces
Should expose continuation metadata so origin-session logic can read state and branch without guessing.

---

## 5. Per-file patch plan

## 5.1 `src/types.ts`

### Changes
Add a new structured continuation section to `BridgeRunStatus`.

#### Add type
```ts
export type OpenCodeRunContinuation = {
  workflowId?: string;
  stepId?: string;
  callbackEventKind?: "opencode.callback";
  nextOnSuccess?: {
    action: "launch_run" | "notify" | "none";
    taskId?: string;
    objective?: string;
    prompt?: string;
  };
  nextOnFailure?: {
    action: "launch_run" | "notify" | "none";
    taskId?: string;
    objective?: string;
    prompt?: string;
  };
};
```

#### Extend `BridgeRunStatus`
```ts
continuation?: OpenCodeRunContinuation;
```

#### Add callback metadata type
```ts
export type OpenCodeContinuationCallbackMetadata = {
  kind: "opencode.callback";
  eventType: string;
  runId?: string;
  taskId?: string;
  projectId?: string;
  repoRoot?: string;
  requestedAgentId?: string;
  resolvedAgentId?: string;
  callbackTargetSessionKey?: string;
  callbackTargetSessionId?: string;
  opencodeSessionId?: string;
  workflowId?: string;
  stepId?: string;
};
```

### Acceptance checks
- typecheck passes
- no existing tests broken by added optional fields

---

## 5.2 `src/registrar.ts`

### Changes

#### A. Extend `opencode_execute_task` parameters
Add optional input properties:
- `workflowId`
- `stepId`
- `nextOnSuccess`
- `nextOnFailure`

#### B. Pass continuation object into `startExecutionRun(...)`
Expected shape:
```ts
continuation: {
  workflowId: asString(params.workflowId),
  stepId: asString(params.stepId),
  callbackEventKind: "opencode.callback",
  nextOnSuccess: params.nextOnSuccess,
  nextOnFailure: params.nextOnFailure,
}
```

#### C. Fix description drift
Update tool description from old watcher wording to wording aligned with current runtime:
- launch attach-run
- persist artifact
- rely on OpenCode-side plugin for terminal callback

#### D. Extend output JSON
Inside `execution` return:
```ts
callbackAuthority: "opencode_plugin",
continuationEnabled: Boolean(params.workflowId || params.stepId || params.nextOnSuccess || params.nextOnFailure),
```

#### E. Expose continuation in read surfaces
Where tool responses already include artifact/runStatus, ensure `continuation` is returned.
Especially for:
- `opencode_run_status`
- `opencode_run_events` (if artifact available)
- `opencode_session_tail` (if artifact available)

### Acceptance checks
- `opencode_execute_task` still launches successfully
- tool output includes continuation fields when provided
- description no longer mentions watcher loop

---

## 5.3 `src/runtime.ts`

### Changes

#### A. Extend `startExecutionRun(...)` input type
Add optional `continuation` argument.

#### B. Persist continuation into initial run artifact
When building `initial: BridgeRunStatus`, include:
```ts
continuation: input.continuation,
```

#### C. Preserve continuation on subsequent patch updates
When patching run artifact after attach-run start/failure, continuation must remain intact.

#### D. Add helper to build structured callback metadata from run artifact
Add function:
```ts
export function buildContinuationCallbackMetadata(input: {
  runStatus: BridgeRunStatus;
  eventType: string;
})
```

Expected output fields:
- `kind: "opencode.callback"`
- `eventType`
- `runId`
- `taskId`
- `projectId`
- `repoRoot`
- `requestedAgentId`
- `resolvedAgentId`
- `callbackTargetSessionKey`
- `callbackTargetSessionId`
- `opencodeSessionId`
- `workflowId`
- `stepId`

#### E. Fix callback hook policy checklist
`buildHookPolicyChecklist()` must stop implying callback target session key must share `HOOK_PREFIX`.

Target behavior:
- keep `HOOK_PREFIX` only as execution session convention
- explicitly document that callback target session key is origin-session scoped
- do **not** require `allowedSessionKeyPrefixesMustInclude: HOOK_PREFIX` for callback target validation

Suggested replacement payload:
```ts
{
  primaryCallbackPath: "/hooks/agent",
  requirements: {
    hooksEnabled: true,
    allowRequestSessionKey: true,
    allowedAgentIdsMustInclude: agentId,
    callbackTargetSessionKeyMustBeExplicit: true,
    executionSessionKeyPrefix: HOOK_PREFIX,
    deliverDefault: false,
  },
  sessionKey,
  suggestedConfig: {
    hooks: {
      enabled: true,
      allowRequestSessionKey: true,
      allowedAgentIds: [agentId],
    },
  },
  note: "callback target session keys are origin-session scoped and are not required to share the execution HOOK_PREFIX"
}
```

#### F. Cleanup dead legacy logic
Remove dead code that is no longer part of canonical runtime flow:
- `maybeSendTerminalCallback`
- `watchRunToTerminal`
- `shouldAutoRetryRun`
- terminal bridge callback helpers used only by watcher flow

If removal is too large for one patch, at minimum:
- do not rewire them into runtime
- mark them deprecated in comments
- ensure no production path references them

### Acceptance checks
- `startExecutionRun()` persists continuation object
- no bridge-side watcher path is started
- hook checklist no longer mismatches origin session routing
- build and typecheck pass

---

## 5.4 `opencode-plugin/openclaw-bridge-callback.ts`

### Changes

#### A. Add structured callback metadata builder
Create helper based on parsed title tags and session id.

Expected metadata object:
```ts
{
  kind: "opencode.callback",
  eventType,
  runId,
  taskId,
  projectId,
  repoRoot,
  requestedAgentId,
  resolvedAgentId,
  callbackTargetSessionKey,
  callbackTargetSessionId,
  opencodeSessionId,
  workflowId,
  stepId,
}
```

#### B. Encode metadata into callback payload `message`
Because current `/hooks/agent` payload shape appears text-centric, use deterministic JSON string in `message`.

Target:
```ts
message: JSON.stringify(metadata)
```

Do not send free-form prose as the primary contract.

#### C. Enrich metadata extraction from title tags
Current title tags already support:
- `runId`
- `taskId`
- `requested`
- `resolved`
- `callbackSession`
- `callbackSessionId`
- `projectId`
- `repoRoot`

If `workflowId` / `stepId` are added to title tags later, plugin should pass them through when present.

#### D. Extend audit rows
Write metadata-rich audit rows containing:
- `projectId`
- `repoRoot`
- `runId`
- `taskId`
- `requestedAgentId`
- `resolvedAgentId`
- `callbackTargetSessionKey`
- `callbackTargetSessionId`
- `opencodeSessionId`
- `eventType`

#### E. Keep terminal authority + dedupe semantics
Do **not** widen callback authority away from plugin.
Keep dedupe once semantics intact.

### Acceptance checks
- plugin still callbacks once on `session.idle`
- callback payload `message` is valid JSON string
- callback metadata contains required fields
- plugin audit still writes successfully

---

## 5.5 `src/shared-contracts.ts`

### Changes
Optional but recommended in this same execution packet if continuation should be recoverable directly from OpenCode session title.

#### A. Extend `BridgeSessionTagFields`
Add optional:
- `workflowId?: string`
- `stepId?: string`

#### B. Extend `buildTaggedSessionTitle(...)`
Append when present:
- `workflowId=<...>`
- `stepId=<...>`

#### C. Keep parser generic
`parseTaggedSessionTitle()` already generically parses `key=value` tokens, so no heavy parser rewrite should be required.

### Acceptance checks
- old title parsing remains backward compatible
- new tags survive roundtrip through build + parse

---

## 5.6 `test/execution-callback-loop.test.ts`

### Changes
Update or extend test so that when continuation params are provided:
- execution still returns immediately
- `watcherStarted === false`
- `callbackAuthority === "opencode_plugin"`
- run artifact contains persisted `continuation`

### Expected assertions
- `runStatus.state === "running"`
- `runStatus.continuation.workflowId === ...`
- `runStatus.continuation.stepId === ...`
- no callback emitted by bridge itself

---

## 5.7 `test/plugin-callback-contract.test.ts`

### Changes
Extend test to parse callback payload `message` as JSON.

### Expected assertions
Parsed message JSON contains:
- `kind === "opencode.callback"`
- `runId`
- `taskId`
- `requestedAgentId`
- `resolvedAgentId`
- `callbackTargetSessionKey`
- `callbackTargetSessionId`

If title tag packet includes `workflowId` / `stepId`, assert those too.

---

## 5.8 `test/plugin-openclaw-audit-bridge.test.ts`

### Changes
Extend audit assertions so mirrored OpenClaw audit row includes richer fields:
- `projectId`
- `repoRoot`
- `runId`
- `taskId`

If implemented:
- `workflowId`
- `stepId`

---

## 5.9 `test/runtime-integrity.test.ts`

### Changes
Add test covering fixed policy checklist semantics.

### Expected assertions
- checklist no longer requires callback target session key to share `HOOK_PREFIX`
- checklist still documents execution session prefix convention separately

Also add a small artifact persistence test if easier than asserting through full tool path.

---

## 5.10 `docs/opencode-side-plugin-bridge-design-2026-03-21.md`

### Changes
Update design doc to reflect canonical callback contract:
- plugin is terminal authority
- bridge does not wait in a loop
- callback carries structured metadata
- continuation is resumed by origin session in a later event-driven turn

Add explicit sample callback payload using JSON string metadata in `message`.

---

## 5.11 `docs/architecture/hybrid-execution-strategy-2026-03-22.md`

### Changes
Add one short section clarifying:
- serve/plugin mode is canonical for terminal callback
- continuation is origin-session event-driven
- no bridge-side long-lived watcher/supervisor loop in canonical runtime path

---

## 5.12 `README.md` and `README.en.md`

### Changes
Sync runtime description with actual code:
- OpenClaw side: launch + state + observability
- OpenCode-side plugin: terminal callback authority
- continuation: event-driven by origin session / outer orchestration

Remove wording that implies bridge still performs watcher-loop terminal closeout.

---

## 6. Implementation order

### Batch 1 — contract + runtime persistence
1. `src/types.ts`
2. `src/runtime.ts`
3. `src/registrar.ts`
4. `opencode-plugin/openclaw-bridge-callback.ts`
5. `test/execution-callback-loop.test.ts`
6. `test/plugin-callback-contract.test.ts`
7. `test/runtime-integrity.test.ts`

### Batch 2 — optional title-tag enrichment + audit hardening
8. `src/shared-contracts.ts`
9. `test/plugin-openclaw-audit-bridge.test.ts`

### Batch 3 — docs sync
10. `docs/opencode-side-plugin-bridge-design-2026-03-21.md`
11. `docs/architecture/hybrid-execution-strategy-2026-03-22.md`
12. `README.md`
13. `README.en.md`

---

## 7. Validation checklist

Execution patch is acceptable only if all are true:

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `opencode_execute_task` returns immediately without watcher loop
- [ ] bridge run artifact persists continuation metadata
- [ ] OpenCode-side plugin callback `message` is structured JSON string
- [ ] plugin still dedupes callback once on terminal event
- [ ] no bridge-side POST `/hooks/agent` occurs during execution launch path
- [ ] docs/tool descriptions no longer mention watcher-loop terminal closeout as current behavior

---

## 8. Suggested task breakdown for execution assignee

### Task A — runtime contract + artifact persistence
Files:
- `src/types.ts`
- `src/runtime.ts`
- `src/registrar.ts`
- `test/execution-callback-loop.test.ts`
- `test/runtime-integrity.test.ts`

Deliverable:
- continuation persisted into run artifact
- tool schema/output updated
- policy checklist fixed

### Task B — plugin callback contract hardening
Files:
- `opencode-plugin/openclaw-bridge-callback.ts`
- `src/shared-contracts.ts` (if needed)
- `test/plugin-callback-contract.test.ts`
- `test/plugin-openclaw-audit-bridge.test.ts`

Deliverable:
- structured callback metadata in `message`
- richer audit fields
- optional workflow/step tags in title contract

### Task C — docs sync
Files:
- `docs/opencode-side-plugin-bridge-design-2026-03-21.md`
- `docs/architecture/hybrid-execution-strategy-2026-03-22.md`
- `README.md`
- `README.en.md`

Deliverable:
- docs aligned with code reality

---

## 9. Handoff note for assignee

Do not add any background polling loop, watcher thread, or supervisor retry mechanism back into the bridge execution path.

Canonical runtime rule for this patch:
- launch
- persist
- callback from plugin
- origin session resumes on later event-driven turn

Anything that waits in-process for terminal completion is out of scope and considered regression.
