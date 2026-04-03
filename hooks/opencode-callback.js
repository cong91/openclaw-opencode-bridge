import fs from "node:fs";
import path from "node:path";
import {
  reconcileRunArtifactSnapshotFromCallback,
} from "../src/callback-artifact-reconciliation.js";

function asTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildOpencodeSessionKey(payload) {
  const requestedAgentId = typeof payload.requestedAgentId === "string"
    ? payload.requestedAgentId
    : (typeof payload.requested_agent_id === "string" ? payload.requested_agent_id : "scrum");
  const callbackTargetSessionId = typeof payload.callbackTargetSessionId === "string"
    ? payload.callbackTargetSessionId
    : (typeof payload.callback_target_session_id === "string" ? payload.callback_target_session_id : undefined);
  const runId = typeof payload.runId === "string"
    ? payload.runId
    : (typeof payload.run_id === "string" ? payload.run_id : "unknown-run");

  if (callbackTargetSessionId) return `opencode:${requestedAgentId}:callback:${callbackTargetSessionId}`;
  return `opencode:${requestedAgentId}:callback:${runId}`;
}

function getBridgeStateDir() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
  return path.join(stateDir, "opencode-bridge");
}

function getRunStatePath(runId) {
  return path.join(getBridgeStateDir(), "runs", `${runId}.json`);
}

function readRunStatus(runId) {
  try {
    const runPath = getRunStatePath(runId);
    if (!fs.existsSync(runPath)) return null;
    return JSON.parse(fs.readFileSync(runPath, "utf8"));
  } catch {
    return null;
  }
}

function writeRunStatus(runId, status) {
  const runPath = getRunStatePath(runId);
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(runPath, JSON.stringify(status, null, 2), "utf8");
}

function reconcileRunArtifactFromHook(payload) {
  const runId = asTrimmedString(payload.runId) || asTrimmedString(payload.run_id);
  const eventType = asTrimmedString(payload.eventType) || asTrimmedString(payload.event_type);
  if (!runId || !eventType) return null;

  const current = readRunStatus(runId);
  if (!current || typeof current !== "object") return null;

  const next = reconcileRunArtifactSnapshotFromCallback({
    current,
    eventType,
    callbackAt: new Date().toISOString(),
    callbackOk: true,
    callbackStatus: 200,
    callbackBody: JSON.stringify({
      ok: true,
      via: "hook_ingress",
      eventType,
      runId,
    }),
    callbackError: undefined,
    includeRealState: true,
    includeStateConfidence: true,
    killProcess: (pid, signal) => process.kill(pid, signal),
  });

  if (!next) return null;
  writeRunStatus(runId, next);
  return next;
}

function buildInternalControlNote() {
  return [
    "OpenCode hook continuation control.",
    "Internal notify/control note:",
    "Any operator-facing update must be emitted by registrar authority only.",
  ].join("\n");
}

function buildOperatorUpdate(payload, routedSessionKey) {
  const intent = payload && typeof payload.intent === "object" ? payload.intent : {};
  const intentKind = asTrimmedString(intent.kind) || "blocked";
  const eventType = asTrimmedString(payload.eventType) || asTrimmedString(payload.event_type) || "unknown-event";
  const runId = asTrimmedString(payload.runId) || asTrimmedString(payload.run_id) || "unknown-run";
  const taskId = asTrimmedString(payload.taskId) || asTrimmedString(payload.task_id) || "unknown-task";
  const requestedAgentId = asTrimmedString(payload.requestedAgentId) || asTrimmedString(payload.requested_agent_id) || "scrum";
  const projectId = asTrimmedString(payload.projectId) || asTrimmedString(payload.project_id) || "unknown-project";
  const repoRoot = asTrimmedString(payload.repoRoot) || asTrimmedString(payload.repo_root) || "unknown-repo";
  const nextTaskId = asTrimmedString(intent.taskId);
  const objective = asTrimmedString(intent.objective);
  const notify = asTrimmedString(intent.notify);
  const status = intentKind === "launch_run"
    ? (eventType === "session.error" || eventType === "task.failed" ? "step failed; corrective relaunch requested" : "next step launched")
    : intentKind === "notify"
      ? "internal continuation update"
      : intentKind === "done"
        ? "loop completed"
        : "blocked / manual triage";
  const actionTaken = intentKind === "launch_run"
    ? (eventType === "session.error" || eventType === "task.failed" ? "launching corrective continuation run" : "launching verification / next task")
    : intentKind === "notify"
      ? "keeping continuation aligned"
      : intentKind === "done"
        ? "closing loop"
        : "waiting manual intervention";
  const nextStep = nextTaskId || objective || notify || "none";
  const needFromOperator = intentKind === "blocked" ? "manual review required" : "none";

  return [
    "OpenCode Loop Update",
    `- Agent: ${requestedAgentId}`,
    `- Task: ${taskId}`,
    `- Run: ${runId}`,
    `- Event: ${eventType}`,
    `- Project: ${projectId}`,
    `- Repo: ${repoRoot}`,
    `- Status: ${status}`,
    `- Action taken: ${actionTaken}`,
    `- Next step: ${nextStep}`,
    `- Need from operator: ${needFromOperator}`,
    `- Continuation session: ${routedSessionKey}`,
  ].join("\n");
}

function buildContinuationInstruction(payload, routedSessionKey) {
  const intent = payload && typeof payload.intent === "object" ? payload.intent : {};
  const intentKind = asTrimmedString(intent.kind) || "blocked";
  const intentTaskId = asTrimmedString(intent.taskId);
  const intentObjective = asTrimmedString(intent.objective);
  const intentPrompt = asTrimmedString(intent.prompt);
  const notify = asTrimmedString(intent.notify);
  const reason = asTrimmedString(intent.reason);
  const eventType = asTrimmedString(payload.eventType) || asTrimmedString(payload.event_type) || "unknown-event";
  const runId = asTrimmedString(payload.runId) || asTrimmedString(payload.run_id) || "unknown-run";
  const taskId = asTrimmedString(payload.taskId) || asTrimmedString(payload.task_id) || "unknown-task";
  const requestedAgentId = asTrimmedString(payload.requestedAgentId) || asTrimmedString(payload.requested_agent_id) || "scrum";
  const callbackTargetSessionKey = asTrimmedString(payload.callbackTargetSessionKey) || asTrimmedString(payload.callback_target_session_key);
  const callbackTargetSessionId = asTrimmedString(payload.callbackTargetSessionId) || asTrimmedString(payload.callback_target_session_id);
  const repoRoot = asTrimmedString(payload.repoRoot) || asTrimmedString(payload.repo_root);
  const projectId = asTrimmedString(payload.projectId) || asTrimmedString(payload.project_id);
  const workflowId = asTrimmedString(payload.workflowId) || asTrimmedString(payload.workflow_id);
  const stepId = asTrimmedString(payload.stepId) || asTrimmedString(payload.step_id);

  const lines = [
    buildOperatorUpdate(payload, routedSessionKey),
    "",
    buildInternalControlNote(),
    `Run ID: ${runId}`,
    `Task ID: ${taskId}`,
    `Event: ${eventType}`,
    `Requested agent: ${requestedAgentId}`,
    `Continuation intent: ${intentKind}`,
    intentTaskId ? `Intent task ID: ${intentTaskId}` : undefined,
    workflowId ? `Workflow ID: ${workflowId}` : undefined,
    stepId ? `Step ID: ${stepId}` : undefined,
    reason ? `Reason: ${reason}` : undefined,
    callbackTargetSessionKey ? `Original callback target session: ${callbackTargetSessionKey}` : undefined,
    callbackTargetSessionId ? `Original callback target session id: ${callbackTargetSessionId}` : undefined,
    `Opencode continuation session: ${routedSessionKey}`,
    projectId ? `Project: ${projectId}` : undefined,
    repoRoot ? `Repo root: ${repoRoot}` : undefined,
    intentObjective ? `Objective: ${intentObjective}` : undefined,
    intentPrompt ? `Prompt: ${intentPrompt}` : undefined,
    notify ? `Notify: ${notify}` : undefined,
  ].filter(Boolean);

  if (intentKind === "launch_run") {
    lines.push(
      "Action required: launch or relaunch the next OpenCode step now.",
      "If the previous step failed, first explain the likely reason briefly, then continue with the corrective next step.",
      "If the previous step passed, continue with verification or the next planned task.",
      "Do not wait for heartbeat. Treat this callback as actionable loop work now."
    );
  } else if (intentKind === "notify") {
    lines.push(
      "Action required: continue internal workflow handling now.",
      "Do not synthesize a direct operator-facing update from this hook payload."
    );
  } else if (intentKind === "done") {
    lines.push(
      "Action required: confirm the loop reached a terminal done state and produce a concise completion summary."
    );
  } else {
    lines.push(
      "Action required: conclude with a concise blocker report and explicit next recommendation."
    );
  }

  lines.push(
    "When finishing this isolated turn, end with a final operator report in exactly this format:",
    "OpenCode Loop Result",
    "- Agent: <agent>",
    "- Task: <task>",
    "- Run: <run>",
    "- Event: <event>",
    "- Project: <project>",
    "- Repo: <repo>",
    "- Result: <pass/fail/blocked>",
    "- Action taken: <what you just did>",
    "- Next step: <next step>",
    "- Need from operator: <none/review/approval>",
    "Do not repeat the immediate Telegram alert verbatim. The final report must add new execution outcome detail."
  );

  return lines.join("\n");
}

async function transform(ctx) {
  const payload = ctx?.payload ?? {};
  const normalizedPayload = payload && typeof payload === "object" ? payload : {};
  reconcileRunArtifactFromHook(normalizedPayload);

  const requestedAgentId = asTrimmedString(normalizedPayload.requestedAgentId) || asTrimmedString(normalizedPayload.requested_agent_id) || "scrum";
  const routedSessionKey = buildOpencodeSessionKey(normalizedPayload);
  const message = buildContinuationInstruction(normalizedPayload, routedSessionKey);

  return {
    kind: "agent",
    agentId: requestedAgentId,
    sessionKey: routedSessionKey,
    message,
    name: "OpenCodeCallbackLoop",
    wakeMode: "now",
    deliver: false,
    allowUnsafeExternalContent: false,
  };
}

export default transform;
export {
  buildContinuationInstruction,
  reconcileRunArtifactFromHook,
  buildInternalControlNote,
  buildOpencodeSessionKey,
};
