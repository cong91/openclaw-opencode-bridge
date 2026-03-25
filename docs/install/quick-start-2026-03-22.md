# opencode-bridge quick start

## Mục tiêu
Cho người dùng một đường cài nhanh, rõ, ít nhầm lẫn giữa:
- local debug mode
- project install mode
- global install mode

## 1) Local debug mode
Dùng khi đang phát triển plugin cục bộ.

### OpenClaw side
Không cần `openclaw plugins install -l`.

Dùng `plugins.load.paths` trong `~/.openclaw/openclaw.json` để trỏ trực tiếp tới repo local:
- `/Users/<you>/Work/projects/opencode-bridge`

Sau khi sửa code:
```bash
cd /path/to/opencode-bridge
npm run build
gateway restart   # hoặc restart gateway/runtime theo flow hiện tại
```

### OpenCode side
Project-local dev mode:
```bash
cd /path/to/opencode-bridge
npm run materialize:opencode-plugin:project
```

## 2) Project install mode
Dùng khi muốn cài bridge cho một project cụ thể.

```bash
cd /path/to/opencode-bridge
npm run build
npm run install:bridge:project
```

Nếu muốn nhắm vào một project khác:
```bash
node ./scripts/install-bridge.mjs --mode project --target /absolute/path/to/project
```

Kết quả mong đợi:
- OpenClaw side được cài từ repo hiện tại
- OpenCode side được materialize vào `.opencode/plugins/openclaw-bridge-callback.js`
- `.opencode/opencode.json` được patch để load plugin

## 3) Global install mode
Dùng khi muốn cài OpenCode-side plugin ở global config.

```bash
cd /path/to/opencode-bridge
npm run build
npm run install:bridge:global
```

Kết quả mong đợi:
- built artifact được copy vào `~/.config/opencode/plugins/openclaw-bridge-callback.js`
- `~/.config/opencode/opencode.json` được auto patch nếu file tồn tại

## 4) Callback env cần có cho OpenCode-side plugin
Tối thiểu:
- `OPENCLAW_HOOK_BASE_URL`
- `OPENCLAW_HOOK_TOKEN`

Optional:
- `OPENCLAW_BRIDGE_AUDIT_DIR`

## 5) Kiểm tra nhanh sau cài
### OpenClaw side
```bash
openclaw doctor --non-interactive
```

### OpenCode side
Kiểm tra config/plugin file:
```bash
cat ~/.config/opencode/opencode.json
ls ~/.config/opencode/plugins/
```

### Repo verify
```bash
npm test -- --runInBand
```

### Callback lane verify
Nếu callback path đã được wiring:
- kiểm tra OpenCode-side audit local (`.opencode/bridge-callback-audit.jsonl`)
- kiểm tra OpenClaw-side callback audit (`~/.openclaw/opencode-bridge/audit/callbacks.jsonl`)
- verify callback target session/lane đúng như title tagging contract

## Ghi chú
- Local debug mode và productized install mode là 2 flow khác nhau.
- Không dùng `openclaw plugins install -l` như flow debug chính cho repo này khi local path policy còn gây nhiễu.
- Shared-serve contract hiện tại là: one active serve, many projects via `run --attach --dir <repoRoot>`.
- Project-aware observability is mandatory: use run artifact + persisted sessionId/opencodeSessionId + callback audit before trusting recency.
- `sessions.json` là supporting index, không phải execution source of truth.
- Nếu artifact còn `running`, hãy kiểm tra thêm `realState`, `warnings`, `callbackSummary`, và `attachRunSummary`.
- Sau terminal callback accepted, attach-run PID phải được cleanup; active serve được giữ lại.
