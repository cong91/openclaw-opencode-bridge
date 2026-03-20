# RSS-35 Step 2 — Operator Surface Contract (Draft v0)

Ngày: 2026-03-20
Phạm vi: chỉ chốt contract read-only observability cho 3 surface:
- `opencode_run_status`
- `opencode_run_events`
- `opencode_session_tail`

## 1) API mapping thực tế từ OpenCode serve

Đã verify trực tiếp trên OpenCode serve (`opencode 1.2.27`):

- `GET /global/health` → JSON health (`{"healthy":true,"version":"..."}`)
- `GET /session` → JSON list session
- `GET /session/status` → JSON object (global/session status snapshot)
- `GET /event` → SSE stream (session-scoped), data line mẫu: `data: {"type":"server.connected",...}`
- `GET /global/event` → SSE stream (global-scoped), data line mẫu: `data: {"payload":{"type":"server.connected",...}}`
- `GET /session/{id}/message` → JSON message list
- `GET /session/{id}/diff` → JSON diff list
- `GET /session/{id}` → JSON session summary
- `GET /log` → HTML UI (không dùng cho machine observability)

Ghi chú:
- `/event` và `/global/event` là stream; request thường timeout nếu không có event mới.
- Shape giữa `/event` và `/global/event` khác nhau (`payload` wrapper ở global).

---

## 2) Tool contract chi tiết

## 2.1 `opencode_run_status`

### Intent
Snapshot read-only trạng thái run bằng cách hợp nhất:
- local artifact (`~/.openclaw/opencode-bridge/runs/<runId>.json`) nếu có
- API snapshot từ OpenCode serve (`/global/health`, `/session`, `/session/status`)

### Input
```json
{
  "runId": "string?",
  "sessionId": "string?",
  "opencodeServerUrl": "string?"
}
```

### Output shape
```json
{
  "ok": true,
  "source": {
    "runStatusArtifact": true,
    "opencodeApi": true
  },
  "runId": "string?",
  "taskId": "string?",
  "projectId": "string?",
  "sessionId": "string?",
  "state": "queued|server_ready|session_created|prompt_sent|running|awaiting_permission|stalled|failed|completed",
  "lastEvent": "task.started|task.progress|permission.requested|task.stalled|task.failed|task.completed|null",
  "lastSummary": "string?",
  "updatedAt": "ISO-8601",
  "timestamps": {
    "artifactUpdatedAt": "ISO-8601?",
    "apiFetchedAt": "ISO-8601"
  },
  "health": {
    "ok": true,
    "version": "string?"
  },
  "apiSnapshot": {
    "health": {},
    "sessionList": [],
    "sessionStatus": {},
    "fetchedAt": "ISO-8601"
  },
  "note": "string?"
}
```

### Resolution rule
- `opencodeServerUrl`: params > config > default `http://127.0.0.1:4096`
- `sessionId`: params > run artifact envelope.session_id (nếu có) > newest session từ `/session`
- `state`: ưu tiên artifact state, fallback `running` nếu có session, ngược lại `queued`

---

## 2.2 `opencode_run_events`

### Intent
Read-only event probe từ SSE endpoints và normalize sơ bộ event kind để operator quan sát nhanh.

### Input
```json
{
  "scope": "session|global?",
  "limit": "number?",
  "timeoutMs": "number?",
  "runId": "string?",
  "sessionId": "string?",
  "opencodeServerUrl": "string?"
}
```

### Output shape
```json
{
  "ok": true,
  "runId": "string?",
  "sessionId": "string?",
  "scope": "session|global",
  "eventPath": "/event|/global/event",
  "eventCount": 0,
  "events": [
    {
      "index": 0,
      "scope": "session|global",
      "rawLine": "data: ...",
      "data": {},
      "normalizedKind": "task.started|task.progress|permission.requested|task.stalled|task.failed|task.completed|null",
      "summary": "string?",
      "timestamp": "ISO-8601"
    }
  ],
  "truncated": false,
  "timeoutMs": 3000
}
```

### Mapping rule
- `scope=session` → `/event`
- `scope=global` → `/global/event`
- Nếu SSE payload có wrapper `payload`, unwrap trước khi normalize.
- Normalization reuse logic `normalizeOpenCodeEvent` hiện có.

---

## 2.3 `opencode_session_tail`

### Intent
Read-only tail của session để operator inspect message + diff gần nhất.

### Input
```json
{
  "sessionId": "string?",
  "runId": "string?",
  "limit": "number?",
  "includeDiff": "boolean?",
  "opencodeServerUrl": "string?"
}
```

### Output shape
```json
{
  "ok": true,
  "sessionId": "string",
  "runId": "string?",
  "limit": 20,
  "totalMessages": 0,
  "messages": [
    {
      "index": 0,
      "role": "user|assistant|...",
      "text": "string?",
      "createdAt": "number|string?",
      "id": "string?",
      "agent": "string?",
      "model": "string?",
      "raw": {}
    }
  ],
  "diff": [],
  "latestSummary": {},
  "fetchedAt": "ISO-8601"
}
```

### Resolution rule
- `sessionId`: params > run artifact > newest session từ `/session`
- Nếu không resolve được sessionId → return error rõ ràng
- `messages`: lấy tail `limit` từ `/session/{id}/message`
- `diff` (optional): `/session/{id}/diff` khi `includeDiff !== false`
- `latestSummary`: `/session/{id}`

---

## 3) Triển khai slice đầu tiên (đã làm)

Đã implement trực tiếp trong plugin source (small/reviewable):
- thêm type/schema nội bộ cho 3 response surfaces
- thêm helper read-only API adapter:
  - resolve server URL
  - safe JSON fetch
  - session id resolution fallback
  - SSE line parser + payload unwrap + normalized projection
- đăng ký 3 tools mới tương ứng

Không đụng local install path hay packaging flow trong slice này.

---

## 4) Next slice đề xuất (không mở scope mới)

1. **Stabilize run/session correlation**
   - lưu `session_id` vào run artifact khi có callback/listener path
   - tránh fallback “newest session” gây mơ hồ

2. **Typed event normalization v1**
   - map theo `type` field rõ ràng (không chỉ keyword)
   - tách `rawType`, `normalizedKind`, `confidence`

3. **Contract hardening + docs sync**
   - cập nhật README tool list cho đúng runtime
   - thêm examples input/output ngắn cho từng tool

4. **Optional lightweight tests**
   - fixture-based unit test cho parse/normalize SSE
   - smoke test non-network cho schema guard
