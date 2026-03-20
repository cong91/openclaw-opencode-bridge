import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

type ProjectRegistryEntry = {
  projectId: string;
  repoRoot: string;
  serverUrl: string;
  idleTimeoutMs?: number;
};

type RoutingEnvelope = {
  task_id: string;
  run_id: string;
  agent_id: string;
  session_key: string;
  origin_session_key: string;
  project_id: string;
  repo_root: string;
  opencode_server_url: string;
  channel?: string;
  to?: string;
  deliver?: boolean;
  priority?: string;
};

type BridgeLifecycleState =
  | "queued"
  | "server_ready"
  | "session_created"
  | "prompt_sent"
  | "running"
  | "awaiting_permission"
  | "stalled"
  | "failed"
  | "completed";

type OpenCodeEventKind =
  | "task.started"
  | "task.progress"
  | "permission.requested"
  | "task.stalled"
  | "task.failed"
  | "task.completed";

type HooksAgentCallbackPayload = {
  message: string;
  name: string;
  agentId: string;
  sessionKey: string;
  wakeMode: "now" | "next-heartbeat";
  deliver: boolean;
  channel?: string;
  to?: string;
};

type Phase3RunStatus = {
  taskId: string;
  runId: string;
  state: BridgeLifecycleState;
  lastEvent?: OpenCodeEventKind | null;
  lastSummary?: string;
  updatedAt: string;
  envelope: RoutingEnvelope;
};

type CallbackAuditRecord = {
  taskId?: string;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  event?: string;
  callbackStatus: number;
  callbackOk: boolean;
  callbackBody?: string;
  createdAt: string;
};

type ServeRegistryEntry = {
  project_id: string;
  repo_root: string;
  opencode_server_url: string;
  pid?: number;
  status?: "running" | "stopped" | "unknown";
  last_event_at?: string;
  idle_timeout_ms?: number;
  updated_at: string;
};

type ServeRegistryFile = {
  entries: ServeRegistryEntry[];
};

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SOFT_STALL_MS = 60 * 1000;
const DEFAULT_HARD_STALL_MS = 180 * 1000;
const HOOK_PREFIX = "hook:opencode:";

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildSessionKey(agentId: string, taskId: string): string {
  return `${HOOK_PREFIX}${agentId}:${taskId}`;
}

function normalizeRegistry(raw: unknown): ProjectRegistryEntry[] {
  return asArray(raw)
    .map((item) => {
      const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const projectId = asString(obj.projectId);
      const repoRoot = asString(obj.repoRoot);
      const serverUrl = asString(obj.serverUrl);
      const idleTimeoutMs = Number(obj.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS);
      if (!projectId || !repoRoot || !serverUrl) return null;
      return {
        projectId,
        repoRoot,
        serverUrl,
        idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
      };
    })
    .filter(Boolean) as ProjectRegistryEntry[];
}

function findRegistryEntry(cfg: any, projectId?: string, repoRoot?: string): ProjectRegistryEntry | undefined {
  const registry = normalizeRegistry(cfg?.projectRegistry);
  if (projectId) {
    const byProject = registry.find((x) => x.projectId === projectId);
    if (byProject) return byProject;
  }
  if (repoRoot) {
    const byRoot = registry.find((x) => x.repoRoot === repoRoot);
    if (byRoot) return byRoot;
  }
  return undefined;
}

function buildEnvelope(input: {
  taskId: string;
  runId: string;
  agentId: string;
  originSessionKey: string;
  projectId: string;
  repoRoot: string;
  serverUrl: string;
  channel?: string;
  to?: string;
  deliver?: boolean;
  priority?: string;
}): RoutingEnvelope {
  return {
    task_id: input.taskId,
    run_id: input.runId,
    agent_id: input.agentId,
    session_key: buildSessionKey(input.agentId, input.taskId),
    origin_session_key: input.originSessionKey,
    project_id: input.projectId,
    repo_root: input.repoRoot,
    opencode_server_url: input.serverUrl,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
  };
}

function mapEventToState(event: OpenCodeEventKind): BridgeLifecycleState {
  switch (event) {
    case "task.started":
    case "task.progress":
      return "running";
    case "permission.requested":
      return "awaiting_permission";
    case "task.stalled":
      return "stalled";
    case "task.failed":
      return "failed";
    case "task.completed":
      return "completed";
    default:
      return "running";
  }
}

function buildHooksAgentCallback(input: {
  event: OpenCodeEventKind;
  envelope: RoutingEnvelope;
  summary?: string;
}): HooksAgentCallbackPayload {
  const state = mapEventToState(input.event);
  const message =
    input.summary ||
    `OpenCode event=${input.event} state=${state} task=${input.envelope.task_id} run=${input.envelope.run_id} project=${input.envelope.project_id}`;

  return {
    message,
    name: "OpenCode",
    agentId: input.envelope.agent_id,
    sessionKey: input.envelope.session_key,
    wakeMode: "now",
    deliver: false,
    ...(input.envelope.channel ? { channel: input.envelope.channel } : {}),
    ...(input.envelope.to ? { to: input.envelope.to } : {}),
  };
}

function normalizeOpenCodeEvent(raw: any): { kind: OpenCodeEventKind | null; summary?: string; raw: any } {
  const text = JSON.stringify(raw || {}).toLowerCase();
  if (text.includes("permission") || text.includes("question.asked")) {
    return { kind: "permission.requested", summary: "OpenCode đang chờ permission/user input", raw };
  }
  if (text.includes("error") || text.includes("failed")) {
    return { kind: "task.failed", summary: "OpenCode task failed", raw };
  }
  if (text.includes("complete") || text.includes("completed") || text.includes("done")) {
    return { kind: "task.completed", summary: "OpenCode task completed", raw };
  }
  if (text.includes("progress") || text.includes("delta") || text.includes("assistant")) {
    return { kind: "task.progress", summary: "OpenCode task made progress", raw };
  }
  if (text.includes("start") || text.includes("created") || text.includes("connected")) {
    return { kind: "task.started", summary: "OpenCode task/server started", raw };
  }
  return { kind: null, raw };
}

function evaluateLifecycle(input: {
  lastEventKind?: OpenCodeEventKind | null;
  lastEventAtMs?: number;
  nowMs?: number;
  softStallMs?: number;
  hardStallMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const softStallMs = input.softStallMs ?? DEFAULT_SOFT_STALL_MS;
  const hardStallMs = input.hardStallMs ?? DEFAULT_HARD_STALL_MS;
  if (input.lastEventKind) {
    const state = mapEventToState(input.lastEventKind);
    return {
      state,
      escalateToMain: state === "failed" || state === "completed",
      needsPermissionHandling: state === "awaiting_permission",
      stallSeverity: null,
    };
  }
  if (!input.lastEventAtMs) {
    return {
      state: "queued" as BridgeLifecycleState,
      escalateToMain: false,
      needsPermissionHandling: false,
      stallSeverity: null,
    };
  }
  const age = nowMs - input.lastEventAtMs;
  if (age >= hardStallMs) {
    return { state: "stalled" as BridgeLifecycleState, escalateToMain: true, needsPermissionHandling: false, stallSeverity: "hard" };
  }
  if (age >= softStallMs) {
    return { state: "stalled" as BridgeLifecycleState, escalateToMain: false, needsPermissionHandling: false, stallSeverity: "soft" };
  }
  return { state: "running" as BridgeLifecycleState, escalateToMain: false, needsPermissionHandling: false, stallSeverity: null };
}

function getRunStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, "opencode-bridge-runs");
}

function writeRunStatus(status: Phase3RunStatus) {
  const dir = getRunStateDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${status.runId}.json`);
  writeFileSync(path, JSON.stringify(status, null, 2), "utf8");
  return path;
}

function readRunStatus(runId: string): Phase3RunStatus | null {
  const path = join(getRunStateDir(), `${runId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Phase3RunStatus;
}

function getAuditDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, "opencode-bridge-audit");
}

function appendAudit(record: CallbackAuditRecord) {
  const dir = getAuditDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "callbacks.jsonl");
  writeFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return path;
}

function getServeRegistryPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, "opencode-bridge-registry.json");
}

function readServeRegistry(): ServeRegistryFile {
  const path = getServeRegistryPath();
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ServeRegistryFile;
}

function normalizeServeRegistry(registry: ServeRegistryFile): ServeRegistryFile {
  const entries = asArray(registry.entries)
    .map((entry) => {
      const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const project_id = asString(e.project_id);
      const repo_root = asString(e.repo_root);
      const opencode_server_url = asString(e.opencode_server_url);
      if (!project_id || !repo_root || !opencode_server_url) return null;
      return {
        project_id,
        repo_root,
        opencode_server_url,
        ...(asNumber(e.pid) !== undefined ? { pid: asNumber(e.pid) } : {}),
        ...(asString(e.status) ? { status: asString(e.status) as ServeRegistryEntry['status'] } : {}),
        ...(asString(e.last_event_at) ? { last_event_at: asString(e.last_event_at) } : {}),
        idle_timeout_ms: asNumber(e.idle_timeout_ms) ?? DEFAULT_IDLE_TIMEOUT_MS,
        updated_at: asString(e.updated_at) || new Date().toISOString(),
      } as ServeRegistryEntry;
    })
    .filter(Boolean) as ServeRegistryEntry[];
  return { entries };
}

function writeServeRegistryFile(data: ServeRegistryFile) {
  const path = getServeRegistryPath();
  writeFileSync(path, JSON.stringify(normalizeServeRegistry(data), null, 2), "utf8");
  return path;
}

function upsertServeRegistry(entry: ServeRegistryEntry) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const idx = registry.entries.findIndex((x) => x.project_id === entry.project_id || x.repo_root === entry.repo_root);
  if (idx >= 0) registry.entries[idx] = entry;
  else registry.entries.push(entry);
  const path = writeServeRegistryFile(registry);
  return { path, registry };
}

function evaluateServeIdle(entry: ServeRegistryEntry, nowMs?: number) {
  const now = nowMs ?? Date.now();
  const last = entry.last_event_at ? Date.parse(entry.last_event_at) : NaN;
  const idleTimeoutMs = entry.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(last)) {
    return { shouldShutdown: false, idleMs: null, reason: 'missing_last_event_at' };
  }
  const idleMs = now - last;
  return {
    shouldShutdown: idleMs >= idleTimeoutMs,
    idleMs,
    idleTimeoutMs,
    reason: idleMs >= idleTimeoutMs ? 'idle_timeout_exceeded' : 'within_idle_window',
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(serverUrl: string, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${serverUrl}/global/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function spawnServeForProject(input: {
  project_id: string;
  repo_root: string;
  idle_timeout_ms?: number;
}) {
  const existing = normalizeServeRegistry(readServeRegistry()).entries.find((x) => x.project_id === input.project_id || x.repo_root === input.repo_root);
  if (existing && existing.status === 'running') {
    const healthy = await waitForHealth(existing.opencode_server_url, 2000);
    if (healthy) {
      return { reused: true, entry: existing, registryPath: getServeRegistryPath() };
    }
  }
  const port = await allocatePort();
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const serverUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(serverUrl, 10000);
  const entry: ServeRegistryEntry = {
    project_id: input.project_id,
    repo_root: input.repo_root,
    opencode_server_url: serverUrl,
    pid: child.pid,
    status: healthy ? 'running' : 'unknown',
    last_event_at: new Date().toISOString(),
    idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
    updated_at: new Date().toISOString(),
  };
  const result = upsertServeRegistry(entry);
  return { reused: false, entry, healthy, registryPath: result.path };
}

function markServeStopped(projectId: string) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const entry = registry.entries.find((x) => x.project_id === projectId);
  if (!entry) return { ok: false, error: 'Project entry not found' };
  entry.status = 'stopped';
  entry.updated_at = new Date().toISOString();
  const path = writeServeRegistryFile(registry);
  return { ok: true, path, entry, registry };
}

function shutdownServe(entry: ServeRegistryEntry) {
  if (entry.pid) {
    try { process.kill(entry.pid, 'SIGTERM'); } catch {}
  }
  return markServeStopped(entry.project_id);
}

async function fetchSseEvents(serverUrl: string, options?: { maxEvents?: number; timeoutMs?: number }) {
  const maxEvents = options?.maxEvents ?? 1;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/global/event`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const lines: string[] = [];
    while (lines.length < maxEvents) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lines.push(trimmed);
        if (lines.length >= maxEvents) break;
      }
    }
    try { controller.abort(); } catch {}
    try { await reader.cancel(); } catch {}
    return lines;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return [];
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeHooksAgentCallback(hookBaseUrl: string, hookToken: string, callback: HooksAgentCallbackPayload) {
  const response = await fetch(`${hookBaseUrl.replace(/\/$/, "")}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hookToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(callback),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: text,
  };
}

function buildHookPolicyChecklist(agentId: string, sessionKey: string) {
  return {
    callbackPrimary: "/hooks/agent",
    requirements: {
      hooksEnabled: true,
      allowRequestSessionKey: true,
      allowedAgentIdsMustInclude: agentId,
      allowedSessionKeyPrefixesMustInclude: HOOK_PREFIX,
      deliverDefault: false,
    },
    sessionKey,
    suggestedConfig: {
      hooks: {
        enabled: true,
        allowRequestSessionKey: true,
        allowedAgentIds: [agentId],
        allowedSessionKeyPrefixes: [HOOK_PREFIX],
      },
    },
  };
}

const plugin = {
  id: "opencode-bridge",
  name: "OpenCode Bridge",
  version: "0.1.0",
  register(api: any) {
    const cfg = (api as any)?.pluginConfig || {};
    console.log("[opencode-bridge] scaffold loaded");
    console.log(`[opencode-bridge] opencodeServerUrl=${cfg.opencodeServerUrl || "(unset)"}`);
    console.log("[opencode-bridge] registering opencode_* tool set");

    api.registerTool({
      name: "opencode_status",
      label: "OpenCode Status",
      description: "Hiển thị contract hiện tại của OpenCode bridge: sessionKey convention, routing envelope schema, registry, lifecycle state skeleton và assumption 1 project = 1 serve.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const registry = normalizeRegistry(cfg?.projectRegistry);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, pluginId: "opencode-bridge", version: "0.1.0", assumption: "1 project = 1 opencode serve instance", sessionKeyConvention: "hook:opencode:<agentId>:<taskId>", lifecycleStates: ["queued", "server_ready", "session_created", "prompt_sent", "running", "awaiting_permission", "stalled", "failed", "completed"], requiredEnvelopeFields: ["task_id", "run_id", "agent_id", "session_key", "origin_session_key", "project_id", "repo_root", "opencode_server_url"], callbackPrimary: "/hooks/agent", callbackNotPrimary: ["/hooks/wake", "cron", "group:sessions"], config: { opencodeServerUrl: cfg?.opencodeServerUrl || null, hookBaseUrl: cfg?.hookBaseUrl || null, hookTokenPresent: Boolean(cfg?.hookToken), projectRegistry: registry }, note: "Runtime-ops scaffold in progress. Probe, callback execution, run artifacts, registry persistence, and lifecycle helpers are available for PoC use." }, null, 2) }]
        };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_resolve_project",
      label: "OpenCode Resolve Project",
      description: "Resolve project registry entry theo projectId hoặc repoRoot, áp dụng assumption 1 project = 1 serve instance.",
      parameters: { type: "object", properties: { projectId: { type: "string" }, repoRoot: { type: "string" } } },
      async execute(_id: string, params: any) {
        const entry = findRegistryEntry(cfg, params?.projectId, params?.repoRoot);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, match: entry || null }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_build_envelope",
      label: "OpenCode Build Envelope",
      description: "Dựng routing envelope chuẩn cho task delegate sang OpenCode với sessionKey convention hook:opencode:<agentId>:<taskId>.",
      parameters: { type: "object", properties: { taskId: { type: "string" }, runId: { type: "string" }, agentId: { type: "string" }, originSessionKey: { type: "string" }, projectId: { type: "string" }, repoRoot: { type: "string" }, channel: { type: "string" }, to: { type: "string" }, deliver: { type: "boolean" }, priority: { type: "string" } }, required: ["taskId", "runId", "agentId", "originSessionKey", "projectId", "repoRoot"] },
      async execute(_id: string, params: any) {
        const entry = findRegistryEntry(cfg, params?.projectId, params?.repoRoot);
        const serverUrl = entry?.serverUrl || cfg?.opencodeServerUrl;
        if (!serverUrl) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing opencode server mapping. Configure opencodeServerUrl or matching projectRegistry entry first." }, null, 2) }] };
        }
        const envelope = buildEnvelope({ taskId: params.taskId, runId: params.runId, agentId: params.agentId, originSessionKey: params.originSessionKey, projectId: params.projectId, repoRoot: params.repoRoot, serverUrl, channel: params.channel, to: params.to, deliver: params.deliver, priority: params.priority });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, envelope, registryMatch: entry || null }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_build_callback",
      label: "OpenCode Build Callback",
      description: "Map OpenCode event + routing envelope sang callback payload chuẩn cho OpenClaw `/hooks/agent`.",
      parameters: { type: "object", properties: { event: { type: "string", enum: ["task.started", "task.progress", "permission.requested", "task.stalled", "task.failed", "task.completed"] }, envelope: { type: "object" }, summary: { type: "string" } }, required: ["event", "envelope"] },
      async execute(_id: string, params: any) {
        const callback = buildHooksAgentCallback({ event: params.event, envelope: params.envelope as RoutingEnvelope, summary: params.summary });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, state: mapEventToState(params.event), callback }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_probe_sse",
      label: "OpenCode Probe SSE",
      description: "PoC nhỏ: thử đọc event đầu tiên từ SSE stream của OpenCode serve để chuẩn bị cho listener thật.",
      parameters: { type: "object", properties: { serverUrl: { type: "string" } } },
      async execute(_id: string, params: any) {
        const serverUrl = params?.serverUrl || cfg?.opencodeServerUrl;
        if (!serverUrl) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing serverUrl" }, null, 2) }] };
        }
        try {
          const preview = await fetchSseEvents(serverUrl, { maxEvents: 1, timeoutMs: 3000 });
          const normalized = preview.map((line) => normalizeOpenCodeEvent(line));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, serverUrl, preview, normalized }, null, 2) }] };
        } catch (error: any) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }] };
        }
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_execute_callback",
      label: "OpenCode Execute Callback",
      description: "PoC phase 2: thực thi callback thật về OpenClaw `/hooks/agent` từ callback payload đã build.",
      parameters: { type: "object", properties: { callback: { type: "object" }, hookBaseUrl: { type: "string" }, hookToken: { type: "string" } }, required: ["callback"] },
      async execute(_id: string, params: any) {
        const hookBaseUrl = params?.hookBaseUrl || cfg?.hookBaseUrl;
        const hookToken = params?.hookToken || cfg?.hookToken;
        if (!hookBaseUrl || !hookToken) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing hookBaseUrl or hookToken" }, null, 2) }] };
        }
        const result = await executeHooksAgentCallback(hookBaseUrl, hookToken, params.callback as HooksAgentCallbackPayload);
        const auditPath = appendAudit({ callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.ok, status: result.status, body: result.body, auditPath }, null, 2) }], ...(result.ok ? {} : { isError: true }) };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_run_status",
      label: "OpenCode Run Status",
      description: "Đọc status artifact của một run phase-3 trong opencode-bridge.",
      parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
      async execute(_id: string, params: any) {
        const status = readRunStatus(params.runId);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_callback_from_event",
      label: "OpenCode Callback From Event",
      description: "PoC phase 3: nhận một raw event, normalize -> state -> callback payload -> thực thi callback thật -> ghi status artifact.",
      parameters: { type: "object", properties: { event: { type: "object" }, envelope: { type: "object" }, hookBaseUrl: { type: "string" }, hookToken: { type: "string" }, summary: { type: "string" } }, required: ["event", "envelope"] },
      async execute(_id: string, params: any) {
        const hookBaseUrl = params?.hookBaseUrl || cfg?.hookBaseUrl;
        const hookToken = params?.hookToken || cfg?.hookToken;
        if (!hookBaseUrl || !hookToken) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing hookBaseUrl or hookToken" }, null, 2) }] };
        }
        const normalized = normalizeOpenCodeEvent(params.event);
        if (!normalized.kind) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Could not normalize event", raw: params.event }, null, 2) }] };
        }
        const envelope = params.envelope as RoutingEnvelope;
        const callback = buildHooksAgentCallback({ event: normalized.kind, envelope, summary: params.summary || normalized.summary });
        const state = mapEventToState(normalized.kind);
        const result = await executeHooksAgentCallback(hookBaseUrl, hookToken, callback);
        const statusObj: Phase3RunStatus = { taskId: envelope.task_id, runId: envelope.run_id, state, lastEvent: normalized.kind, lastSummary: params.summary || normalized.summary, updatedAt: new Date().toISOString(), envelope };
        const statusPath = writeRunStatus(statusObj);
        const auditPath = appendAudit({ taskId: envelope.task_id, runId: envelope.run_id, agentId: envelope.agent_id, sessionKey: envelope.session_key, event: normalized.kind, callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.ok, normalized, state, callback, callbackResult: result, statusPath, auditPath }, null, 2) }], ...(result.ok ? {} : { isError: true }) };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_listen_once",
      label: "OpenCode Listen Once",
      description: "Phase 3 mini listener runner: đọc một vài event thật từ OpenCode SSE, normalize, callback về `/hooks/agent`, rồi ghi status artifact.",
      parameters: { type: "object", properties: { envelope: { type: "object" }, hookBaseUrl: { type: "string" }, hookToken: { type: "string" }, maxEvents: { type: "number" }, timeoutMs: { type: "number" } }, required: ["envelope"] },
      async execute(_id: string, params: any) {
        const hookBaseUrl = params?.hookBaseUrl || cfg?.hookBaseUrl;
        const hookToken = params?.hookToken || cfg?.hookToken;
        if (!hookBaseUrl || !hookToken) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing hookBaseUrl or hookToken" }, null, 2) }] };
        }
        const envelope = params.envelope as RoutingEnvelope;
        const lines = await fetchSseEvents(envelope.opencode_server_url, { maxEvents: Number(params?.maxEvents || 3), timeoutMs: Number(params?.timeoutMs || 5000) });
        const normalized = lines.map((line) => normalizeOpenCodeEvent(line));
        const useful = normalized.find((x) => x.kind);
        if (!useful || !useful.kind) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No useful SSE event observed", lines, normalized }, null, 2) }] };
        }
        const callback = buildHooksAgentCallback({ event: useful.kind, envelope, summary: useful.summary });
        const state = mapEventToState(useful.kind);
        const result = await executeHooksAgentCallback(hookBaseUrl, hookToken, callback);
        const statusObj: Phase3RunStatus = { taskId: envelope.task_id, runId: envelope.run_id, state, lastEvent: useful.kind, lastSummary: useful.summary, updatedAt: new Date().toISOString(), envelope };
        const statusPath = writeRunStatus(statusObj);
        const auditPath = appendAudit({ taskId: envelope.task_id, runId: envelope.run_id, agentId: envelope.agent_id, sessionKey: envelope.session_key, event: useful.kind, callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.ok, lines, normalized, selected: useful, callback, callbackResult: result, statusPath, auditPath }, null, 2) }], ...(result.ok ? {} : { isError: true }) };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_debug_normalize_event",
      label: "OpenCode Debug Normalize Event",
      description: "Debug helper: normalize raw SSE/event payload và chọn useful event đầu tiên.",
      parameters: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } } },
      async execute(_id: string, params: any) {
        const lines = asArray(params?.lines).map((x) => String(x));
        const normalized = lines.map((line) => normalizeOpenCodeEvent(line));
        const useful = normalized.find((x) => x.kind) || null;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, lines, normalized, useful }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_debug_execute_callback",
      label: "OpenCode Debug Execute Callback",
      description: "Debug helper: thực thi callback thật tới /hooks/agent với payload đã truyền vào và trả kết quả chi tiết.",
      parameters: { type: "object", properties: { callback: { type: "object" }, hookBaseUrl: { type: "string" }, hookToken: { type: "string" } }, required: ["callback", "hookBaseUrl", "hookToken"] },
      async execute(_id: string, params: any) {
        const result = await executeHooksAgentCallback(params.hookBaseUrl, params.hookToken, params.callback as HooksAgentCallbackPayload);
        const auditPath = appendAudit({ callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.ok, result, auditPath }, null, 2) }], ...(result.ok ? {} : { isError: true }) };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_debug_write_status",
      label: "OpenCode Debug Write Status",
      description: "Debug helper: ghi status artifact trực tiếp từ input để cô lập path write status / audit.",
      parameters: { type: "object", properties: { taskId: { type: "string" }, runId: { type: "string" }, state: { type: "string" }, lastEvent: { type: "string" }, lastSummary: { type: "string" }, envelope: { type: "object" } }, required: ["taskId", "runId", "state", "envelope"] },
      async execute(_id: string, params: any) {
        const statusObj: Phase3RunStatus = { taskId: params.taskId, runId: params.runId, state: params.state as BridgeLifecycleState, lastEvent: (params.lastEvent as OpenCodeEventKind) || null, lastSummary: params.lastSummary, updatedAt: new Date().toISOString(), envelope: params.envelope as RoutingEnvelope };
        const statusPath = writeRunStatus(statusObj);
        const auditPath = appendAudit({ taskId: params.taskId, runId: params.runId, agentId: (params.envelope || {}).agent_id, sessionKey: (params.envelope || {}).session_key, event: params.lastEvent, callbackStatus: 0, callbackOk: true, callbackBody: 'debug-write-status', createdAt: new Date().toISOString() });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, statusPath, auditPath, statusObj }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_listen_loop",
      label: "OpenCode Listen Loop",
      description: "Runtime-ops listener runner: đọc nhiều event SSE, evaluate lifecycle, callback permission/stall/completed/failed, và ghi status/audit artifact liên tục cho một run ngắn.",
      parameters: {
        type: "object",
        properties: {
          envelope: { type: "object" },
          hookBaseUrl: { type: "string" },
          hookToken: { type: "string" },
          maxEvents: { type: "number" },
          timeoutMs: { type: "number" },
          softStallMs: { type: "number" },
          hardStallMs: { type: "number" },
          debug: { type: "boolean" }
        },
        required: ["envelope"]
      },
      async execute(_id: string, params: any) {
        const debug = Boolean(params?.debug);
        const checkpoints: any[] = [];
        try {
          const hookBaseUrl = params?.hookBaseUrl || cfg?.hookBaseUrl;
          const hookToken = params?.hookToken || cfg?.hookToken;
          checkpoints.push({ step: 'inputs', hookBaseUrl: Boolean(hookBaseUrl), hookToken: Boolean(hookToken) });
          if (!hookBaseUrl || !hookToken) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing hookBaseUrl or hookToken", checkpoints }, null, 2) }] };
          }
          const envelope = params.envelope as RoutingEnvelope;
          checkpoints.push({ step: 'envelope', envelope });
          const lines = await fetchSseEvents(envelope.opencode_server_url, {
            maxEvents: Number(params?.maxEvents || 5),
            timeoutMs: Number(params?.timeoutMs || 6000),
          });
          checkpoints.push({ step: 'fetchSseEvents', lines });
          const normalized = lines.map((line) => normalizeOpenCodeEvent(line));
          checkpoints.push({ step: 'normalized', normalized });
          const useful = normalized.filter((x) => x.kind);
          checkpoints.push({ step: 'useful', useful });
          let lastKind: OpenCodeEventKind | null = null;
          let lastSummary: string | undefined = undefined;
          let callbackResults: any[] = [];
          let lastEventAtMs = Date.now();
          for (const item of useful) {
            if (!item.kind) continue;
            lastKind = item.kind;
            lastSummary = item.summary;
            lastEventAtMs = Date.now();
            const evaluation = evaluateLifecycle({
              lastEventKind: item.kind,
              lastEventAtMs,
              nowMs: Date.now(),
              softStallMs: asNumber(params?.softStallMs),
              hardStallMs: asNumber(params?.hardStallMs),
            });
            checkpoints.push({ step: 'evaluation', event: item.kind, evaluation });
            if (evaluation.needsPermissionHandling || evaluation.state === 'failed' || evaluation.state === 'completed') {
              const callback = buildHooksAgentCallback({ event: item.kind, envelope, summary: item.summary });
              const result = await executeHooksAgentCallback(hookBaseUrl, hookToken, callback);
              callbackResults.push({ event: item.kind, callback, result });
              appendAudit({ taskId: envelope.task_id, runId: envelope.run_id, agentId: envelope.agent_id, sessionKey: envelope.session_key, event: item.kind, callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
            }
          }
          const noUsefulEvents = useful.length === 0;
          checkpoints.push({ step: 'noUsefulEvents', noUsefulEvents });
          if (noUsefulEvents) {
            const evaluation = evaluateLifecycle({
              lastEventAtMs: Date.now() - Number(params?.hardStallMs || DEFAULT_HARD_STALL_MS),
              nowMs: Date.now(),
              softStallMs: asNumber(params?.softStallMs),
              hardStallMs: asNumber(params?.hardStallMs),
            });
            checkpoints.push({ step: 'stalled-evaluation', evaluation });
            if (evaluation.state === 'stalled') {
              const callback = buildHooksAgentCallback({ event: 'task.stalled', envelope, summary: 'OpenCode listener detected stalled/no useful event window' });
              const result = await executeHooksAgentCallback(hookBaseUrl, hookToken, callback);
              callbackResults.push({ event: 'task.stalled', callback, result });
              appendAudit({ taskId: envelope.task_id, runId: envelope.run_id, agentId: envelope.agent_id, sessionKey: envelope.session_key, event: 'task.stalled', callbackStatus: result.status, callbackOk: result.ok, callbackBody: result.body, createdAt: new Date().toISOString() });
              lastKind = 'task.stalled';
              lastSummary = 'OpenCode listener detected stalled/no useful event window';
            }
          }
          const finalState = lastKind ? mapEventToState(lastKind) : 'stalled';
          const statusObj: Phase3RunStatus = {
            taskId: envelope.task_id,
            runId: envelope.run_id,
            state: finalState,
            lastEvent: lastKind,
            lastSummary,
            updatedAt: new Date().toISOString(),
            envelope,
          };
          const statusPath = writeRunStatus(statusObj);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, lines, normalized, useful, callbackResults, statusPath, finalState, ...(debug ? { checkpoints } : {}) }, null, 2) }]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(debug ? { checkpoints } : {}) }, null, 2) }]
          };
        }
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_check_hook_policy",
      label: "OpenCode Check Hook Policy",
      description: "Kiểm tra checklist/policy tối thiểu cho callback `/hooks/agent` với agentId và sessionKey cụ thể.",
      parameters: { type: "object", properties: { agentId: { type: "string" }, sessionKey: { type: "string" } }, required: ["agentId", "sessionKey"] },
      async execute(_id: string, params: any) {
        const checklist = buildHookPolicyChecklist(params.agentId, params.sessionKey);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, checklist }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_evaluate_lifecycle",
      label: "OpenCode Evaluate Lifecycle",
      description: "Đánh giá lifecycle state hiện tại từ event cuối cùng hoặc thời gian im lặng để hỗ trợ stalled/permission/failure handling baseline.",
      parameters: { type: "object", properties: { lastEventKind: { type: "string", enum: ["task.started", "task.progress", "permission.requested", "task.stalled", "task.failed", "task.completed"] }, lastEventAtMs: { type: "number" }, nowMs: { type: "number" }, softStallMs: { type: "number" }, hardStallMs: { type: "number" } } },
      async execute(_id: string, params: any) {
        const evaluation = evaluateLifecycle({ lastEventKind: params.lastEventKind, lastEventAtMs: asNumber(params.lastEventAtMs), nowMs: asNumber(params.nowMs), softStallMs: asNumber(params.softStallMs), hardStallMs: asNumber(params.hardStallMs) });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, evaluation }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_serve_spawn",
      label: "OpenCode Serve Spawn",
      description: "Bật một opencode serve riêng cho project, tự cấp port động và ghi registry entry tương ứng.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          repo_root: { type: "string" },
          idle_timeout_ms: { type: "number" }
        },
        required: ["project_id", "repo_root"]
      },
      async execute(_id: string, params: any) {
        const result = await spawnServeForProject({
          project_id: params.project_id,
          repo_root: params.repo_root,
          idle_timeout_ms: asNumber(params.idle_timeout_ms),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }]
        };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_registry_get",
      label: "OpenCode Registry Get",
      description: "Đọc serve registry hiện tại của OpenCode bridge để xem mapping project -> serve URL -> pid -> status.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const registry = readServeRegistry();
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: getServeRegistryPath(), registry }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_registry_upsert",
      label: "OpenCode Registry Upsert",
      description: "Ghi hoặc cập nhật một serve registry entry cho project hiện tại (1 project = 1 serve).",
      parameters: { type: "object", properties: { project_id: { type: "string" }, repo_root: { type: "string" }, opencode_server_url: { type: "string" }, pid: { type: "number" }, status: { type: "string", enum: ["running", "stopped", "unknown"] }, last_event_at: { type: "string" }, idle_timeout_ms: { type: "number" } }, required: ["project_id", "repo_root", "opencode_server_url"] },
      async execute(_id: string, params: any) {
        const entry: ServeRegistryEntry = { project_id: params.project_id, repo_root: params.repo_root, opencode_server_url: params.opencode_server_url, ...(params.pid !== undefined ? { pid: Number(params.pid) } : {}), ...(params.status ? { status: params.status } : {}), ...(params.last_event_at ? { last_event_at: params.last_event_at } : {}), ...(params.idle_timeout_ms !== undefined ? { idle_timeout_ms: Number(params.idle_timeout_ms) } : {}), updated_at: new Date().toISOString() };
        const result = upsertServeRegistry(entry);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: result.path, entry, registry: result.registry }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_registry_cleanup",
      label: "OpenCode Registry Cleanup",
      description: "Cleanup/normalize serve registry: loại bỏ entry không đủ field hoặc normalize schema lưu trữ hiện tại.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const before = readServeRegistry();
        const normalized = normalizeServeRegistry(before);
        const path = writeServeRegistryFile(normalized);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path, before, after: normalized }, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_serve_shutdown",
      label: "OpenCode Serve Shutdown",
      description: "Đánh dấu stopped và gửi SIGTERM cho serve của một project nếu registry có pid.",
      parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
      async execute(_id: string, params: any) {
        const registry = normalizeServeRegistry(readServeRegistry());
        const entry = registry.entries.find((x) => x.project_id === params.project_id);
        if (!entry) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: 'Project entry not found' }, null, 2) }] };
        }
        const result = shutdownServe(entry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result.ok ? {} : { isError: true }) };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_serve_idle_check",
      label: "OpenCode Serve Idle Check",
      description: "Đánh giá một serve registry entry có nên shutdown theo idle timeout hay chưa.",
      parameters: { type: "object", properties: { project_id: { type: "string" }, nowMs: { type: "number" } }, required: ["project_id"] },
      async execute(_id: string, params: any) {
        const registry = normalizeServeRegistry(readServeRegistry());
        const entry = registry.entries.find((x) => x.project_id === params.project_id);
        if (!entry) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: 'Project entry not found' }, null, 2) }] };
        }
        const evaluation = evaluateServeIdle(entry, asNumber(params.nowMs));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, entry, evaluation }, null, 2) }] };
      }
    }, { optional: true });
  },
};

export default plugin;
