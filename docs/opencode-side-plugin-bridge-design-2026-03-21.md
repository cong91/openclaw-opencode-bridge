# OpenCode-side plugin bridge design (2026-03-21)

## Mục tiêu
Dựng một plugin chạy **bên trong OpenCode runtime** để bắt event session/message và callback về OpenClaw khi run terminal, thay vì phụ thuộc hoàn toàn vào OpenClaw-side watcher + session HTTP API.

## Vì sao cần plugin phía OpenCode
Qua forensic runtime thật:
- `POST /session/:id/message` và `POST /session/:id/prompt_async` nhận request nhưng không materialize message/progress như kỳ vọng.
- `GET /event` và `GET /global/event` chỉ thấy `server.connected` / `server.heartbeat` trong flow hiện tại.
- Bridge phía OpenClaw đã fix được binding, reuse guard và callback orchestration, nhưng upstream execution surface chưa đủ tin cậy để đóng callback closeout.

Plugin phía OpenCode cho phép nghe event ngay trong runtime nội bộ:
- `session.status`
- `session.idle`
- `session.error`
- `message.updated`
- `permission.asked`

Từ đó callback outbound về OpenClaw bằng HTTP POST khi thấy terminal state.

## Phạm vi tối thiểu (v0-test)
Chỉ làm plugin dùng để **test/validate hypothesis**, chưa productize full.

### In scope
1. Nhận config callback:
   - `OPENCLAW_HOOK_BASE_URL`
   - `OPENCLAW_HOOK_TOKEN`
   - optional `OPENCLAW_BRIDGE_SESSION_KEY_PREFIX=hook:opencode:`
2. Subscribe event `session.status`, `session.idle`, `session.error`, `message.updated`, `permission.asked`.
3. Tự giữ in-memory dedupe map theo `sessionId`/`runId` để callback once.
4. Từ event/runtime metadata, extract envelope tối thiểu:
   - `run_id`
   - `task_id`
   - `requested_agent_id`
   - `resolved_agent_id`
   - `callback_target_session_key`
   - `callback_target_session_id`
5. Chọn trigger canonical cho callback once: ưu tiên `session.idle`; `session.status` chỉ dùng cho forensic/observability, không callback trực tiếp trong v0-test.
6. Append audit nhẹ ra file local để tiện forensic.

### Out of scope
- Không thay thế toàn bộ OpenClaw-side bridge.
- Không làm dynamic retry queue phức tạp.
- Không làm persistence database riêng.
- Không implement multi-tenant routing phức tạp.

## Kiến trúc đề xuất

### A. Plugin file
Đặt local để test nhanh:
- project-level: `.opencode/plugins/openclaw-bridge-callback.ts`

Hoặc global nếu muốn reuse:
- `~/.config/opencode/plugins/openclaw-bridge-callback.ts`

### B. Cấu hình
Dùng env là nhanh nhất cho phase test:
- `OPENCLAW_HOOK_BASE_URL`
- `OPENCLAW_HOOK_TOKEN`
- `OPENCLAW_BRIDGE_AUDIT_DIR` (optional)
- `OPENCLAW_BRIDGE_DELIVER=false` (default)

### C. Event handling
Plugin export một hook object có:
- `event: async ({ event }) => { ... }`

Pseudo-logic:
1. Ignore event không liên quan.
2. Normalize event về một internal shape.
3. Tìm session metadata / message metadata.
4. Nếu session không có dấu vết envelope `hook:opencode:` thì bỏ qua.
5. Nếu terminal event:
   - build payload `/hooks/agent`
   - check dedupe memory
   - POST callback
   - log audit

## Routing contract đề xuất
Để plugin phía OpenCode nhận diện đúng run do bridge tạo, cần nhét metadata dễ đọc vào title/prompt/session.

### Option tối thiểu, ít xâm lấn
Encode vào `session.title` khi create session:
- `taskId=<...> runId=<...> callbackSession=<...> requested=<...> resolved=<...>`

### Option tốt hơn
Nếu OpenCode session/message có metadata field usable thì gửi metadata structured.
Nếu chưa chắc, phase test dùng title tagging là đủ.

## Callback payload
POST về:
- `POST {OPENCLAW_HOOK_BASE_URL}/hooks/agent`
- `Authorization: Bearer {OPENCLAW_HOOK_TOKEN}`

Payload:
```json
{
  "message": "OpenCode session.idle run=<run> task=<task> summary=<...>",
  "name": "OpenCode",
  "agentId": "<requested_agent_id>",
  "sessionKey": "<callback_target_session_key>",
  "sessionId": "<callback_target_session_id>",
  "wakeMode": "now",
  "deliver": false
}
```

## Dedupe rule
In-memory map:
- key = `sessionId|runId|terminalEventType`
- value = timestamp/result

Rule:
- Nếu đã callback success cho key này thì bỏ qua event terminal sau.
- Nếu callback fail, vẫn log lại nhưng không spam retry vô hạn trong v0.

## Audit
File JSONL local, ví dụ:
- `.opencode/bridge-callback-audit.jsonl`

Mỗi record gồm:
- `event_type`
- `session_id`
- `run_id`
- `task_id`
- `callback_target_session_key`
- `status`
- `ok`
- `created_at`

## Acceptance criteria cho phase test
1. Plugin load thành công trong OpenCode.
2. Khi tạo session/run có tag của bridge, plugin thấy event liên quan.
3. Khi session terminal, plugin gọi `/hooks/agent` đúng 1 lần.
4. Có audit file local.
5. Nếu event không thuộc bridge session, plugin bỏ qua.

## Bước triển khai đề xuất
1. Tạo plugin local test file.
2. Inject env callback vào OpenCode runtime.
3. Sửa minimal title tagging từ OpenClaw bridge nếu cần.
4. Chạy một smoke run đơn giản.
5. Xem plugin log + audit + callback hit.

## Rủi ro
- Event object thực tế có shape khác docs kỳ vọng -> cần log raw event trong v0.
- Session metadata/title không đủ để recover routing envelope -> phải bổ sung tagging rõ hơn từ bridge.
- OpenCode plugin lifecycle/load order có thể cần restart runtime thủ công.

## Kết luận
Đây là hướng canonical hơn cho bridge callback vì dùng event hook ngay trong OpenCode runtime. Nó tránh phụ thuộc vào giả định rằng session HTTP API của serve luôn materialize progress/message đầy đủ cho OpenClaw-side watcher.erialize progress/message đầy đủ cho OpenClaw-side watcher.