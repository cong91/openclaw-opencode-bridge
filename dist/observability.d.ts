type OpenCodeEventKind = "task.started" | "task.progress" | "permission.requested" | "task.stalled" | "task.failed" | "task.completed";
type EventScope = "session" | "global";
type SseFrame = {
    event?: string;
    id?: string;
    retry?: number;
    data: string;
    raw: string;
};
type TypedEventV1 = {
    schema: "opencode.event.v1";
    scope: EventScope;
    eventName?: string;
    eventId?: string;
    kind: OpenCodeEventKind | null;
    summary?: string;
    runId?: string;
    taskId?: string;
    sessionId?: string;
    timestamp: string;
    wrappers: string[];
    payload: any;
};
declare function parseSseFramesFromBuffer(input: string): {
    frames: SseFrame[];
    remainder: string;
};
declare function parseSseData(data: string): any;
declare function unwrapGlobalPayload(raw: any): {
    payload: any;
    wrappers: string[];
};
declare function normalizeOpenCodeEvent(raw: any): {
    kind: OpenCodeEventKind | null;
    summary?: string;
    raw: any;
};
declare function normalizeTypedEventV1(frame: SseFrame, scope: EventScope): TypedEventV1;
declare function resolveSessionId(input: {
    explicitSessionId?: string;
    runId?: string;
    taskId?: string;
    sessionKey?: string;
    artifactSessionId?: string;
    sessionList?: any[];
}): {
    sessionId?: string;
    strategy: "explicit" | "artifact" | "scored_fallback" | "latest" | "none";
    score?: number;
};

export { type EventScope, type OpenCodeEventKind, type SseFrame, type TypedEventV1, normalizeOpenCodeEvent, normalizeTypedEventV1, parseSseData, parseSseFramesFromBuffer, resolveSessionId, unwrapGlobalPayload };
