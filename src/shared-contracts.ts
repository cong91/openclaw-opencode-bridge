export type BridgeSessionTagFields = {
	runId: string;
	taskId: string;
	requested: string;
	resolved: string;
	callbackSession: string;
	callbackSessionId?: string;
	callbackDeliver?: boolean;
	projectId?: string;
	repoRoot?: string;
	agentWorkspaceDir?: string;
	workflowId?: string;
	stepId?: string;
};

export const OPENCODE_CALLBACK_HTTP_PATH = "/plugin/opencode-bridge/callback";
export const OPENCODE_CONTINUATION_CONTROL_HTTP_PATH = "/plugin/opencode-bridge/continue-loop";
export const OPENCODE_CONTINUATION_HOOK_PATH = "/hooks/opencode-callback";

export type OpenCodePluginCallbackAuditRecord = {
	phase?: string;
	event_type?: string;
	session_id?: string;
	title?: string;
	tags?: Record<string, string> | null;
	dedupeKey?: string;
	ok?: boolean;
	status?: number;
	reason?: string;
	body?: string;
	payload?: any;
	raw?: any;
	created_at: string;
};

export function buildTaggedSessionTitle(
	fields: BridgeSessionTagFields,
): string {
	return [
		`${fields.taskId}`,
		`runId=${fields.runId}`,
		`taskId=${fields.taskId}`,
		`requested=${fields.requested}`,
		`resolved=${fields.resolved}`,
		`callbackSession=${fields.callbackSession}`,
		...(fields.callbackSessionId
			? [`callbackSessionId=${fields.callbackSessionId}`]
			: []),
		...(fields.callbackDeliver !== undefined
			? [`callbackDeliver=${fields.callbackDeliver ? "true" : "false"}`]
			: []),
		...(fields.projectId ? [`projectId=${fields.projectId}`] : []),
		...(fields.repoRoot ? [`repoRoot=${fields.repoRoot}`] : []),
		...(fields.agentWorkspaceDir
			? [`agentWorkspaceDir=${fields.agentWorkspaceDir}`]
			: []),
		...(fields.workflowId ? [`workflowId=${fields.workflowId}`] : []),
		...(fields.stepId ? [`stepId=${fields.stepId}`] : []),
	].join(" ");
}

export function parseTaggedSessionTitle(title?: string) {
	if (!title || !title.trim()) return null;
	const tags: Record<string, string> = {};
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

export function buildPluginCallbackDedupeKey(input: {
	sessionId?: string;
	runId?: string;
}) {
	return `${input.sessionId || "no-session"}|${input.runId || "no-run"}`;
}
