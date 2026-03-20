// src/observability.ts
function parseSseFramesFromBuffer(input) {
  const normalized = input.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const frames = [];
  for (const rawFrame of parts) {
    const lines = rawFrame.split("\n");
    let event;
    let id;
    let retry;
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx >= 0 ? line.slice(0, idx).trim() : line.trim();
      const value = idx >= 0 ? line.slice(idx + 1).replace(/^\s/, "") : "";
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "retry") {
        const n = Number(value);
        if (Number.isFinite(n)) retry = n;
      } else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length <= 0) continue;
    frames.push({
      event,
      id,
      retry,
      data: dataLines.join("\n"),
      raw: rawFrame
    });
  }
  return { frames, remainder };
}
function parseSseData(data) {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}
function unwrapGlobalPayload(raw) {
  let current = raw;
  const wrappers = [];
  for (let i = 0; i < 3; i += 1) {
    if (!current || typeof current !== "object") break;
    if ("payload" in current && current.payload !== void 0) {
      wrappers.push("payload");
      current = current.payload;
      continue;
    }
    if ("data" in current && current.data !== void 0 && Object.keys(current).length <= 4) {
      wrappers.push("data");
      current = current.data;
      continue;
    }
    break;
  }
  return { payload: current, wrappers };
}
function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== "object") return void 0;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return void 0;
}
function normalizeOpenCodeEvent(raw) {
  const text = JSON.stringify(raw || {}).toLowerCase();
  if (text.includes("permission") || text.includes("question.asked")) {
    return { kind: "permission.requested", summary: "OpenCode \u0111ang ch\u1EDD permission/user input", raw };
  }
  if (text.includes("error") || text.includes("failed")) {
    return { kind: "task.failed", summary: "OpenCode task failed", raw };
  }
  if (text.includes("stalled")) {
    return { kind: "task.stalled", summary: "OpenCode task stalled", raw };
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
function normalizeTypedEventV1(frame, scope) {
  const parsed = parseSseData(frame.data);
  const unwrapped = unwrapGlobalPayload(parsed);
  const normalized = normalizeOpenCodeEvent(unwrapped.payload);
  return {
    schema: "opencode.event.v1",
    scope,
    eventName: frame.event,
    eventId: frame.id,
    kind: normalized.kind,
    summary: normalized.summary,
    runId: pickFirstString(unwrapped.payload, ["run_id", "runId"]),
    taskId: pickFirstString(unwrapped.payload, ["task_id", "taskId"]),
    sessionId: pickFirstString(unwrapped.payload, ["session_id", "sessionId", "session"]),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    wrappers: unwrapped.wrappers,
    payload: unwrapped.payload
  };
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function scoreSessionCandidate(candidate, ctx) {
  const id = asString(candidate?.id) || "";
  const candidateText = JSON.stringify(candidate || {}).toLowerCase();
  const runId = ctx.runId?.toLowerCase();
  const taskId = ctx.taskId?.toLowerCase();
  const sessionKey = ctx.sessionKey?.toLowerCase();
  const artifactSessionId = ctx.artifactSessionId;
  let score = 0;
  if (artifactSessionId && id === artifactSessionId) score += 1e3;
  if (runId && candidateText.includes(runId)) score += 120;
  if (taskId && candidateText.includes(taskId)) score += 70;
  if (sessionKey && candidateText.includes(sessionKey)) score += 60;
  if (runId && id.toLowerCase().includes(runId)) score += 30;
  if (taskId && id.toLowerCase().includes(taskId)) score += 20;
  score += Math.max(0, 20 - ctx.recencyRank);
  return score;
}
function resolveSessionId(input) {
  if (input.explicitSessionId) {
    return { sessionId: input.explicitSessionId, strategy: "explicit", score: 9999 };
  }
  const list = Array.isArray(input.sessionList) ? input.sessionList : [];
  const withRecency = [...list].map((item, idx) => {
    const updated = Number(item?.time?.updated || 0);
    return { item, idx, updated };
  }).sort((a, b) => b.updated - a.updated).map((x, rank) => ({ ...x, rank }));
  if (input.artifactSessionId) {
    const direct = withRecency.find((x) => asString(x.item?.id) === input.artifactSessionId);
    if (direct) {
      return { sessionId: input.artifactSessionId, strategy: "artifact", score: 1e3 };
    }
  }
  let best = { score: -1 };
  for (const candidate of withRecency) {
    const id = asString(candidate.item?.id);
    if (!id) continue;
    const score = scoreSessionCandidate(candidate.item, {
      runId: input.runId,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      artifactSessionId: input.artifactSessionId,
      recencyRank: candidate.rank
    });
    if (score > best.score) best = { id, score };
  }
  if (best.id && best.score > 0) {
    return { sessionId: best.id, strategy: "scored_fallback", score: best.score };
  }
  const latest = withRecency.find((x) => asString(x.item?.id));
  if (latest) return { sessionId: asString(latest.item?.id), strategy: "latest", score: 0 };
  return { strategy: "none", score: -1 };
}

export {
  parseSseFramesFromBuffer,
  parseSseData,
  unwrapGlobalPayload,
  normalizeOpenCodeEvent,
  normalizeTypedEventV1,
  resolveSessionId
};
