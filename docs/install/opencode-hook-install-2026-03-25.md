# Cài đặt OpenCode continuation hook cho `opencode-bridge`

Tài liệu này mô tả cách cài flow mới:

**OpenCode-side plugin**
→ **`/hooks/opencode-callback`**
→ **hook continuation session**
→ **verify / analyze / relaunch / done**

## Artifact trong repo

- Hook transform canonical: `hooks/opencode-callback.js`
- Hook config template: `hooks/opencode-hooks-config.template.json5`
- OpenCode-side plugin source: `opencode-plugin/openclaw-bridge-callback.ts`

## 1) Build plugin

```bash
cd /path/to/opencode-bridge
npm install
npm run build
```

## 2) Cài OpenClaw plugin + materialize OpenCode plugin

### Project mode
```bash
npm run install:bridge:project
```

### Global mode
```bash
npm run install:bridge:global
```

## 3) Materialize hook transform vào OpenClaw config root

Copy file transform canonical vào đúng thư mục OpenClaw hooks:

```bash
mkdir -p ~/.openclaw/hooks/transforms
cp hooks/opencode-callback.js ~/.openclaw/hooks/transforms/opencode-callback.js
```

## 4) Cập nhật `~/.openclaw/openclaw.json`

Merge block `hooks` từ file template:

- `hooks/opencode-hooks-config.template.json5`

Các field quan trọng:
- `hooks.token`
- `hooks.defaultSessionKey = "hook:ingress"`
- `hooks.allowedSessionKeyPrefixes = ["hook:", "opencode:"]`
- mapping `path = "opencode-callback"`
- `transform.module = "opencode-callback.js"`

## 5) Đồng bộ bridge callback config cho OpenCode-side plugin

Bridge config được đọc từ:
- `~/.openclaw/opencode-bridge/config.json`

Cần có tối thiểu:

```json
{
  "hookBaseUrl": "http://127.0.0.1:18789",
  "hookToken": "your-hook-token"
}
```

Sau đó sync plugin config:

```bash
node scripts/sync-opencode-plugin-config.mjs --mode project
# hoặc
node scripts/sync-opencode-plugin-config.mjs --mode global
```

## 6) Restart gateway / OpenClaw

Sau khi đổi hook config / transform, restart gateway để nạp config mới.

## 7) Smoke test

```bash
curl -X POST http://127.0.0.1:18789/hooks/opencode-callback \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "source":"opencode.callback",
    "runId":"probe-run",
    "taskId":"probe-task",
    "eventType":"task.completed",
    "requestedAgentId":"scrum",
    "callbackTargetSessionKey":"agent:scrum:telegram:direct:5165741309",
    "callbackTargetSessionId":"probe-session-1",
    "next":{
      "action":"launch_run",
      "taskId":"verify-probe-1",
      "objective":"Verify callback probe",
      "prompt":"Run verification for callback probe"
    },
    "intent":{
      "kind":"launch_run",
      "taskId":"verify-probe-1",
      "objective":"Verify callback probe",
      "prompt":"Run verification for callback probe",
      "reason":"task.completed"
    }
  }'
```

Expected:
- HTTP 200
- body có `runId`
- OpenClaw tạo isolated continuation session `opencode:<agent>:callback:<id>`

## Ghi chú

- `/.plugin/opencode-bridge/callback` vẫn có thể giữ ở dạng compat/deprecated trong giai đoạn migration.
- Active flow chính là: **OpenCode-side plugin → hook continuation**.
- `.callback-pending` không còn là primitive đang dùng trong flow mới.
