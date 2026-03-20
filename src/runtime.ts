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
import type {
  BridgeConfigFile,
  BridgeLifecycleState,
  CallbackAuditRecord,
  HooksAgentCallbackPayload,
  Phase3RunStatus,
  ProjectRegistryEntry,
  RoutingEnvelope,
  RunEventRecord,
  ServeRegistryEntry,
  ServeRegistryFile,
} from "./types";

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SOFT_STALL_MS = 60 * 1000;
export const DEFAULT_HARD_STALL_MS = 180 * 1000;
export const DEFAULT_OBS_TIMEOUT_MS = 3000;
export const DEFAULT_TAIL_LIMIT = 20;
export const DEFAULT_EVENT_LIMIT = 10;
export const HOOK_PREFIX = "hook:opencode:";

export function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function buildSessionKey(agentId: string, taskId: string): string {
  return `${HOOK_PREFIX}${agentId}:${taskId}`;
}

export function getBridgeStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, "opencode-bridge");
}

export function getBridgeConfigPath(): string {
  return join(getBridgeStateDir(), "config.json");
}

export function ensureBridgeConfigFile(): BridgeConfigFile {
  const dir = getBridgeStateDir();
  mkdirSync(dir, { recursive: true });
  const path = getBridgeConfigPath();
  if (!existsSync(path)) {
    const initial: BridgeConfigFile = {
      opencodeServerUrl: "http://127.0.0.1:4096",
      projectRegistry: [],
    };
    writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  return JSON.parse(readFileSync(path, "utf8")) as BridgeConfigFile;
}

export function writeBridgeConfigFile(data: BridgeConfigFile) {
  const path = getBridgeConfigPath();
  mkdirSync(getBridgeStateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

export function getRuntimeConfig(cfg: any): BridgeConfigFile {
  const fileCfg = ensureBridgeConfigFile();
  return {
    opencodeServerUrl: fileCfg.opencodeServerUrl || cfg?.opencodeServerUrl,
    projectRegistry: fileCfg.projectRegistry || cfg?.projectRegistry || [],
    hookBaseUrl: fileCfg.hookBaseUrl || cfg?.hookBaseUrl,
    hookToken: fileCfg.hookToken || cfg?.hookToken,
  };
}

export function normalizeRegistry(raw: unknown): ProjectRegistryEntry[] {
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

export function findRegistryEntry(cfg: any, projectId?: string, repoRoot?: string): ProjectRegistryEntry | undefined {
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

export function buildEnvelope(input: {
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

export function mapEventToState(event: OpenCodeEventKind): BridgeLifecycleState {
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

export function buildHooksAgentCallback(input: {
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

export function evaluateLifecycle(input: {
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

export function getRunStateDir(): string {
  return join(getBridgeStateDir(), "runs");
}

export function writeRunStatus(status: Phase3RunStatus) {
  const dir = getRunStateDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${status.runId}.json`);
  writeFileSync(path, JSON.stringify(status, null, 2), "utf8");
  return path;
}

export function readRunStatus(runId: string): Phase3RunStatus | null {
  const path = join(getRunStateDir(), `${runId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Phase3RunStatus;
}

export function getAuditDir(): string {
  return join(getBridgeStateDir(), "audit");
}

export function appendAudit(record: CallbackAuditRecord) {
  const dir = getAuditDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "callbacks.jsonl");
  writeFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return path;
}

export function getServeRegistryPath(): string {
  return join(getBridgeStateDir(), "registry.json");
}

export function readServeRegistry(): ServeRegistryFile {
  const path = getServeRegistryPath();
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ServeRegistryFile;
}

export function normalizeServeRegistry(registry: ServeRegistryFile): ServeRegistryFile {
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
        ...(asString(e.status) ? { status: asString(e.status) as ServeRegistryEntry["status"] } : {}),
        ...(asString(e.last_event_at) ? { last_event_at: asString(e.last_event_at) } : {}),
        idle_timeout_ms: asNumber(e.idle_timeout_ms) ?? DEFAULT_IDLE_TIMEOUT_MS,
        updated_at: asString(e.updated_at) || new Date().toISOString(),
      } as ServeRegistryEntry;
    })
    .filter(Boolean) as ServeRegistryEntry[];
  return { entries };
}

export function writeServeRegistryFile(data: ServeRegistryFile) {
  const path = getServeRegistryPath();
  writeFileSync(path, JSON.stringify(normalizeServeRegistry(data), null, 2), "utf8");
  return path;
}

export function upsertServeRegistry(entry: ServeRegistryEntry) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const idx = registry.entries.findIndex((x) => x.project_id === entry.project_id || x.repo_root === entry.repo_root);
  if (idx >= 0) registry.entries[idx] = entry;
  else registry.entries.push(entry);
  const path = writeServeRegistryFile(registry);
  return { path, registry };
}

export function evaluateServeIdle(entry: ServeRegistryEntry, nowMs?: number) {
  const now = nowMs ?? Date.now();
  const last = entry.last_event_at ? Date.parse(entry.last_event_at) : NaN;
  const idleTimeoutMs = entry.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(last)) {
    return { shouldShutdown: false, idleMs: null, reason: "missing_last_event_at" };
  }
  const idleMs = now - last;
  return {
    shouldShutdown: idleMs >= idleTimeoutMs,
    idleMs,
    idleTimeoutMs,
    reason: idleMs >= idleTimeoutMs ? "idle_timeout_exceeded" : "within_idle_window",
  };
}

export async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function waitForHealth(serverUrl: string, timeoutMs = 10000) {
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

export async function spawnServeForProject(input: {
  project_id: string;
  repo_root: string;
  idle_timeout_ms?: number;
}) {
  const existing = normalizeServeRegistry(readServeRegistry()).entries.find((x) => x.project_id === input.project_id || x.repo_root === input.repo_root);
  if (existing && existing.status === "running") {
    const healthy = await waitForHealth(existing.opencode_server_url, 2000);
    if (healthy) {
      return { reused: true, entry: existing, registryPath: getServeRegistryPath() };
    }
  }
  const port = await allocatePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const serverUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(serverUrl, 10000);
  const entry: ServeRegistryEntry = {
    project_id: input.project_id,
    repo_root: input.repo_root,
    opencode_server_url: serverUrl,
    pid: child.pid,
    status: healthy ? "running" : "unknown",
    last_event_at: new Date().toISOString(),
    idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
    updated_at: new Date().toISOString(),
  };
  const result = upsertServeRegistry(entry);
  return { reused: false, entry, healthy, registryPath: result.path };
}

export function markServeStopped(projectId: string) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const entry = registry.entries.find((x) => x.project_id === projectId);
  if (!entry) return { ok: false, error: "Project entry not found" };
  entry.status = "stopped";
  entry.updated_at = new Date().toISOString();
  const path = writeServeRegistryFile(registry);
  return { ok: true, path, entry, registry };
}

export function shutdownServe(entry: ServeRegistryEntry) {
  if (entry.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {}
  }
  return markServeStopped(entry.project_id);
}

export async function fetchSseEvents(serverUrl: string, options?: { maxEvents?: number; timeoutMs?: number }) {
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
    try {
      controller.abort();
    } catch {}
    try {
      await reader.cancel();
    } catch {}
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

export function resolveServerUrl(cfg: any, params?: any): string {
  return asString(params?.opencodeServerUrl) || asString(params?.serverUrl) || getRuntimeConfig(cfg).opencodeServerUrl || "http://127.0.0.1:4096";
}

export async function fetchJsonSafe(url: string): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export function resolveSessionForRun(input: {
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
      (typeof artifactEnvelope?.session_id === "string" ? artifactEnvelope.session_id : undefined) ||
      (typeof artifactEnvelope?.sessionId === "string" ? artifactEnvelope.sessionId : undefined),
    sessionList: input.sessionList,
  });
  return { sessionId: resolved.sessionId, strategy: resolved.strategy, ...(resolved.score !== undefined ? { score: resolved.score } : {}) };
}

export async function collectSseEvents(
  serverUrl: string,
  scope: EventScope,
  options?: { limit?: number; timeoutMs?: number; runIdHint?: string; taskIdHint?: string; sessionIdHint?: string }
): Promise<RunEventRecord[]> {
  const eventPath = scope === "session" ? "/event" : "/global/event";
  const limit = Math.max(1, asNumber(options?.limit) || DEFAULT_EVENT_LIMIT);
  const timeoutMs = Math.max(200, asNumber(options?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: RunEventRecord[] = [];
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}${eventPath}`, {
      headers: { Accept: "text/event-stream" },
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

    try {
      controller.abort();
    } catch {}
    try {
      await reader.cancel();
    } catch {}
    return events;
  } catch {
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeHooksAgentCallback(hookBaseUrl: string, hookToken: string, callback: HooksAgentCallbackPayload) {
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

export function buildHookPolicyChecklist(agentId: string, sessionKey: string) {
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
