import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  type EventScope,
  type OpenCodeEventKind,
  parseSseFramesFromBuffer,
  normalizeTypedEventV1,
  resolveSessionId,
} from "./observability";

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

type OpenCodeApiSnapshot = {
  health?: any;
  sessionList?: any[];
  sessionStatus?: any;
  fetchedAt: string;
};

type RunStatusResponse = {
  ok: boolean;
  source: {
    runStatusArtifact: boolean;
    opencodeApi: boolean;
  };
  runId?: string;
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  correlation?: {
    sessionResolution: {
      strategy: string;
      score?: number;
    };
  };
  state: BridgeLifecycleState;
  lastEvent?: OpenCodeEventKind | null;
  lastSummary?: string;
  updatedAt: string;
  timestamps: {
    artifactUpdatedAt?: string;
    apiFetchedAt?: string;
  };
  health?: {
    ok: boolean;
    version?: string;
  };
  apiSnapshot?: OpenCodeApiSnapshot;
  note?: string;
};

type RunEventRecord = {
  index: number;
  scope: EventScope;
  rawLine: string;
  data?: any;
  normalizedKind?: OpenCodeEventKind | null;
  summary?: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  typedEvent?: any;
  timestamp: string;
};

type RunEventsResponse = {
  ok: boolean;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  correlation?: {
    sessionResolution?: {
      strategy: string;
      score?: number;
    };
  };
  scope: EventScope;
  schemaVersion: "opencode.event.v1";
  eventPath: string;
  eventCount: number;
  events: RunEventRecord[];
  truncated: boolean;
  timeoutMs: number;
};

type SessionTailMessage = {
  index: number;
  role?: string;
  text?: string;
  createdAt?: number | string;
  id?: string;
  agent?: string;
  model?: string;
  raw?: any;
};

type SessionTailResponse = {
  ok: boolean;
  sessionId: string;
  runId?: string;
  taskId?: string;
  correlation?: {
    sessionResolution: {
      strategy: string;
      score?: number;
    };
  };
  limit: number;
  totalMessages: number;
  messages: SessionTailMessage[];
  diff?: any;
  latestSummary?: any;
  fetchedAt: string;
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

type BridgeConfigFile = {
  opencodeServerUrl?: string;
  projectRegistry?: {
    projectId: string;
    repoRoot: string;
    serverUrl: string;
    idleTimeoutMs?: number;
  }[];
  hookBaseUrl?: string;
  hookToken?: string;
};

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SOFT_STALL_MS = 60 * 1000;
const DEFAULT_HARD_STALL_MS = 180 * 1000;
const DEFAULT_OBS_TIMEOUT_MS = 3000;
const DEFAULT_TAIL_LIMIT = 20;
const DEFAULT_EVENT_LIMIT = 10;
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

function getBridgeStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, 'opencode-bridge');
}

function getBridgeConfigPath(): string {
  return join(getBridgeStateDir(), 'config.json');
}

function ensureBridgeConfigFile(): BridgeConfigFile {
  const dir = getBridgeStateDir();
  mkdirSync(dir, { recursive: true });
  const path = getBridgeConfigPath();
  if (!existsSync(path)) {
    const initial: BridgeConfigFile = {
      opencodeServerUrl: 'http://127.0.0.1:4096',
      projectRegistry: [],
    };
    writeFileSync(path, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeConfigFile;
}

function writeBridgeConfigFile(data: BridgeConfigFile) {
  const path = getBridgeConfigPath();
  mkdirSync(getBridgeStateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

function getRuntimeConfig(cfg: any): BridgeConfigFile {
  const fileCfg = ensureBridgeConfigFile();
  return {
    opencodeServerUrl: fileCfg.opencodeServerUrl || cfg?.opencodeServerUrl,
    projectRegistry: fileCfg.projectRegistry || cfg?.projectRegistry || [],
    hookBaseUrl: fileCfg.hookBaseUrl || cfg?.hookBaseUrl,
    hookToken: fileCfg.hookToken || cfg?.hookToken,
  };
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
  const runtimeCfg = getRuntimeConfig(cfg);
  const dynamicRegistry = normalizeServeRegistry(readServeRegistry()).entries.map((x) => ({
    projectId: x.project_id,
    repoRoot: x.repo_root,
    serverUrl: x.opencode_server_url,
    idleTimeoutMs: x.idle_timeout_ms,
  }));
  const registry = [...dynamicRegistry, ...normalizeRegistry(runtimeCfg.projectRegistry)].filter(Boolean) as ProjectRegistryEntry[];
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
  return join(getBridgeStateDir(), 'runs');
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
  return join(getBridgeStateDir(), 'audit');
}

function appendAudit(record: CallbackAuditRecord) {
  const dir = getAuditDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "callbacks.jsonl");
  writeFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return path;
}

function getServeRegistryPath(): string {
  return join(getBridgeStateDir(), 'registry.json');
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

function resolveServerUrl(cfg: any, params?: any): string {
  return asString(params?.opencodeServerUrl)
    || asString(params?.serverUrl)
    || getRuntimeConfig(cfg).opencodeServerUrl
    || "http://127.0.0.1:4096";
}

async function fetchJsonSafe(url: string): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    return { ok: response.ok, status: response.status, data };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function resolveSessionForRun(input: {
  sessionId?: string;
  runStatus?: Phase3RunStatus | null;
  sessionList?: any[];
  runId?: string;
}): { sessionId?: string; strategy: string; score?: number } {
  const artifactEnvelope = input.runStatus?.envelope as any;
  const resolved = resolveSessionId({
    explicitSessionId: input.sessionId,
    runId: input.runId || input.runStatus?.runId,
    taskId: input.runStatus?.taskId,
    sessionKey: artifactEnvelope?.session_key,
    artifactSessionId:
      (typeof artifactEnvelope?.session_id === 'string' ? artifactEnvelope.session_id : undefined)
      || (typeof artifactEnvelope?.sessionId === 'string' ? artifactEnvelope.sessionId : undefined),
    sessionList: input.sessionList,
  });
  return { sessionId: resolved.sessionId, strategy: resolved.strategy, ...(resolved.score !== undefined ? { score: resolved.score } : {}) };
}

async function collectSseEvents(
  serverUrl: string,
  scope: EventScope,
  options?: { limit?: number; timeoutMs?: number; runIdHint?: string; taskIdHint?: string; sessionIdHint?: string }
): Promise<RunEventRecord[]> {
  const eventPath = scope === 'session' ? '/event' : '/global/event';
  const limit = Math.max(1, asNumber(options?.limit) || DEFAULT_EVENT_LIMIT);
  const timeoutMs = Math.max(200, asNumber(options?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: RunEventRecord[] = [];
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}${eventPath}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return events;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseFramesFromBuffer(buffer);
      buffer = parsed.remainder;

      for (const frame of parsed.frames) {
        const typed = normalizeTypedEventV1(frame, scope);
        events.push({
          index: events.length,
          scope,
          rawLine: frame.raw,
          data: typed.payload,
          normalizedKind: typed.kind,
          summary: typed.summary,
          runId: typed.runId || options?.runIdHint,
          taskId: typed.taskId || options?.taskIdHint,
          sessionId: typed.sessionId || options?.sessionIdHint,
          typedEvent: typed,
          timestamp: new Date().toISOString(),
        });
        if (events.length >= limit) break;
      }
    }

    if (events.length < limit && buffer.trim()) {
      const tail = parseSseFramesFromBuffer(`${buffer}\n\n`);
      for (const frame of tail.frames) {
        const typed = normalizeTypedEventV1(frame, scope);
        events.push({
          index: events.length,
          scope,
          rawLine: frame.raw,
          data: typed.payload,
          normalizedKind: typed.kind,
          summary: typed.summary,
          runId: typed.runId || options?.runIdHint,
          taskId: typed.taskId || options?.taskIdHint,
          sessionId: typed.sessionId || options?.sessionIdHint,
          typedEvent: typed,
          timestamp: new Date().toISOString(),
        });
        if (events.length >= limit) break;
      }
    }

    try { controller.abort(); } catch {}
    try { await reader.cancel(); } catch {}
    return events;
  } catch {
    return events;
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
        const runtimeCfg = getRuntimeConfig(cfg);
        const registry = normalizeRegistry(runtimeCfg.projectRegistry);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, pluginId: "opencode-bridge", version: "0.1.0", assumption: "1 project = 1 opencode serve instance", sessionKeyConvention: "hook:opencode:<agentId>:<taskId>", lifecycleStates: ["queued", "server_ready", "session_created", "prompt_sent", "running", "awaiting_permission", "stalled", "failed", "completed"], requiredEnvelopeFields: ["task_id", "run_id", "agent_id", "session_key", "origin_session_key", "project_id", "repo_root", "opencode_server_url"], callbackPrimary: "/hooks/agent", callbackNotPrimary: ["/hooks/wake", "cron", "group:sessions"], config: { bridgeConfigPath: getBridgeConfigPath(), opencodeServerUrl: runtimeCfg.opencodeServerUrl || null, hookBaseUrl: runtimeCfg.hookBaseUrl || null, hookTokenPresent: Boolean(runtimeCfg.hookToken), projectRegistry: registry, stateDir: getBridgeStateDir(), runStateDir: getRunStateDir(), auditDir: getAuditDir() }, note: "Runtime-ops scaffold in progress. Plugin-owned config/state is stored under ~/.openclaw/opencode-bridge. New projects are auto-registered only when using opencode_serve_spawn (not by passive envelope build alone)." }, null, 2) }]
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
        const serverUrl = entry?.serverUrl;
        if (!serverUrl) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing project registry mapping. Use opencode_serve_spawn for the project or add a matching projectRegistry entry in ~/.openclaw/opencode-bridge/config.json first." }, null, 2) }]
          };
        }
        const envelope = buildEnvelope({
          taskId: params.taskId,
          runId: params.runId,
          agentId: params.agentId,
          originSessionKey: params.originSessionKey,
          projectId: params.projectId,
          repoRoot: params.repoRoot,
          serverUrl,
          channel: params.channel,
          to: params.to,
          deliver: params.deliver,
          priority: params.priority,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, envelope, registryMatch: entry || null }, null, 2) }]
        };
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
      name: "opencode_run_status",
      label: "OpenCode Run Status",
      description: "Read-only run snapshot: hợp nhất artifact run status local và API snapshot từ OpenCode serve (/global/health, /session, /session/status).",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          sessionId: { type: "string" },
          opencodeServerUrl: { type: "string" },
        }
      },
      async execute(_id: string, params: any) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;

        const [healthRes, sessionRes, sessionStatusRes] = await Promise.all([
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/global/health`),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/status`),
        ]);

        const sessionList = Array.isArray(sessionRes.data) ? sessionRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId,
        });
        const sessionId = resolution.sessionId;
        const state = artifact?.state || (sessionId ? "running" : "queued");

        const response: RunStatusResponse = {
          ok: true,
          source: {
            runStatusArtifact: Boolean(artifact),
            opencodeApi: true,
          },
          runId: runId || undefined,
          taskId: artifact?.taskId,
          projectId: artifact?.envelope?.project_id,
          sessionId,
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...(resolution.score !== undefined ? { score: resolution.score } : {}),
            },
          },
          state,
          lastEvent: artifact?.lastEvent,
          lastSummary: artifact?.lastSummary,
          updatedAt: new Date().toISOString(),
          timestamps: {
            ...(artifact?.updatedAt ? { artifactUpdatedAt: artifact.updatedAt } : {}),
            apiFetchedAt: new Date().toISOString(),
          },
          health: {
            ok: Boolean(healthRes.ok && (healthRes.data?.healthy === true || healthRes.status === 200)),
            ...(asString(healthRes?.data?.version) ? { version: asString(healthRes?.data?.version) } : {}),
          },
          apiSnapshot: {
            health: healthRes.data,
            sessionList,
            sessionStatus: sessionStatusRes.data,
            fetchedAt: new Date().toISOString(),
          },
          ...(artifact ? {} : { note: "No local run artifact found for runId. Returned API-only snapshot." }),
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_run_events",
      label: "OpenCode Run Events",
      description: "Read-only event probe: lấy SSE event từ /event hoặc /global/event, normalize sơ bộ về OpenCodeEventKind.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "global"] },
          limit: { type: "number" },
          timeoutMs: { type: "number" },
          runId: { type: "string" },
          sessionId: { type: "string" },
          opencodeServerUrl: { type: "string" },
        }
      },
      async execute(_id: string, params: any) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;
        const scope: EventScope = params?.scope === "global" ? "global" : "session";
        const timeoutMs = Math.max(200, asNumber(params?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS);
        const limit = Math.max(1, asNumber(params?.limit) || DEFAULT_EVENT_LIMIT);

        const sessionListRes = await fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`);
        const sessionList = Array.isArray(sessionListRes.data) ? sessionListRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId,
        });
        const sessionId = resolution.sessionId;

        const events = await collectSseEvents(serverUrl, scope, {
          limit,
          timeoutMs,
          runIdHint: runId,
          taskIdHint: artifact?.taskId,
          sessionIdHint: sessionId,
        });
        const response: RunEventsResponse = {
          ok: true,
          ...(runId ? { runId } : {}),
          ...(artifact?.taskId ? { taskId: artifact.taskId } : {}),
          ...(sessionId ? { sessionId } : {}),
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...(resolution.score !== undefined ? { score: resolution.score } : {}),
            },
          },
          scope,
          schemaVersion: "opencode.event.v1",
          eventPath: scope === "global" ? "/global/event" : "/event",
          eventCount: events.length,
          events,
          truncated: events.length >= limit,
          timeoutMs,
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    }, { optional: true });

    api.registerTool({
      name: "opencode_session_tail",
      label: "OpenCode Session Tail",
      description: "Read-only session tail: đọc message tail từ /session/{id}/message và optional diff từ /session/{id}/diff.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          runId: { type: "string" },
          limit: { type: "number" },
          includeDiff: { type: "boolean" },
          opencodeServerUrl: { type: "string" },
        }
      },
      async execute(_id: string, params: any) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;

        const sessionListRes = await fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`);
        const sessionList = Array.isArray(sessionListRes.data) ? sessionListRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId,
        });
        const sessionId = resolution.sessionId;
        if (!sessionId) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing sessionId and could not resolve from run artifact/session list." }, null, 2) }]
          };
        }

        const limit = Math.max(1, asNumber(params?.limit) || DEFAULT_TAIL_LIMIT);
        const includeDiff = params?.includeDiff !== false;

        const [messagesRes, diffRes, sessionRes] = await Promise.all([
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message`),
          includeDiff ? fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}/diff`) : Promise.resolve({ ok: false, data: undefined }),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}`),
        ]);

        const rawMessages = Array.isArray(messagesRes.data) ? messagesRes.data : [];
        const tail = rawMessages.slice(Math.max(0, rawMessages.length - limit)).map((msg: any, idx: number) => {
          const info = msg?.info || {};
          const parts = Array.isArray(msg?.parts) ? msg.parts : [];
          const text = parts
            .filter((p: any) => p?.type === 'text' && typeof p?.text === 'string')
            .map((p: any) => p.text)
            .join("\n");
          return {
            index: idx,
            role: asString(info.role),
            text: text || undefined,
            createdAt: info?.time?.created,
            id: asString(info.id),
            agent: asString(info.agent),
            model: asString(info?.model?.modelID),
            raw: msg,
          } as SessionTailMessage;
        });

        const response: SessionTailResponse = {
          ok: true,
          sessionId,
          ...(runId ? { runId } : {}),
          ...(artifact?.taskId ? { taskId: artifact.taskId } : {}),
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...(resolution.score !== undefined ? { score: resolution.score } : {}),
            },
          },
          limit,
          totalMessages: rawMessages.length,
          messages: tail,
          ...(includeDiff ? { diff: diffRes.data } : {}),
          latestSummary: sessionRes.data,
          fetchedAt: new Date().toISOString(),
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
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
