// opencode-plugin/openclaw-bridge-callback.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// src/shared-contracts.ts
var OPENCODE_CONTINUATION_HOOK_PATH = "/hooks/opencode-callback";
function sanitizeCallbackAnchor(anchor) {
  return encodeURIComponent(anchor.trim());
}
function buildCanonicalCallbackSessionKey(input) {
  return `agent:${input.agentId}:opencode:${input.agentId}:callback:${sanitizeCallbackAnchor(input.anchor)}`;
}
function parseTaggedSessionTitle(title) {
  if (!title || !title.trim()) return null;
  const tags = {};
  for (const token of title.split(/\s+/)) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const raw = token.slice(idx + 1).trim();
    if (!key || !raw) continue;
    tags[key] = raw;
  }
  return Object.keys(tags).length > 0 ? tags : null;
}
function buildPluginCallbackDedupeKey(input) {
  return `${input.sessionId || "no-session"}|${input.runId || "no-run"}`;
}

// opencode-plugin/openclaw-bridge-callback.ts
var LOOP_UPDATE_INTERVAL_MS = 12e4;
var PERIODIC_UPDATE_EVENT_TYPES = /* @__PURE__ */ new Set([
  "task.started",
  "task.progress",
  "permission.requested",
  "task.stalled"
]);
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function ensureAuditDir(directory) {
  mkdirSync(directory, { recursive: true });
  return directory;
}
function getAuditPath(directory) {
  const resolved = getResolvedPluginConfig(directory);
  const auditDir = resolved.auditDir || join(directory, ".opencode");
  ensureAuditDir(auditDir);
  return join(auditDir, "bridge-callback-audit.jsonl");
}
function appendAudit(directory, record) {
  const path = getAuditPath(directory);
  appendFileSync(
    path,
    JSON.stringify({ ...record, created_at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n",
    "utf8"
  );
}
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadPersistedPluginConfig(directory) {
  const home = asString(process.env.HOME);
  const candidates = [
    join(directory, ".opencode", "plugins", "openclaw-bridge", "config.json"),
    join(directory, ".opencode", "openclaw-bridge-callback.json"),
    join(
      directory,
      ".opencode",
      "plugins",
      "openclaw-bridge-callback.config.json"
    ),
    ...home ? [
      join(
        home,
        ".config",
        "opencode",
        "plugins",
        "openclaw-bridge",
        "config.json"
      ),
      join(home, ".config", "opencode", "openclaw-bridge-callback.json"),
      join(
        home,
        ".config",
        "opencode",
        "plugins",
        "openclaw-bridge-callback.config.json"
      )
    ] : []
  ];
  for (const path of candidates) {
    const data = readJsonFile(path);
    if (!data) continue;
    return {
      hookBaseUrl: asString(data.hookBaseUrl),
      hookToken: asString(data.hookToken),
      auditDir: asString(data.auditDir),
      openclawAuditPath: asString(data.openclawAuditPath)
    };
  }
  return {};
}
function getResolvedPluginConfig(directory) {
  const persisted = loadPersistedPluginConfig(directory);
  return {
    hookBaseUrl: asString(process.env.OPENCLAW_HOOK_BASE_URL) || persisted.hookBaseUrl,
    hookToken: asString(process.env.OPENCLAW_HOOK_TOKEN) || persisted.hookToken,
    auditDir: asString(process.env.OPENCLAW_BRIDGE_AUDIT_DIR) || persisted.auditDir,
    openclawAuditPath: asString(process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH) || persisted.openclawAuditPath
  };
}
function getOpenClawAuditPath(directory) {
  const resolved = getResolvedPluginConfig(directory);
  const explicit = resolved.openclawAuditPath;
  if (explicit) {
    ensureAuditDir(join(explicit, ".."));
    return explicit;
  }
  const home = asString(process.env.HOME);
  if (!home) return null;
  const auditDir = join(home, ".openclaw", "opencode-bridge", "audit");
  ensureAuditDir(auditDir);
  return join(auditDir, "callbacks.jsonl");
}
function appendOpenClawAudit(directory, record) {
  const path = getOpenClawAuditPath(directory);
  if (!path) return;
  appendFileSync(
    path,
    JSON.stringify({ ...record, createdAt: (/* @__PURE__ */ new Date()).toISOString() }) + "\n",
    "utf8"
  );
}
function buildHookContinuationPayload(tags, eventType, opencodeSessionId) {
  const requestedAgentIdFromTags = tags.requested || tags.requested_agent_id;
  const agentId = requestedAgentIdFromTags;
  const callbackAnchor = tags.callbackSessionId || tags.callback_target_session_id || tags.originSessionId || tags.origin_session_id || opencodeSessionId || tags.runId || tags.run_id || tags.taskId || tags.task_id;
  if (!requestedAgentIdFromTags || !callbackAnchor) return null;
  const sessionKey = buildCanonicalCallbackSessionKey({
    agentId: requestedAgentIdFromTags,
    anchor: callbackAnchor
  });
  const sessionId = tags.callbackSessionId || tags.callback_target_session_id || tags.originSessionId || tags.origin_session_id;
  const relaySessionKey = tags.callbackRelaySession || tags.callback_relay_session_key || tags.originSession || tags.origin_session_key;
  const relaySessionId = tags.callbackRelaySessionId || tags.callback_relay_session_id || tags.originSessionId || tags.origin_session_id;
  const deliver = (tags.callbackDeliver || tags.callback_deliver) === "true";
  if (!agentId) return null;
  const metadata = buildContinuationMetadata(
    tags,
    eventType,
    opencodeSessionId
  );
  const isFailureEvent = eventType === "session.error" || eventType === "task.failed";
  const isPeriodicUpdate = PERIODIC_UPDATE_EVENT_TYPES.has(eventType) && !isFailureEvent;
  const requestedAgentId = metadata.requestedAgentId || agentId;
  const resolvedAgentId = metadata.resolvedAgentId || metadata.requestedAgentId || agentId;
  const callbackTargetSessionKey = metadata.callbackTargetSessionKey || sessionKey;
  const callbackTargetSessionId = metadata.callbackTargetSessionId || sessionId;
  const callbackRelaySessionKey = metadata.callbackRelaySessionKey || relaySessionKey;
  const callbackRelaySessionId = metadata.callbackRelaySessionId || relaySessionId;
  const callbackMetadata = {
    ...metadata,
    requestedAgentId,
    resolvedAgentId,
    callbackTargetSessionKey,
    callbackTargetSessionId,
    callbackRelaySessionKey,
    callbackRelaySessionId
  };
  return {
    source: "opencode.callback",
    name: "OpenCode",
    agentId,
    sessionKey: callbackTargetSessionKey,
    sessionId: callbackTargetSessionId,
    wakeMode: "now",
    message: JSON.stringify(callbackMetadata),
    runId: metadata.runId,
    taskId: metadata.taskId,
    eventType: metadata.eventType,
    projectId: metadata.projectId,
    repoRoot: metadata.repoRoot,
    requestedAgentId,
    resolvedAgentId,
    callbackTargetSessionKey,
    callbackTargetSessionId,
    callbackRelaySessionKey,
    callbackRelaySessionId,
    opencodeSessionId: metadata.opencodeSessionId,
    workflowId: metadata.workflowId,
    stepId: metadata.stepId,
    next: isPeriodicUpdate ? { action: "none", taskId: metadata.taskId } : { action: "launch_run", taskId: metadata.taskId },
    intent: {
      kind: isFailureEvent ? "launch_run" : "notify",
      taskId: metadata.taskId,
      objective: isFailureEvent ? "Internal continuation control: analyze failure and continue corrective step." : isPeriodicUpdate ? "Internal continuation checkpoint: OpenCode step still running; continue monitoring." : "Internal continuation control: OpenCode step completed; continue workflow handling.",
      prompt: isFailureEvent ? "The previous step failed. Inspect the failure, summarize the likely reason, then continue with the corrective next step." : isPeriodicUpdate ? "OpenCode reports in-progress activity. Continue waiting for terminal callback while maintaining internal state." : "The previous step completed. Continue with verification or next task as internal continuation control.",
      notify: `internal_callback:${metadata.eventType || "unknown-event"}:${metadata.runId || "unknown-run"}`,
      reason: metadata.eventType
    },
    deliver
  };
}
function buildContinuationMetadata(tags, eventType, opencodeSessionId) {
  const requestedAgentId = tags.requested || tags.requested_agent_id;
  const resolvedAgentId = tags.resolved || tags.resolved_agent_id || requestedAgentId;
  const callbackAnchor = tags.callbackSessionId || tags.callback_target_session_id || tags.originSessionId || tags.origin_session_id || opencodeSessionId || tags.runId || tags.run_id || tags.taskId || tags.task_id;
  const callbackTargetSessionKey = requestedAgentId && callbackAnchor ? buildCanonicalCallbackSessionKey({
    agentId: requestedAgentId,
    anchor: callbackAnchor
  }) : void 0;
  return {
    kind: "opencode.callback",
    eventType,
    runId: tags.runId || tags.run_id,
    taskId: tags.taskId || tags.task_id,
    projectId: tags.projectId || tags.project_id,
    repoRoot: tags.repoRoot || tags.repo_root,
    requestedAgentId,
    resolvedAgentId,
    originSessionKey: tags.originSession || tags.origin_session_key,
    originSessionId: tags.originSessionId || tags.origin_session_id,
    callbackTargetSessionKey,
    callbackTargetSessionId: tags.callbackSessionId || tags.callback_target_session_id,
    callbackRelaySessionKey: tags.callbackRelaySession || tags.callback_relay_session_key || tags.originSession || tags.origin_session_key,
    callbackRelaySessionId: tags.callbackRelaySessionId || tags.callback_relay_session_id || tags.originSessionId || tags.origin_session_id,
    opencodeSessionId: opencodeSessionId || tags.opencodeSessionId || tags.opencode_session_id,
    workflowId: tags.workflowId || tags.workflow_id,
    stepId: tags.stepId || tags.step_id
  };
}
async function postCallback(directory, payload, meta) {
  const resolved = getResolvedPluginConfig(directory);
  const hookBaseUrl = resolved.hookBaseUrl;
  const hookToken = resolved.hookToken;
  const diagnostics = {
    pid: process.pid,
    hasHookBaseUrl: Boolean(hookBaseUrl),
    hasHookToken: Boolean(hookToken),
    hookBaseUrlPreview: hookBaseUrl || null,
    configSourceHint: {
      persistedConfigPresent: Boolean(
        loadPersistedPluginConfig(directory).hookBaseUrl || loadPersistedPluginConfig(directory).hookToken
      ),
      envHookBaseUrl: Boolean(asString(process.env.OPENCLAW_HOOK_BASE_URL)),
      envHookToken: Boolean(asString(process.env.OPENCLAW_HOOK_TOKEN))
    }
  };
  if (!hookBaseUrl || !hookToken) {
    appendAudit(directory, {
      ok: false,
      status: 0,
      reason: "missing_hook_env",
      diagnostics,
      payload,
      meta
    });
    appendOpenClawAudit(directory, {
      taskId: meta?.taskId,
      runId: meta?.runId,
      agentId: payload?.agentId,
      requestedAgentId: meta?.requestedAgentId,
      resolvedAgentId: meta?.resolvedAgentId,
      sessionKey: void 0,
      callbackTargetSessionKey: meta?.callbackTargetSessionKey,
      callbackTargetSessionId: meta?.callbackTargetSessionId,
      projectId: meta?.projectId,
      repoRoot: meta?.repoRoot,
      opencodeSessionId: meta?.sessionId,
      workflowId: meta?.workflowId,
      stepId: meta?.stepId,
      event: meta?.eventType,
      callbackStatus: 0,
      callbackOk: false,
      callbackBody: "missing_hook_env"
    });
    return { ok: false, status: 0, reason: "missing_hook_env" };
  }
  const callbackUrl = `${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CONTINUATION_HOOK_PATH}`;
  appendAudit(directory, {
    phase: "callback_attempt",
    diagnostics: {
      ...diagnostics,
      callbackUrl
    },
    payload,
    meta
  });
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hookToken}`,
      "x-openclaw-token": hookToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  appendAudit(directory, {
    ok: response.ok,
    status: response.status,
    body: text,
    diagnostics: {
      ...diagnostics,
      callbackUrl
    },
    payload,
    meta
  });
  const openClawAuditRecord = {
    taskId: meta?.taskId,
    runId: meta?.runId,
    agentId: payload?.agentId,
    requestedAgentId: meta?.requestedAgentId,
    resolvedAgentId: meta?.resolvedAgentId,
    sessionKey: void 0,
    callbackTargetSessionKey: meta?.callbackTargetSessionKey,
    callbackTargetSessionId: meta?.callbackTargetSessionId,
    projectId: meta?.projectId,
    repoRoot: meta?.repoRoot,
    opencodeSessionId: meta?.sessionId,
    workflowId: meta?.workflowId,
    stepId: meta?.stepId,
    event: meta?.eventType,
    callbackStatus: response.status,
    callbackOk: response.ok,
    callbackBody: text
  };
  appendAudit(directory, {
    phase: "openclaw_audit_mirror",
    record: openClawAuditRecord
  });
  appendOpenClawAudit(directory, openClawAuditRecord);
  return { ok: response.ok, status: response.status, body: text };
}
var callbackDedupe = /* @__PURE__ */ new Set();
var sessionTagCache = /* @__PURE__ */ new Map();
var runCheckpointAt = /* @__PURE__ */ new Map();
function readSessionId(event) {
  return asString(event?.session?.id) || asString(event?.session?.sessionID) || asString(event?.data?.session?.id) || asString(event?.data?.sessionID) || asString(event?.properties?.sessionID) || asString(event?.properties?.info?.sessionID) || asString(event?.properties?.info?.id) || asString(event?.payload?.sessionID);
}
function readMessageFinish(event) {
  return asString(event?.properties?.info?.finish) || asString(event?.data?.info?.finish) || asString(event?.payload?.info?.finish);
}
function isTerminalEvent(event, type) {
  if (type === "session.idle" || type === "session.error") return true;
  const finish = readMessageFinish(event);
  if (type === "message.updated" && finish === "stop") return true;
  return false;
}
function shouldEmitPeriodicLoopUpdate(type, tags) {
  if (!PERIODIC_UPDATE_EVENT_TYPES.has(type)) return false;
  const runId = asString(tags.runId || tags.run_id);
  if (!runId) return false;
  const now = Date.now();
  const previous = runCheckpointAt.get(runId) || 0;
  if (previous > 0 && now - previous < LOOP_UPDATE_INTERVAL_MS) {
    return false;
  }
  runCheckpointAt.set(runId, now);
  return true;
}
var OpenClawBridgeCallbackPlugin = async ({
  client,
  directory
}) => {
  await client.app.log({
    body: {
      service: "openclaw-bridge-callback",
      level: "info",
      message: "OpenClaw bridge callback plugin initialized",
      extra: { directory }
    }
  });
  return {
    event: async ({ event }) => {
      const type = asString(event?.type) || "unknown";
      const sessionId = readSessionId(event);
      const title = asString(event?.session?.title) || asString(event?.data?.session?.title) || asString(event?.data?.title) || asString(event?.properties?.info?.title) || asString(event?.properties?.title) || asString(event?.payload?.session?.title) || asString(event?.payload?.title);
      const parsedTags = parseTaggedSessionTitle(title);
      if (sessionId && parsedTags && (parsedTags.callbackSession || parsedTags.callback_target_session_key)) {
        sessionTagCache.set(sessionId, parsedTags);
      }
      const tags = parsedTags || (sessionId ? sessionTagCache.get(sessionId) || null : null);
      const resolvedConfig = getResolvedPluginConfig(directory);
      appendAudit(directory, {
        phase: "event_seen",
        event_type: type,
        session_id: sessionId,
        title,
        tags,
        diagnostics: {
          pid: process.pid,
          hasHookBaseUrl: Boolean(resolvedConfig.hookBaseUrl),
          hasHookToken: Boolean(resolvedConfig.hookToken),
          hookBaseUrlPreview: resolvedConfig.hookBaseUrl || null
        },
        raw: event
      });
      if (!tags || !(tags.callbackSession || tags.callback_target_session_key))
        return;
      const terminal = isTerminalEvent(event, type);
      const periodicUpdate = terminal ? false : shouldEmitPeriodicLoopUpdate(type, tags);
      if (!terminal && !periodicUpdate) return;
      const dedupeKey = buildPluginCallbackDedupeKey({
        sessionId,
        runId: tags.runId || tags.run_id
      });
      const terminalDedupeKey = `${dedupeKey}|${type}`;
      if (terminal && callbackDedupe.has(terminalDedupeKey)) {
        appendAudit(directory, {
          phase: "deduped",
          event_type: type,
          session_id: sessionId,
          dedupeKey: terminalDedupeKey,
          tags
        });
        return;
      }
      if (terminal) {
        callbackDedupe.add(terminalDedupeKey);
        runCheckpointAt.delete(asString(tags.runId || tags.run_id) || "");
      }
      const payload = buildHookContinuationPayload(tags, type, sessionId);
      if (!payload) {
        appendAudit(directory, {
          phase: "skipped_no_payload",
          event_type: type,
          session_id: sessionId,
          tags
        });
        return;
      }
      await postCallback(directory, payload, {
        eventType: type,
        sessionId,
        runId: tags.runId || tags.run_id,
        taskId: tags.taskId || tags.task_id,
        requestedAgentId: tags.requested || tags.requested_agent_id,
        resolvedAgentId: tags.resolved || tags.resolved_agent_id,
        callbackTargetSessionKey: tags.callbackSession || tags.callback_target_session_key,
        callbackTargetSessionId: tags.callbackSessionId || tags.callback_target_session_id,
        callbackRelaySessionKey: tags.callbackRelaySession || tags.callback_relay_session_key || tags.originSession || tags.origin_session_key,
        callbackRelaySessionId: tags.callbackRelaySessionId || tags.callback_relay_session_id || tags.originSessionId || tags.origin_session_id,
        projectId: tags.projectId || tags.project_id,
        repoRoot: tags.repoRoot || tags.repo_root,
        workflowId: tags.workflowId || tags.workflow_id,
        stepId: tags.stepId || tags.step_id
      });
    }
  };
};
var openclaw_bridge_callback_default = OpenClawBridgeCallbackPlugin;
export {
  OpenClawBridgeCallbackPlugin,
  openclaw_bridge_callback_default as default
};
