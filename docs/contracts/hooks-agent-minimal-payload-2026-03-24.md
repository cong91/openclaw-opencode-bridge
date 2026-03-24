# `/hooks/agent` minimal payload contract

Date: 2026-03-24
Status: working-contract
Scope: canonical minimal payload for systems that wake a specific OpenClaw agent/session through gateway hooks

---

## 1. Purpose

This document defines the minimum safe payload for:
- TAA backend wake flows
- `opencode-bridge` callback flows
- any future producer that must wake a specific agent/session through OpenClaw gateway

The goal is to standardize the delivery/wake envelope before any higher-level orchestration logic.

---

## 2. Endpoint

- `POST /hooks/agent`

Authentication:
- `x-openclaw-token: <token>`
- or gateway-supported equivalent bearer form when configured

---

## 3. Canonical minimal payload

```json
{
  "message": "string (required)",
  "agentId": "string (required)",
  "sessionKey": "string (required unless relying on defaultSessionKey)",
  "sessionId": "string (optional)",
  "name": "string (optional)",
  "wakeMode": "now",
  "deliver": false
}
```

---

## 4. Required fields

### `message`
- Required
- String only
- This is the actual payload delivered into the target session lane
- Recommended: use a machine-readable JSON string for automation workflows

### `agentId`
- Required
- Must be present in `hooks.allowedAgentIds`
- Identifies the target OpenClaw agent

### `sessionKey`
- Required for deterministic routing
- If omitted, gateway may fall back to `hooks.defaultSessionKey`
- Recommended: always send explicit `sessionKey`

---

## 5. Optional fields

### `sessionId`
- Optional
- Use when caller knows the exact session instance and wants tighter targeting/correlation

### `name`
- Optional
- Human label for source/origin (for example `OpenCode`, `TAA Scheduler`)

### `wakeMode`
- Optional
- Supported minimal values:
  - `now` (recommended default)
  - `next-heartbeat`

### `deliver`
- Optional boolean
- Current meaning: request downstream delivery behavior if supported by the consumer side
- **Do not rely on this flag alone to guarantee workflow continuation**

---

## 6. Canonical usage rule

For all automation producers, prefer:

```json
{
  "message": "<JSON string payload>",
  "agentId": "<target-agent>",
  "sessionKey": "<target-session-key>",
  "wakeMode": "now",
  "deliver": false
}
```

Reason:
- explicit session routing
- deterministic wake
- no accidental fallback to default session
- cleaner audit/correlation

---

## 7. Message payload recommendation

The `message` string should itself be JSON when used for machine workflows.

Example:

```json
{
  "kind": "opencode.callback",
  "runId": "...",
  "taskId": "...",
  "eventType": "session.idle",
  "projectId": "...",
  "repoRoot": "...",
  "callbackTargetSessionKey": "...",
  "callbackTargetSessionId": "..."
}
```

This keeps `/hooks/agent` transport minimal while allowing richer workflow logic in the consumer lane.

---

## 8. Non-goals of `/hooks/agent`

`/hooks/agent` is only responsible for:
1. auth
2. agent allowlist check
3. session routing/wake dispatch

It is **not** the workflow engine.

Producers must not assume `/hooks/agent` itself will:
- resume work
- execute next task
- synthesize visible replies
- decide workflow transitions

Those behaviors must be handled by the target session/agent logic.

---

## 9. Producer guidance

### TAA backend
- Always send explicit `sessionKey`
- Keep wake contract text strongly structured and action-oriented
- Include correlation identifiers inside `message`

### `opencode-bridge`
- Always send explicit `callbackTargetSessionKey`
- Keep callback metadata machine-readable inside `message`
- Use run artifact continuation metadata outside the transport payload when needed

---

## 10. Minimum rollout rule

Any new producer integrating with `/hooks/agent` should satisfy:
- explicit `agentId`
- explicit `sessionKey`
- `message` is either human-readable action contract or JSON string payload
- `wakeMode` explicitly set

---

## 11. Summary

The minimal safe `/hooks/agent` payload is:
- `message`
- `agentId`
- `sessionKey`
- optional `sessionId`
- optional `name`
- `wakeMode`
- `deliver`

This contract standardizes the transport layer only. Higher-level continuation behavior must be implemented above it.