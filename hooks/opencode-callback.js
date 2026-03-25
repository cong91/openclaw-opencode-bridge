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

function asTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    "OpenCode hook continuation loop.",
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
      "Action required: prepare a concise operator-facing notification/update now.",
      "Summarize completion or blocker clearly."
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

  return lines.join("\n");
}

module.exports = async function transform(ctx) {
  const payload = ctx?.payload ?? {};
  const requestedAgentId = asTrimmedString(payload.requestedAgentId) || asTrimmedString(payload.requested_agent_id) || "scrum";
  const routedSessionKey = buildOpencodeSessionKey(payload);
  const message = buildContinuationInstruction(payload, routedSessionKey);
  const intent = payload && typeof payload.intent === "object" ? payload.intent : {};
  const deliver = (asTrimmedString(intent.kind) || "") === "notify";
  return {
    kind: "agent",
    agentId: requestedAgentId,
    sessionKey: routedSessionKey,
    message,
    name: "OpenCodeCallbackLoop",
    wakeMode: "now",
    deliver,
    allowUnsafeExternalContent: false,
    ...(deliver ? { channel: "telegram", to: "5165741309" } : {})
  };
};
