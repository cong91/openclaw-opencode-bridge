import {
  normalizeTypedEventV1,
  parseSseFramesFromBuffer,
  resolveSessionId
} from "./chunk-6NIQKNRA.js";

// src/index.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { createServer } from "net";
var DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1e3;
var DEFAULT_SOFT_STALL_MS = 60 * 1e3;
var DEFAULT_HARD_STALL_MS = 180 * 1e3;
var DEFAULT_OBS_TIMEOUT_MS = 3e3;
var DEFAULT_TAIL_LIMIT = 20;
var DEFAULT_EVENT_LIMIT = 10;
var HOOK_PREFIX = "hook:opencode:";
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : void 0;
}
function buildSessionKey(agentId, taskId) {
  return `${HOOK_PREFIX}${agentId}:${taskId}`;
}
function getBridgeStateDir() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return join(stateDir, "opencode-bridge");
}
function getBridgeConfigPath() {
  return join(getBridgeStateDir(), "config.json");
}
function ensureBridgeConfigFile() {
  const dir = getBridgeStateDir();
  mkdirSync(dir, { recursive: true });
  const path = getBridgeConfigPath();
  if (!existsSync(path)) {
    const initial = {
      opencodeServerUrl: "http://127.0.0.1:4096",
      projectRegistry: []
    };
    writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
function getRuntimeConfig(cfg) {
  const fileCfg = ensureBridgeConfigFile();
  return {
    opencodeServerUrl: fileCfg.opencodeServerUrl || cfg?.opencodeServerUrl,
    projectRegistry: fileCfg.projectRegistry || cfg?.projectRegistry || [],
    hookBaseUrl: fileCfg.hookBaseUrl || cfg?.hookBaseUrl,
    hookToken: fileCfg.hookToken || cfg?.hookToken
  };
}
function normalizeRegistry(raw) {
  return asArray(raw).map((item) => {
    const obj = item && typeof item === "object" ? item : {};
    const projectId = asString(obj.projectId);
    const repoRoot = asString(obj.repoRoot);
    const serverUrl = asString(obj.serverUrl);
    const idleTimeoutMs = Number(obj.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS);
    if (!projectId || !repoRoot || !serverUrl) return null;
    return {
      projectId,
      repoRoot,
      serverUrl,
      idleTimeoutMs: Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS
    };
  }).filter(Boolean);
}
function findRegistryEntry(cfg, projectId, repoRoot) {
  const runtimeCfg = getRuntimeConfig(cfg);
  const dynamicRegistry = normalizeServeRegistry(readServeRegistry()).entries.map((x) => ({
    projectId: x.project_id,
    repoRoot: x.repo_root,
    serverUrl: x.opencode_server_url,
    idleTimeoutMs: x.idle_timeout_ms
  }));
  const registry = [...dynamicRegistry, ...normalizeRegistry(runtimeCfg.projectRegistry)].filter(Boolean);
  if (projectId) {
    const byProject = registry.find((x) => x.projectId === projectId);
    if (byProject) return byProject;
  }
  if (repoRoot) {
    const byRoot = registry.find((x) => x.repoRoot === repoRoot);
    if (byRoot) return byRoot;
  }
  return void 0;
}
function buildEnvelope(input) {
  return {
    task_id: input.taskId,
    run_id: input.runId,
    agent_id: input.agentId,
    session_key: buildSessionKey(input.agentId, input.taskId),
    origin_session_key: input.originSessionKey,
    project_id: input.projectId,
    repo_root: input.repoRoot,
    opencode_server_url: input.serverUrl,
    ...input.channel ? { channel: input.channel } : {},
    ...input.to ? { to: input.to } : {},
    ...input.deliver !== void 0 ? { deliver: input.deliver } : {},
    ...input.priority ? { priority: input.priority } : {}
  };
}
function mapEventToState(event) {
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
function evaluateLifecycle(input) {
  const nowMs = input.nowMs ?? Date.now();
  const softStallMs = input.softStallMs ?? DEFAULT_SOFT_STALL_MS;
  const hardStallMs = input.hardStallMs ?? DEFAULT_HARD_STALL_MS;
  if (input.lastEventKind) {
    const state = mapEventToState(input.lastEventKind);
    return {
      state,
      escalateToMain: state === "failed" || state === "completed",
      needsPermissionHandling: state === "awaiting_permission",
      stallSeverity: null
    };
  }
  if (!input.lastEventAtMs) {
    return {
      state: "queued",
      escalateToMain: false,
      needsPermissionHandling: false,
      stallSeverity: null
    };
  }
  const age = nowMs - input.lastEventAtMs;
  if (age >= hardStallMs) {
    return { state: "stalled", escalateToMain: true, needsPermissionHandling: false, stallSeverity: "hard" };
  }
  if (age >= softStallMs) {
    return { state: "stalled", escalateToMain: false, needsPermissionHandling: false, stallSeverity: "soft" };
  }
  return { state: "running", escalateToMain: false, needsPermissionHandling: false, stallSeverity: null };
}
function getRunStateDir() {
  return join(getBridgeStateDir(), "runs");
}
function readRunStatus(runId) {
  const path = join(getRunStateDir(), `${runId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
function getAuditDir() {
  return join(getBridgeStateDir(), "audit");
}
function getServeRegistryPath() {
  return join(getBridgeStateDir(), "registry.json");
}
function readServeRegistry() {
  const path = getServeRegistryPath();
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}
function normalizeServeRegistry(registry) {
  const entries = asArray(registry.entries).map((entry) => {
    const e = entry && typeof entry === "object" ? entry : {};
    const project_id = asString(e.project_id);
    const repo_root = asString(e.repo_root);
    const opencode_server_url = asString(e.opencode_server_url);
    if (!project_id || !repo_root || !opencode_server_url) return null;
    return {
      project_id,
      repo_root,
      opencode_server_url,
      ...asNumber(e.pid) !== void 0 ? { pid: asNumber(e.pid) } : {},
      ...asString(e.status) ? { status: asString(e.status) } : {},
      ...asString(e.last_event_at) ? { last_event_at: asString(e.last_event_at) } : {},
      idle_timeout_ms: asNumber(e.idle_timeout_ms) ?? DEFAULT_IDLE_TIMEOUT_MS,
      updated_at: asString(e.updated_at) || (/* @__PURE__ */ new Date()).toISOString()
    };
  }).filter(Boolean);
  return { entries };
}
function writeServeRegistryFile(data) {
  const path = getServeRegistryPath();
  writeFileSync(path, JSON.stringify(normalizeServeRegistry(data), null, 2), "utf8");
  return path;
}
function upsertServeRegistry(entry) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const idx = registry.entries.findIndex((x) => x.project_id === entry.project_id || x.repo_root === entry.repo_root);
  if (idx >= 0) registry.entries[idx] = entry;
  else registry.entries.push(entry);
  const path = writeServeRegistryFile(registry);
  return { path, registry };
}
function evaluateServeIdle(entry, nowMs) {
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
    reason: idleMs >= idleTimeoutMs ? "idle_timeout_exceeded" : "within_idle_window"
  };
}
async function allocatePort() {
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
async function waitForHealth(serverUrl, timeoutMs = 1e4) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${serverUrl}/global/health`);
      if (r.ok) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function spawnServeForProject(input) {
  const existing = normalizeServeRegistry(readServeRegistry()).entries.find((x) => x.project_id === input.project_id || x.repo_root === input.repo_root);
  if (existing && existing.status === "running") {
    const healthy2 = await waitForHealth(existing.opencode_server_url, 2e3);
    if (healthy2) {
      return { reused: true, entry: existing, registryPath: getServeRegistryPath() };
    }
  }
  const port = await allocatePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const serverUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(serverUrl, 1e4);
  const entry = {
    project_id: input.project_id,
    repo_root: input.repo_root,
    opencode_server_url: serverUrl,
    pid: child.pid,
    status: healthy ? "running" : "unknown",
    last_event_at: (/* @__PURE__ */ new Date()).toISOString(),
    idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const result = upsertServeRegistry(entry);
  return { reused: false, entry, healthy, registryPath: result.path };
}
function markServeStopped(projectId) {
  const registry = normalizeServeRegistry(readServeRegistry());
  const entry = registry.entries.find((x) => x.project_id === projectId);
  if (!entry) return { ok: false, error: "Project entry not found" };
  entry.status = "stopped";
  entry.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  const path = writeServeRegistryFile(registry);
  return { ok: true, path, entry, registry };
}
function shutdownServe(entry) {
  if (entry.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
    }
  }
  return markServeStopped(entry.project_id);
}
function resolveServerUrl(cfg, params) {
  return asString(params?.opencodeServerUrl) || asString(params?.serverUrl) || getRuntimeConfig(cfg).opencodeServerUrl || "http://127.0.0.1:4096";
}
async function fetchJsonSafe(url) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let data = void 0;
    try {
      data = text ? JSON.parse(text) : void 0;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
function resolveSessionForRun(input) {
  const artifactEnvelope = input.runStatus?.envelope;
  const resolved = resolveSessionId({
    explicitSessionId: input.sessionId,
    runId: input.runId || input.runStatus?.runId,
    taskId: input.runStatus?.taskId,
    sessionKey: artifactEnvelope?.session_key,
    artifactSessionId: (typeof artifactEnvelope?.session_id === "string" ? artifactEnvelope.session_id : void 0) || (typeof artifactEnvelope?.sessionId === "string" ? artifactEnvelope.sessionId : void 0),
    sessionList: input.sessionList
  });
  return { sessionId: resolved.sessionId, strategy: resolved.strategy, ...resolved.score !== void 0 ? { score: resolved.score } : {} };
}
async function collectSseEvents(serverUrl, scope, options) {
  const eventPath = scope === "session" ? "/event" : "/global/event";
  const limit = Math.max(1, asNumber(options?.limit) || DEFAULT_EVENT_LIMIT);
  const timeoutMs = Math.max(200, asNumber(options?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}${eventPath}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal
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
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        if (events.length >= limit) break;
      }
    }
    if (events.length < limit && buffer.trim()) {
      const tail = parseSseFramesFromBuffer(`${buffer}

`);
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
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        if (events.length >= limit) break;
      }
    }
    try {
      controller.abort();
    } catch {
    }
    try {
      await reader.cancel();
    } catch {
    }
    return events;
  } catch {
    return events;
  } finally {
    clearTimeout(timeout);
  }
}
function buildHookPolicyChecklist(agentId, sessionKey) {
  return {
    callbackPrimary: "/hooks/agent",
    requirements: {
      hooksEnabled: true,
      allowRequestSessionKey: true,
      allowedAgentIdsMustInclude: agentId,
      allowedSessionKeyPrefixesMustInclude: HOOK_PREFIX,
      deliverDefault: false
    },
    sessionKey,
    suggestedConfig: {
      hooks: {
        enabled: true,
        allowRequestSessionKey: true,
        allowedAgentIds: [agentId],
        allowedSessionKeyPrefixes: [HOOK_PREFIX]
      }
    }
  };
}
var plugin = {
  id: "opencode-bridge",
  name: "OpenCode Bridge",
  version: "0.1.0",
  register(api) {
    const cfg = api?.pluginConfig || {};
    console.log("[opencode-bridge] scaffold loaded");
    console.log(`[opencode-bridge] opencodeServerUrl=${cfg.opencodeServerUrl || "(unset)"}`);
    console.log("[opencode-bridge] registering opencode_* tool set");
    api.registerTool({
      name: "opencode_status",
      label: "OpenCode Status",
      description: "Hi\u1EC3n th\u1ECB contract hi\u1EC7n t\u1EA1i c\u1EE7a OpenCode bridge: sessionKey convention, routing envelope schema, registry, lifecycle state skeleton v\xE0 assumption 1 project = 1 serve.",
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
      description: "Resolve project registry entry theo projectId ho\u1EB7c repoRoot, \xE1p d\u1EE5ng assumption 1 project = 1 serve instance.",
      parameters: { type: "object", properties: { projectId: { type: "string" }, repoRoot: { type: "string" } } },
      async execute(_id, params) {
        const entry = findRegistryEntry(cfg, params?.projectId, params?.repoRoot);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, match: entry || null }, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_build_envelope",
      label: "OpenCode Build Envelope",
      description: "D\u1EF1ng routing envelope chu\u1EA9n cho task delegate sang OpenCode v\u1EDBi sessionKey convention hook:opencode:<agentId>:<taskId>.",
      parameters: { type: "object", properties: { taskId: { type: "string" }, runId: { type: "string" }, agentId: { type: "string" }, originSessionKey: { type: "string" }, projectId: { type: "string" }, repoRoot: { type: "string" }, channel: { type: "string" }, to: { type: "string" }, deliver: { type: "boolean" }, priority: { type: "string" } }, required: ["taskId", "runId", "agentId", "originSessionKey", "projectId", "repoRoot"] },
      async execute(_id, params) {
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
          priority: params.priority
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, envelope, registryMatch: entry || null }, null, 2) }]
        };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_check_hook_policy",
      label: "OpenCode Check Hook Policy",
      description: "Ki\u1EC3m tra checklist/policy t\u1ED1i thi\u1EC3u cho callback `/hooks/agent` v\u1EDBi agentId v\xE0 sessionKey c\u1EE5 th\u1EC3.",
      parameters: { type: "object", properties: { agentId: { type: "string" }, sessionKey: { type: "string" } }, required: ["agentId", "sessionKey"] },
      async execute(_id, params) {
        const checklist = buildHookPolicyChecklist(params.agentId, params.sessionKey);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, checklist }, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_evaluate_lifecycle",
      label: "OpenCode Evaluate Lifecycle",
      description: "\u0110\xE1nh gi\xE1 lifecycle state hi\u1EC7n t\u1EA1i t\u1EEB event cu\u1ED1i c\xF9ng ho\u1EB7c th\u1EDDi gian im l\u1EB7ng \u0111\u1EC3 h\u1ED7 tr\u1EE3 stalled/permission/failure handling baseline.",
      parameters: { type: "object", properties: { lastEventKind: { type: "string", enum: ["task.started", "task.progress", "permission.requested", "task.stalled", "task.failed", "task.completed"] }, lastEventAtMs: { type: "number" }, nowMs: { type: "number" }, softStallMs: { type: "number" }, hardStallMs: { type: "number" } } },
      async execute(_id, params) {
        const evaluation = evaluateLifecycle({ lastEventKind: params.lastEventKind, lastEventAtMs: asNumber(params.lastEventAtMs), nowMs: asNumber(params.nowMs), softStallMs: asNumber(params.softStallMs), hardStallMs: asNumber(params.hardStallMs) });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, evaluation }, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_run_status",
      label: "OpenCode Run Status",
      description: "Read-only run snapshot: h\u1EE3p nh\u1EA5t artifact run status local v\xE0 API snapshot t\u1EEB OpenCode serve (/global/health, /session, /session/status).",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          sessionId: { type: "string" },
          opencodeServerUrl: { type: "string" }
        }
      },
      async execute(_id, params) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;
        const [healthRes, sessionRes, sessionStatusRes] = await Promise.all([
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/global/health`),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/status`)
        ]);
        const sessionList = Array.isArray(sessionRes.data) ? sessionRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId
        });
        const sessionId = resolution.sessionId;
        const state = artifact?.state || (sessionId ? "running" : "queued");
        const response = {
          ok: true,
          source: {
            runStatusArtifact: Boolean(artifact),
            opencodeApi: true
          },
          runId: runId || void 0,
          taskId: artifact?.taskId,
          projectId: artifact?.envelope?.project_id,
          sessionId,
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...resolution.score !== void 0 ? { score: resolution.score } : {}
            }
          },
          state,
          lastEvent: artifact?.lastEvent,
          lastSummary: artifact?.lastSummary,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          timestamps: {
            ...artifact?.updatedAt ? { artifactUpdatedAt: artifact.updatedAt } : {},
            apiFetchedAt: (/* @__PURE__ */ new Date()).toISOString()
          },
          health: {
            ok: Boolean(healthRes.ok && (healthRes.data?.healthy === true || healthRes.status === 200)),
            ...asString(healthRes?.data?.version) ? { version: asString(healthRes?.data?.version) } : {}
          },
          apiSnapshot: {
            health: healthRes.data,
            sessionList,
            sessionStatus: sessionStatusRes.data,
            fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
          },
          ...artifact ? {} : { note: "No local run artifact found for runId. Returned API-only snapshot." }
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_run_events",
      label: "OpenCode Run Events",
      description: "Read-only event probe: l\u1EA5y SSE event t\u1EEB /event ho\u1EB7c /global/event, normalize s\u01A1 b\u1ED9 v\u1EC1 OpenCodeEventKind.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "global"] },
          limit: { type: "number" },
          timeoutMs: { type: "number" },
          runId: { type: "string" },
          sessionId: { type: "string" },
          opencodeServerUrl: { type: "string" }
        }
      },
      async execute(_id, params) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;
        const scope = params?.scope === "global" ? "global" : "session";
        const timeoutMs = Math.max(200, asNumber(params?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS);
        const limit = Math.max(1, asNumber(params?.limit) || DEFAULT_EVENT_LIMIT);
        const sessionListRes = await fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`);
        const sessionList = Array.isArray(sessionListRes.data) ? sessionListRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId
        });
        const sessionId = resolution.sessionId;
        const events = await collectSseEvents(serverUrl, scope, {
          limit,
          timeoutMs,
          runIdHint: runId,
          taskIdHint: artifact?.taskId,
          sessionIdHint: sessionId
        });
        const response = {
          ok: true,
          ...runId ? { runId } : {},
          ...artifact?.taskId ? { taskId: artifact.taskId } : {},
          ...sessionId ? { sessionId } : {},
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...resolution.score !== void 0 ? { score: resolution.score } : {}
            }
          },
          scope,
          schemaVersion: "opencode.event.v1",
          eventPath: scope === "global" ? "/global/event" : "/event",
          eventCount: events.length,
          events,
          truncated: events.length >= limit,
          timeoutMs
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_session_tail",
      label: "OpenCode Session Tail",
      description: "Read-only session tail: \u0111\u1ECDc message tail t\u1EEB /session/{id}/message v\xE0 optional diff t\u1EEB /session/{id}/diff.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          runId: { type: "string" },
          limit: { type: "number" },
          includeDiff: { type: "boolean" },
          opencodeServerUrl: { type: "string" }
        }
      },
      async execute(_id, params) {
        const serverUrl = resolveServerUrl(cfg, params);
        const runId = asString(params?.runId);
        const artifact = runId ? readRunStatus(runId) : null;
        const sessionListRes = await fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session`);
        const sessionList = Array.isArray(sessionListRes.data) ? sessionListRes.data : [];
        const resolution = resolveSessionForRun({
          sessionId: asString(params?.sessionId),
          runStatus: artifact,
          sessionList,
          runId
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
          includeDiff ? fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}/diff`) : Promise.resolve({ ok: false, data: void 0 }),
          fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}`)
        ]);
        const rawMessages = Array.isArray(messagesRes.data) ? messagesRes.data : [];
        const tail = rawMessages.slice(Math.max(0, rawMessages.length - limit)).map((msg, idx) => {
          const info = msg?.info || {};
          const parts = Array.isArray(msg?.parts) ? msg.parts : [];
          const text = parts.filter((p) => p?.type === "text" && typeof p?.text === "string").map((p) => p.text).join("\n");
          return {
            index: idx,
            role: asString(info.role),
            text: text || void 0,
            createdAt: info?.time?.created,
            id: asString(info.id),
            agent: asString(info.agent),
            model: asString(info?.model?.modelID),
            raw: msg
          };
        });
        const response = {
          ok: true,
          sessionId,
          ...runId ? { runId } : {},
          ...artifact?.taskId ? { taskId: artifact.taskId } : {},
          correlation: {
            sessionResolution: {
              strategy: resolution.strategy,
              ...resolution.score !== void 0 ? { score: resolution.score } : {}
            }
          },
          limit,
          totalMessages: rawMessages.length,
          messages: tail,
          ...includeDiff ? { diff: diffRes.data } : {},
          latestSummary: sessionRes.data,
          fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_serve_spawn",
      label: "OpenCode Serve Spawn",
      description: "B\u1EADt m\u1ED9t opencode serve ri\xEAng cho project, t\u1EF1 c\u1EA5p port \u0111\u1ED9ng v\xE0 ghi registry entry t\u01B0\u01A1ng \u1EE9ng.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          repo_root: { type: "string" },
          idle_timeout_ms: { type: "number" }
        },
        required: ["project_id", "repo_root"]
      },
      async execute(_id, params) {
        const result = await spawnServeForProject({
          project_id: params.project_id,
          repo_root: params.repo_root,
          idle_timeout_ms: asNumber(params.idle_timeout_ms)
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }]
        };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_registry_get",
      label: "OpenCode Registry Get",
      description: "\u0110\u1ECDc serve registry hi\u1EC7n t\u1EA1i c\u1EE7a OpenCode bridge \u0111\u1EC3 xem mapping project -> serve URL -> pid -> status.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const registry = readServeRegistry();
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: getServeRegistryPath(), registry }, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_registry_upsert",
      label: "OpenCode Registry Upsert",
      description: "Ghi ho\u1EB7c c\u1EADp nh\u1EADt m\u1ED9t serve registry entry cho project hi\u1EC7n t\u1EA1i (1 project = 1 serve).",
      parameters: { type: "object", properties: { project_id: { type: "string" }, repo_root: { type: "string" }, opencode_server_url: { type: "string" }, pid: { type: "number" }, status: { type: "string", enum: ["running", "stopped", "unknown"] }, last_event_at: { type: "string" }, idle_timeout_ms: { type: "number" } }, required: ["project_id", "repo_root", "opencode_server_url"] },
      async execute(_id, params) {
        const entry = { project_id: params.project_id, repo_root: params.repo_root, opencode_server_url: params.opencode_server_url, ...params.pid !== void 0 ? { pid: Number(params.pid) } : {}, ...params.status ? { status: params.status } : {}, ...params.last_event_at ? { last_event_at: params.last_event_at } : {}, ...params.idle_timeout_ms !== void 0 ? { idle_timeout_ms: Number(params.idle_timeout_ms) } : {}, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
        const result = upsertServeRegistry(entry);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: result.path, entry, registry: result.registry }, null, 2) }] };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_registry_cleanup",
      label: "OpenCode Registry Cleanup",
      description: "Cleanup/normalize serve registry: lo\u1EA1i b\u1ECF entry kh\xF4ng \u0111\u1EE7 field ho\u1EB7c normalize schema l\u01B0u tr\u1EEF hi\u1EC7n t\u1EA1i.",
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
      description: "\u0110\xE1nh d\u1EA5u stopped v\xE0 g\u1EEDi SIGTERM cho serve c\u1EE7a m\u1ED9t project n\u1EBFu registry c\xF3 pid.",
      parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
      async execute(_id, params) {
        const registry = normalizeServeRegistry(readServeRegistry());
        const entry = registry.entries.find((x) => x.project_id === params.project_id);
        if (!entry) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Project entry not found" }, null, 2) }] };
        }
        const result = shutdownServe(entry);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...result.ok ? {} : { isError: true } };
      }
    }, { optional: true });
    api.registerTool({
      name: "opencode_serve_idle_check",
      label: "OpenCode Serve Idle Check",
      description: "\u0110\xE1nh gi\xE1 m\u1ED9t serve registry entry c\xF3 n\xEAn shutdown theo idle timeout hay ch\u01B0a.",
      parameters: { type: "object", properties: { project_id: { type: "string" }, nowMs: { type: "number" } }, required: ["project_id"] },
      async execute(_id, params) {
        const registry = normalizeServeRegistry(readServeRegistry());
        const entry = registry.entries.find((x) => x.project_id === params.project_id);
        if (!entry) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Project entry not found" }, null, 2) }] };
        }
        const evaluation = evaluateServeIdle(entry, asNumber(params.nowMs));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, entry, evaluation }, null, 2) }] };
      }
    }, { optional: true });
  }
};
var index_default = plugin;
export {
  index_default as default
};
