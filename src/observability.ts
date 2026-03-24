export type OpenCodeEventKind =
  | "task.started"
  | "task.progress"
  | "permission.requested"
  | "task.stalled"
  | "task.failed"
  | "task.completed";

export type EventScope = "session" | "global";

export type SseFrame = {
  event?: string;
  id?: string;
  retry?: number;
  data: string;
  raw: string;
};

export type TypedEventV1 = {
  schema: "opencode.event.v1";
  scope: EventScope;
  eventName?: string;
  eventId?: string;
  kind: OpenCodeEventKind | null;
  summary?: string;
  lifecycleState?: "planning" | "coding" | "verifying" | "blocked" | "running" | "awaiting_permission" | "stalled" | "failed" | "completed";
  filesChanged?: string[];
  verifySummary?: { command?: string; exit?: number | null; output_preview?: string | null } | null;
  blockers?: string[];
  completionSummary?: string | null;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  timestamp: string;
  wrappers: string[];
  payload: any;
};

export function parseSseFramesFromBuffer(input: string): { frames: SseFrame[]; remainder: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const frames: SseFrame[] = [];

  for (const rawFrame of parts) {
    const lines = rawFrame.split("\n");
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];

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
      raw: rawFrame,
    });
  }

  return { frames, remainder };
}

export function parseSseData(data: string): any {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

export function unwrapGlobalPayload(raw: any): { payload: any; wrappers: string[] } {
  let current = raw;
  const wrappers: string[] = [];

  for (let i = 0; i < 3; i += 1) {
    if (!current || typeof current !== "object") break;
    if ("payload" in current && (current as any).payload !== undefined) {
      wrappers.push("payload");
      current = (current as any).payload;
      continue;
    }
    if ("data" in current && (current as any).data !== undefined && Object.keys(current).length <= 4) {
      wrappers.push("data");
      current = (current as any).data;
      continue;
    }
    break;
  }

  return { payload: current, wrappers };
}

function pickFirstString(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = (obj as any)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function asObject(value: any): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function hasExplicitPermissionPrompt(raw: any): boolean {
  const root = asObject(raw) || {};
  const type = asString(root.type)?.toLowerCase();
  if (type === "question.asked") return true;

  const properties = asObject(root.properties) || {};
  const requestId = asString(properties.requestID) || asString(properties.requestId);
  const questions = asArray(properties.questions);
  if (requestId || questions.length > 0) return true;

  const part = asObject(properties.part) || {};
  if (asString(part.type)?.toLowerCase() === "question") return true;

  return false;
}

function inferLifecycleState(raw: any): TypedEventV1["lifecycleState"] {
  const text = JSON.stringify(raw || {}).toLowerCase();
  if (hasExplicitPermissionPrompt(raw)) return "awaiting_permission";
  if (text.includes("blocked") || text.includes("missing config") || text.includes("missing token") || text.includes("missing api_key")) return "blocked";
  if (text.includes("error") || text.includes("failed")) return "failed";
  if (text.includes("stalled")) return "stalled";
  if (text.includes("compile") || text.includes("pytest") || text.includes("test") || text.includes("verify")) return "verifying";
  if (text.includes("apply_patch") || text.includes("diff") || text.includes("edit") || text.includes("write")) return "coding";
  if (text.includes("plan") || text.includes("discovery") || text.includes("ground") || text.includes("calibrate")) return "planning";
  if (text.includes("complete") || text.includes("completed") || text.includes("done")) return "completed";
  return "running";
}

function extractFilesChanged(raw: any): string[] {
  const files: string[] = [];
  const root = asObject(raw) || {};
  const payload = asObject(root.payload) || root;
  const state = asObject(root.state) || asObject(payload.state) || {};
  const metadata = asObject(state.metadata) || asObject(payload.metadata) || {};

  for (const file of asArray(metadata.files)) {
    const obj = asObject(file);
    if (!obj) continue;
    if (typeof obj.relativePath === "string") files.push(obj.relativePath);
    else if (typeof obj.filePath === "string") files.push(obj.filePath);
  }

  for (const file of asArray(root.files)) {
    if (typeof file === "string") files.push(file);
  }

  return uniqueStrings(files);
}

function extractVerifySummary(raw: any): { command?: string; exit?: number | null; output_preview?: string | null } | null {
  const root = asObject(raw) || {};
  const payload = asObject(root.payload) || root;
  const state = asObject(root.state) || asObject(payload.state);
  const input = asObject(state?.input);
  const metadata = asObject(state?.metadata);
  const command = typeof input?.command === "string" ? input.command : undefined;
  const exit = typeof metadata?.exit === "number" ? metadata.exit : null;
  const output = typeof state?.output === "string" ? state.output : typeof metadata?.output === "string" ? metadata.output : null;
  if (!command && output == null) return null;
  return {
    command,
    exit,
    output_preview: typeof output === "string" ? output.slice(0, 500) : null,
  };
}

function extractBlockers(raw: any): string[] {
  const text = JSON.stringify(raw || {}).toLowerCase();
  const blockers: string[] = [];
  if (text.includes("no module named pytest")) blockers.push("pytest_missing");
  if (text.includes("missing token") || text.includes("missing api_key") || text.includes("pow service not configured")) blockers.push("runtime_config_missing");
  if (hasExplicitPermissionPrompt(raw)) blockers.push("awaiting_permission");
  return uniqueStrings(blockers);
}

function extractCompletionSummary(raw: any): string | null {
  const root = asObject(raw) || {};
  const text = typeof root.text === "string" ? root.text : typeof root.summary === "string" ? root.summary : null;
  return text ? text.slice(0, 2000) : null;
}

export function normalizeOpenCodeEvent(raw: any): {
  kind: OpenCodeEventKind | null;
  summary?: string;
  raw: any;
  lifecycleState?: TypedEventV1["lifecycleState"];
  filesChanged?: string[];
  verifySummary?: { command?: string; exit?: number | null; output_preview?: string | null } | null;
  blockers?: string[];
  completionSummary?: string | null;
} {
  const text = JSON.stringify(raw || {}).toLowerCase();
  let kind: OpenCodeEventKind | null = null;
  let summary: string | undefined;

  if (hasExplicitPermissionPrompt(raw)) {
    kind = "permission.requested";
    summary = "OpenCode đang chờ permission/user input";
  } else if (text.includes("error") || text.includes("failed")) {
    kind = "task.failed";
    summary = "OpenCode task failed";
  } else if (text.includes("stalled")) {
    kind = "task.stalled";
    summary = "OpenCode task stalled";
  } else if (text.includes("complete") || text.includes("completed") || text.includes("done")) {
    kind = "task.completed";
    summary = "OpenCode task completed";
  } else if (text.includes("progress") || text.includes("delta") || text.includes("assistant")) {
    kind = "task.progress";
    summary = "OpenCode task made progress";
  } else if (text.includes("start") || text.includes("created") || text.includes("connected")) {
    kind = "task.started";
    summary = "OpenCode task/server started";
  }

  return {
    kind,
    summary,
    raw,
    lifecycleState: inferLifecycleState(raw),
    filesChanged: extractFilesChanged(raw),
    verifySummary: extractVerifySummary(raw),
    blockers: extractBlockers(raw),
    completionSummary: extractCompletionSummary(raw),
  };
}

export function normalizeTypedEventV1(frame: SseFrame, scope: EventScope): TypedEventV1 {
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
    lifecycleState: normalized.lifecycleState,
    filesChanged: normalized.filesChanged,
    verifySummary: normalized.verifySummary,
    blockers: normalized.blockers,
    completionSummary: normalized.completionSummary,
    runId: pickFirstString(unwrapped.payload, ["run_id", "runId"]),
    taskId: pickFirstString(unwrapped.payload, ["task_id", "taskId"]),
    sessionId: pickFirstString(unwrapped.payload, ["session_id", "sessionId", "session"]),
    timestamp: new Date().toISOString(),
    wrappers: unwrapped.wrappers,
    payload: unwrapped.payload,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scoreSessionCandidate(candidate: any, ctx: { runId?: string; taskId?: string; sessionKey?: string; artifactSessionId?: string; repoRoot?: string; projectId?: string; recencyRank: number }): number {
  const id = asString(candidate?.id) || "";
  const candidateText = JSON.stringify(candidate || {}).toLowerCase();
  const runId = ctx.runId?.toLowerCase();
  const taskId = ctx.taskId?.toLowerCase();
  const sessionKey = ctx.sessionKey?.toLowerCase();
  const artifactSessionId = ctx.artifactSessionId;
  const repoRoot = ctx.repoRoot?.toLowerCase();
  const projectId = ctx.projectId?.toLowerCase();

  let score = 0;
  if (artifactSessionId && id === artifactSessionId) score += 1000;
  if (repoRoot && candidateText.includes(repoRoot)) score += 300;
  if (projectId && candidateText.includes(projectId)) score += 180;
  if (runId && candidateText.includes(runId)) score += 120;
  if (taskId && candidateText.includes(taskId)) score += 70;
  if (sessionKey && candidateText.includes(sessionKey)) score += 60;
  if (runId && id.toLowerCase().includes(runId)) score += 30;
  if (taskId && id.toLowerCase().includes(taskId)) score += 20;
  score += Math.max(0, 20 - ctx.recencyRank);
  return score;
}

export function summarizeLifecycle(events: Array<{
  kind?: OpenCodeEventKind | null;
  summary?: string;
  lifecycleState?: TypedEventV1["lifecycleState"];
  filesChanged?: string[];
  verifySummary?: { command?: string; exit?: number | null; output_preview?: string | null } | null;
  blockers?: string[];
  completionSummary?: string | null;
  timestamp?: string;
}> = []) {
  let currentState: TypedEventV1["lifecycleState"] | null = null;
  let last_event_kind: OpenCodeEventKind | null = null;
  let last_event_at: string | null = null;
  const files_changed = new Set<string>();
  const verify_summary: { command?: string; exit?: number | null; output_preview?: string | null }[] = [];
  const blockers = new Set<string>();
  let completion_summary: string | null = null;

  for (const item of events) {
    if (item.lifecycleState) currentState = item.lifecycleState;
    if (item.kind) last_event_kind = item.kind;
    if (item.timestamp) last_event_at = item.timestamp;
    for (const file of item.filesChanged || []) files_changed.add(file);
    if (item.verifySummary) verify_summary.push(item.verifySummary);
    for (const blocker of item.blockers || []) blockers.add(blocker);
    if (item.completionSummary) completion_summary = item.completionSummary;
  }

  return {
    currentState,
    current_state: currentState,
    last_event_kind,
    last_event_at,
    files_changed: [...files_changed],
    verify_summary,
    blockers: [...blockers],
    completion_summary,
  };
}

export function resolveSessionId(input: {
  explicitSessionId?: string;
  runId?: string;
  taskId?: string;
  sessionKey?: string;
  artifactSessionId?: string;
  repoRoot?: string;
  projectId?: string;
  sessionList?: any[];
}): {
  sessionId?: string;
  strategy: "explicit" | "artifact" | "scored_fallback" | "latest" | "none";
  score?: number;
} {
  if (input.explicitSessionId) {
    return { sessionId: input.explicitSessionId, strategy: "explicit", score: 9999 };
  }

  const list = Array.isArray(input.sessionList) ? input.sessionList : [];
  const withRecency = [...list]
    .map((item, idx) => {
      const updated = Number(item?.time?.updated || 0);
      return { item, idx, updated };
    })
    .sort((a, b) => b.updated - a.updated)
    .map((x, rank) => ({ ...x, rank }));

  if (input.artifactSessionId) {
    const direct = withRecency.find((x) => asString(x.item?.id) === input.artifactSessionId);
    if (direct) {
      return { sessionId: input.artifactSessionId, strategy: "artifact", score: 1000 };
    }
  }

  let best: { id?: string; score: number } = { score: -1 };
  for (const candidate of withRecency) {
    const id = asString(candidate.item?.id);
    if (!id) continue;
    const score = scoreSessionCandidate(candidate.item, {
      runId: input.runId,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      artifactSessionId: input.artifactSessionId,
      repoRoot: input.repoRoot,
      projectId: input.projectId,
      recencyRank: candidate.rank,
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
