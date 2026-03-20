import type {
  RunStatusResponse,
  RunEventsResponse,
  SessionTailMessage,
  SessionTailResponse,
  ServeRegistryEntry,
} from "./types";
import type { EventScope } from "./observability";
import {
  DEFAULT_OBS_TIMEOUT_MS,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_TAIL_LIMIT,
  asNumber,
  asString,
  getRuntimeConfig,
  normalizeRegistry,
  findRegistryEntry,
  buildEnvelope,
  resolveExecutionAgent,
  buildHookPolicyChecklist,
  evaluateLifecycle,
  resolveServerUrl,
  readRunStatus,
  fetchJsonSafe,
  resolveSessionForRun,
  collectSseEvents,
  spawnServeForProject,
  readServeRegistry,
  getServeRegistryPath,
  upsertServeRegistry,
  normalizeServeRegistry,
  writeServeRegistryFile,
  shutdownServe,
  evaluateServeIdle,
  getBridgeConfigPath,
  getBridgeStateDir,
  getRunStateDir,
  getAuditDir,
} from "./runtime";

export function registerOpenCodeBridgeTools(api: any, cfg: any) {
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
        content: [{ type: "text", text: JSON.stringify({ ok: true, pluginId: "opencode-bridge", version: "0.1.0", assumption: "1 project = 1 opencode serve instance", sessionKeyConvention: "hook:opencode:<agentId>:<taskId>", lifecycleStates: ["queued", "server_ready", "session_created", "prompt_sent", "running", "awaiting_permission", "stalled", "failed", "completed"], requiredEnvelopeFields: ["task_id", "run_id", "agent_id", "requested_agent_id", "resolved_agent_id", "session_key", "origin_session_key", "callback_target_session_key", "project_id", "repo_root", "opencode_server_url"], callbackPrimary: "/hooks/agent", callbackNotPrimary: ["/hooks/wake", "cron", "group:sessions"], config: { bridgeConfigPath: getBridgeConfigPath(), opencodeServerUrl: runtimeCfg.opencodeServerUrl || null, hookBaseUrl: runtimeCfg.hookBaseUrl || null, hookTokenPresent: Boolean(runtimeCfg.hookToken), projectRegistry: registry, executionAgentMappings: runtimeCfg.executionAgentMappings || [], stateDir: getBridgeStateDir(), runStateDir: getRunStateDir(), auditDir: getAuditDir() }, note: "Runtime-ops scaffold in progress. Plugin-owned config/state is stored under ~/.openclaw/opencode-bridge. New projects are auto-registered only when using opencode_serve_spawn (not by passive envelope build alone)." }, null, 2) }]
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
    parameters: { type: "object", properties: { taskId: { type: "string" }, runId: { type: "string" }, agentId: { type: "string", description: "Requester/origin agent id" }, executionAgentId: { type: "string", description: "Optional explicit OpenCode execution agent id" }, originSessionKey: { type: "string" }, originSessionId: { type: "string" }, projectId: { type: "string" }, repoRoot: { type: "string" }, channel: { type: "string" }, to: { type: "string" }, deliver: { type: "boolean" }, priority: { type: "string" } }, required: ["taskId", "runId", "agentId", "originSessionKey", "projectId", "repoRoot"] },
    async execute(_id: string, params: any) {
      const entry = findRegistryEntry(cfg, params?.projectId, params?.repoRoot);
      const serverUrl = entry?.serverUrl;
      if (!serverUrl) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing project registry mapping. Use opencode_serve_spawn for the project or add a matching projectRegistry entry in ~/.openclaw/opencode-bridge/config.json first." }, null, 2) }]
        };
      }
      const requestedAgentId = asString(params?.agentId);
      const resolved = resolveExecutionAgent({
        cfg,
        requestedAgentId: requestedAgentId || "",
        explicitExecutionAgentId: asString(params?.executionAgentId),
      });
      if (!resolved.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: resolved.error, requestedAgentId: resolved.requestedAgentId, mappingConfigured: resolved.mappingConfigured }, null, 2) }],
        };
      }

      const envelope = buildEnvelope({
        taskId: params.taskId,
        runId: params.runId,
        requestedAgentId: resolved.requestedAgentId,
        resolvedAgentId: resolved.resolvedAgentId,
        originSessionKey: params.originSessionKey,
        originSessionId: asString(params.originSessionId),
        projectId: params.projectId,
        repoRoot: params.repoRoot,
        serverUrl,
        channel: params.channel,
        to: params.to,
        deliver: params.deliver,
        priority: params.priority,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, envelope, agentResolution: resolved, registryMatch: entry || null }, null, 2) }]
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
          .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
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
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Project entry not found" }, null, 2) }] };
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
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Project entry not found" }, null, 2) }] };
      }
      const evaluation = evaluateServeIdle(entry, asNumber(params.nowMs));
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, entry, evaluation }, null, 2) }] };
    }
  }, { optional: true });
}
