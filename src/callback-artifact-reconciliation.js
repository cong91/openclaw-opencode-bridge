export function mapCallbackEventToArtifactState(eventType) {
  if (!eventType) return null;
  switch (eventType) {
    case "task.started":
      return { state: "planning", lastEvent: "task.started", terminal: false };
    case "task.progress":
      return { state: "running", lastEvent: "task.progress", terminal: false };
    case "permission.requested":
      return {
        state: "awaiting_permission",
        lastEvent: "permission.requested",
        terminal: false,
      };
    case "task.stalled":
      return { state: "stalled", lastEvent: "task.stalled", terminal: true };
    case "task.failed":
    case "session.error":
      return { state: "failed", lastEvent: "task.failed", terminal: true };
    case "task.completed":
    case "session.idle":
    case "message.updated":
      return { state: "completed", lastEvent: "task.completed", terminal: true };
    default:
      return null;
  }
}

export function isTerminalArtifactState(state) {
  return state === "completed" || state === "failed" || state === "stalled";
}

export function reconcileRunArtifactSnapshotFromCallback(options) {
  const {
    current,
    eventType,
    callbackAt = new Date().toISOString(),
    callbackOk = true,
    callbackStatus = 200,
    callbackBody,
    callbackError,
    includeStateConfidence = false,
    includeRealState = false,
    killProcess = process.kill.bind(process),
  } = options || {};

  if (!current || typeof current !== "object" || !eventType) return null;

  const callbackPersistence = mapCallbackEventToArtifactState(eventType);
  const summary = callbackPersistence
    ? (callbackPersistence.terminal
        ? `Terminal callback materialized (${eventType})`
        : `Callback materialized (${eventType})`)
    : `Callback materialized (${eventType})`;
  const preserveTerminal =
    isTerminalArtifactState(current.state) && (!callbackPersistence || !callbackPersistence.terminal);

  const next = {
    ...current,
    ...(callbackPersistence && !preserveTerminal
      ? {
          state: callbackPersistence.state,
          lastEvent: callbackPersistence.lastEvent,
          ...(includeRealState ? { realState: callbackPersistence.state } : {}),
          ...(includeStateConfidence ? { stateConfidence: "artifact_plus_callback" } : {}),
        }
      : {}),
    lastSummary: preserveTerminal ? (current.lastSummary || summary) : summary,
    callbackSentAt: callbackAt,
    callbackStatus,
    callbackOk,
    ...(callbackBody !== undefined ? { callbackBody } : {}),
    callbackError,
    updatedAt: callbackAt,
  };

  if (callbackPersistence?.terminal && next.attachRun && typeof next.attachRun.pid === "number") {
    let killResult = "not_attempted";
    try {
      killProcess(next.attachRun.pid, "SIGTERM");
      killResult = "sigterm_sent";
    } catch (error) {
      killResult = error instanceof Error ? error.message : String(error);
    }
    next.callbackCleaned = killResult === "sigterm_sent";
    next.attachRun = {
      ...next.attachRun,
      cleaned: killResult === "sigterm_sent",
      cleanedAt: callbackAt,
      killSignal: "SIGTERM",
      killResult,
    };
  }

  return next;
}
