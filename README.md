# @mrc2204/opencode-bridge

> English README: [README.en.md](./README.en.md)

`opencode-bridge` là cầu nối giữa OpenClaw và OpenCode theo hướng hybrid execution, callback orchestration và runtime control an toàn cho nhiều project.

## Package này làm gì

Package này nối 2 phía runtime:

- **OpenClaw side**: routing theo project, run state, serve management, observability, callback policy
- **OpenCode side**: plugin callback bắt event terminal bên trong OpenCode runtime

Mục tiêu thực dụng:

- execution theo project rõ ràng
- callback quay về OpenClaw qua `/hooks/agent`
- artifact OpenCode-side cài được theo project hoặc global
- multi-project-safe boundary

## Cài đặt

### 1) OpenClaw side

```bash
openclaw plugins install @mrc2204/openclaw-opencode-bridge
```

Hoặc nếu cài local từ source checkout:

```bash
openclaw plugins install -l /absolute/path/to/opencode-bridge
```

**Cấm dùng entry file path** (sẽ tạo nhầm plugin id `index`):

```bash
# ❌ sai
openclaw plugins install -l /absolute/path/to/opencode-bridge/dist/src/index.js
```

Lý do: OpenClaw local install suy luận install key theo basename path; `index.js` sẽ thành plugin key `index`.

### 2) OpenCode side — cài theo project

```bash
npm run materialize:opencode-plugin:project
```

Project mode sẽ materialize plugin theo namespace clean:

- `.opencode/plugins/openclaw-bridge/openclaw-bridge-callback.js`
- `.opencode/plugins/openclaw-bridge/config.json`

và auto patch plugin entry trong `.opencode/opencode.json` thành:

```json
{ "plugin": ["./plugins/openclaw-bridge/openclaw-bridge-callback.js"] }
```

### 3) OpenCode side — cài global

```bash
npm run materialize:opencode-plugin:global
```

Global mode sẽ materialize plugin theo namespace clean:

- `~/.config/opencode/plugins/openclaw-bridge/openclaw-bridge-callback.js`
- `~/.config/opencode/plugins/openclaw-bridge/config.json`

và auto patch `~/.config/opencode/opencode.json` khi file này tồn tại thành plugin entry dạng:

```json
{ "plugin": ["./plugins/openclaw-bridge/openclaw-bridge-callback.js"] }
```

### 4) Một lệnh cài

Project mode:

```bash
npm run install:bridge:project
```

Global mode:

```bash
npm run install:bridge:global
```

Guard đã được thêm trong `scripts/install-bridge.mjs`: nếu `--target` trỏ vào entry file kiểu `dist/src/index.js` (hoặc tương đương), script sẽ reject với lỗi rõ ràng và hướng dẫn dùng repo/plugin root.

## Hook continuation artifact (canonical trong repo)

Repo hiện đã chứa sẵn artifact hook continuation để ship cùng package:

- `hooks/opencode-callback.js`
- `hooks/opencode-hooks-config.template.json5`
- hướng dẫn cài: `docs/install/opencode-hook-install-2026-03-25.md`

## Environment callback tối thiểu

OpenCode-side plugin / hook continuation cần:

- `OPENCLAW_HOOK_BASE_URL`
- `OPENCLAW_HOOK_TOKEN`

Optional:

- `OPENCLAW_BRIDGE_AUDIT_DIR`
- `OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH`

## Mô hình runtime

### Hybrid execution strategy

`opencode-bridge` hỗ trợ 2 lane thực dụng:

- **CLI-direct**: execution nhẹ cho task đơn giản
- **serve/plugin mode**: đường canonical cho callback, observability và event-driven lifecycle

### Shared serve + session registries

Runtime semantics hiện tại:

- `serves.json` là serve lifecycle registry canonical (spawn/reuse/adopt/health/shutdown/cleanup)
- `sessions.json` là session mapping registry canonical theo `directory`
- shared OpenCode serve default-port có thể phục vụ nhiều project/sessions
- process discovery/cleanup hỗ trợ cả form legacy `--port` và form default-port không có `--port`
- session tag vẫn phải giữ đủ callback identity theo run/session

## Build và verify

```bash
npm install
npm run build
npm test -- --runInBand
```

## Cấu trúc artifact

```text
openclaw-opencode-bridge/
├── src/                 # OpenClaw-side runtime
├── opencode-plugin/     # canonical OpenCode-side plugin source
├── scripts/             # materialize/install helpers
├── dist/                # built artifacts
├── docs/                # install / architecture / contracts
└── skills/              # bridge-related skills/docs
```

## Tài liệu liên quan

- `docs/install/quick-start-2026-03-22.md`
- `docs/install/production-ish-install-2026-03-22.md`
- `docs/contracts/multi-project-contract-draft-2026-03-22.md`
- `docs/architecture/hybrid-execution-strategy-2026-03-22.md`

Ghi chú: local debug/dev notes được tách khỏi README public-facing. Xem:

- `docs/install/developer-local-debug-2026-03-22.md`

## Trạng thái

Hiện tại package đã ở mức functional + productized usable, với hardening/test/docs đã đi khá xa.
