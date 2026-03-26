import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildPluginCallbackDedupeKey,
	OPENCODE_CONTINUATION_CONTROL_HTTP_PATH,
	parseTaggedSessionTitle,
} from "../src/shared-contracts";
import type { OpenCodeContinuationCallbackMetadata } from "../src/types";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ensureAuditDir(directory: string) {
	mkdirSync(directory, { recursive: true });
	return directory;
}

function getAuditPath(directory: string) {
	const resolved = getResolvedPluginConfig(directory);
	const auditDir = resolved.auditDir || join(directory, ".opencode");
	ensureAuditDir(auditDir);
	return join(auditDir, "bridge-callback-audit.jsonl");
}

function appendAudit(directory: string, record: any) {
	const path = getAuditPath(directory);
	appendFileSync(
		path,
		JSON.stringify({ ...record, created_at: new Date().toISOString() }) + "\n",
		"utf8",
	);
}

type PersistedPluginConfig = {
	hookBaseUrl?: string;
	hookToken?: string;
	auditDir?: string;
	openclawAuditPath?: string;
};

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function loadPersistedPluginConfig(directory: string): PersistedPluginConfig {
	const home = asString(process.env.HOME);
	const candidates = [
		join(directory, ".opencode", "plugins", "openclaw-bridge", "config.json"),
		join(directory, ".opencode", "openclaw-bridge-callback.json"),
		join(
			directory,
			".opencode",
			"plugins",
			"openclaw-bridge-callback.config.json",
		),
		...(home
			? [
					join(
						home,
						".config",
						"opencode",
						"plugins",
						"openclaw-bridge",
						"config.json",
					),
					join(home, ".config", "opencode", "openclaw-bridge-callback.json"),
					join(
						home,
						".config",
						"opencode",
						"plugins",
						"openclaw-bridge-callback.config.json",
					),
				]
			: []),
	];
	for (const path of candidates) {
		const data = readJsonFile(path);
		if (!data) continue;
		return {
			hookBaseUrl: asString(data.hookBaseUrl),
			hookToken: asString(data.hookToken),
			auditDir: asString(data.auditDir),
			openclawAuditPath: asString(data.openclawAuditPath),
		};
	}
	return {};
}

function getResolvedPluginConfig(directory: string): PersistedPluginConfig {
	const persisted = loadPersistedPluginConfig(directory);
	return {
		hookBaseUrl:
			asString(process.env.OPENCLAW_HOOK_BASE_URL) || persisted.hookBaseUrl,
		hookToken: asString(process.env.OPENCLAW_HOOK_TOKEN) || persisted.hookToken,
		auditDir:
			asString(process.env.OPENCLAW_BRIDGE_AUDIT_DIR) || persisted.auditDir,
		openclawAuditPath:
			asString(process.env.OPENCLAW_BRIDGE_OPENCLAW_AUDIT_PATH) ||
			persisted.openclawAuditPath,
	};
}

function getOpenClawAuditPath(directory: string) {
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

function appendOpenClawAudit(directory: string, record: any) {
	const path = getOpenClawAuditPath(directory);
	if (!path) return;
	appendFileSync(
		path,
		JSON.stringify({ ...record, createdAt: new Date().toISOString() }) + "\n",
		"utf8",
	);
}

function buildHookContinuationPayload(
	tags: Record<string, string>,
	eventType: string,
	opencodeSessionId?: string,
) {
	const agentId = tags.requested || tags.requested_agent_id;
	const sessionKey = tags.callbackSession || tags.callback_target_session_key;
	const sessionId = tags.callbackSessionId || tags.callback_target_session_id;
	const deliver = (tags.callbackDeliver || tags.callback_deliver) === "true";
	if (!agentId || !sessionKey) return null;
	const metadata = buildContinuationMetadata(
		tags,
		eventType,
		opencodeSessionId,
	);
	return {
		source: "opencode.callback",
		runId: metadata.runId,
		taskId: metadata.taskId,
		eventType: metadata.eventType,
		projectId: metadata.projectId,
		repoRoot: metadata.repoRoot,
		requestedAgentId: metadata.requestedAgentId || agentId,
		resolvedAgentId: metadata.resolvedAgentId,
		callbackTargetSessionKey: metadata.callbackTargetSessionKey || sessionKey,
		callbackTargetSessionId: metadata.callbackTargetSessionId || sessionId,
		opencodeSessionId: metadata.opencodeSessionId,
		workflowId: metadata.workflowId,
		stepId: metadata.stepId,
		next: { action: "launch_run", taskId: metadata.taskId },
		intent: {
			kind:
				eventType === "session.error" || eventType === "task.failed"
					? "launch_run"
					: "notify",
			taskId: metadata.taskId,
			objective:
				eventType === "session.error" || eventType === "task.failed"
					? "Analyze the failure and continue with the corrective next step."
					: "OpenCode step completed; send operator update and continue if needed.",
			prompt:
				eventType === "session.error" || eventType === "task.failed"
					? "The previous step failed. Inspect the failure, summarize the likely reason, then continue with the corrective next step."
					: "The previous step completed. Send a concise operator update, then continue with verification or the next task if needed.",
			notify: [
				"OpenCode Loop Update",
				`- Agent: ${metadata.requestedAgentId || agentId || "unknown-agent"}`,
				`- Task: ${metadata.taskId || metadata.runId || "unknown-task"}`,
				`- Run: ${metadata.runId || "unknown-run"}`,
				`- Event: ${metadata.eventType || "unknown-event"}`,
				`- Project: ${metadata.projectId || "unknown-project"}`,
				`- Repo: ${metadata.repoRoot || "unknown-repo"}`,
				`- Status: ${eventType === "session.error" || eventType === "task.failed" ? "step failed; corrective relaunch requested" : "step completed; continuation in progress"}`,
				`- Action taken: ${eventType === "session.error" || eventType === "task.failed" ? "launching corrective continuation run" : "launching continuation / verification"}`,
				`- Next step: ${metadata.taskId || metadata.runId || "unknown-task"}`,
				"- Need from operator: none"
			].join("\n"),
			reason: metadata.eventType,
		},
		deliver,
	};
}

function buildContinuationMetadata(
	tags: Record<string, string>,
	eventType: string,
	opencodeSessionId?: string,
): OpenCodeContinuationCallbackMetadata {
	return {
		kind: "opencode.callback",
		eventType,
		runId: tags.runId || tags.run_id,
		taskId: tags.taskId || tags.task_id,
		projectId: tags.projectId || tags.project_id,
		repoRoot: tags.repoRoot || tags.repo_root,
		requestedAgentId: tags.requested || tags.requested_agent_id,
		resolvedAgentId: tags.resolved || tags.resolved_agent_id,
		callbackTargetSessionKey:
			tags.callbackSession || tags.callback_target_session_key,
		callbackTargetSessionId:
			tags.callbackSessionId || tags.callback_target_session_id,
		opencodeSessionId:
			opencodeSessionId || tags.opencodeSessionId || tags.opencode_session_id,
		workflowId: tags.workflowId || tags.workflow_id,
		stepId: tags.stepId || tags.step_id,
	};
}

async function postCallback(
	directory: string,
	payload: any,
	meta?: {
		eventType?: string;
		sessionId?: string;
		runId?: string;
		taskId?: string;
		requestedAgentId?: string;
		resolvedAgentId?: string;
		callbackTargetSessionKey?: string;
		callbackTargetSessionId?: string;
		projectId?: string;
		repoRoot?: string;
		workflowId?: string;
		stepId?: string;
	},
) {
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
				loadPersistedPluginConfig(directory).hookBaseUrl ||
					loadPersistedPluginConfig(directory).hookToken,
			),
			envHookBaseUrl: Boolean(asString(process.env.OPENCLAW_HOOK_BASE_URL)),
			envHookToken: Boolean(asString(process.env.OPENCLAW_HOOK_TOKEN)),
		},
	};
	if (!hookBaseUrl || !hookToken) {
		appendAudit(directory, {
			ok: false,
			status: 0,
			reason: "missing_hook_env",
			diagnostics,
			payload,
			meta,
		});
		appendOpenClawAudit(directory, {
			taskId: meta?.taskId,
			runId: meta?.runId,
			agentId: payload?.agentId,
			requestedAgentId: meta?.requestedAgentId,
			resolvedAgentId: meta?.resolvedAgentId,
			sessionKey: undefined,
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
			callbackBody: "missing_hook_env",
		});
		return { ok: false, status: 0, reason: "missing_hook_env" };
	}
	const callbackUrl = `${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CONTINUATION_CONTROL_HTTP_PATH}`;
	appendAudit(directory, {
		phase: "callback_attempt",
		diagnostics: {
			...diagnostics,
			callbackUrl,
		},
		payload,
		meta,
	});
	const response = await fetch(callbackUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${hookToken}`,
			"x-openclaw-token": hookToken,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
	const text = await response.text();
	appendAudit(directory, {
		ok: response.ok,
		status: response.status,
		body: text,
		diagnostics: {
			...diagnostics,
			callbackUrl,
		},
		payload,
		meta,
	});
	const openClawAuditRecord = {
		taskId: meta?.taskId,
		runId: meta?.runId,
		agentId: payload?.agentId,
		requestedAgentId: meta?.requestedAgentId,
		resolvedAgentId: meta?.resolvedAgentId,
		sessionKey: undefined,
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
		callbackBody: text,
	};
	appendAudit(directory, {
		phase: "openclaw_audit_mirror",
		record: openClawAuditRecord,
	});
	appendOpenClawAudit(directory, openClawAuditRecord);
	return { ok: response.ok, status: response.status, body: text };
}

const callbackDedupe = new Set<string>();
const sessionTagCache = new Map<string, Record<string, string>>();

function readSessionId(event: any): string | undefined {
	return (
		asString(event?.session?.id) ||
		asString(event?.session?.sessionID) ||
		asString(event?.data?.session?.id) ||
		asString(event?.data?.sessionID) ||
		asString(event?.properties?.sessionID) ||
		asString(event?.properties?.info?.sessionID) ||
		asString(event?.properties?.info?.id) ||
		asString(event?.payload?.sessionID)
	);
}

function readMessageFinish(event: any): string | undefined {
	return (
		asString(event?.properties?.info?.finish) ||
		asString(event?.data?.info?.finish) ||
		asString(event?.payload?.info?.finish)
	);
}

function isTerminalEvent(event: any, type: string): boolean {
	if (type === "session.idle" || type === "session.error") return true;
	const finish = readMessageFinish(event);
	if (type === "message.updated" && finish === "stop") return true;
	return false;
}

export const OpenClawBridgeCallbackPlugin = async ({
	client,
	directory,
}: any) => {
	await client.app.log({
		body: {
			service: "openclaw-bridge-callback",
			level: "info",
			message: "OpenClaw bridge callback plugin initialized",
			extra: { directory },
		},
	});

	return {
		event: async ({ event }: any) => {
			const type = asString(event?.type) || "unknown";
			const sessionId = readSessionId(event);
			const title =
				asString(event?.session?.title) ||
				asString(event?.data?.session?.title) ||
				asString(event?.data?.title) ||
				asString(event?.properties?.info?.title) ||
				asString(event?.properties?.title) ||
				asString(event?.payload?.session?.title) ||
				asString(event?.payload?.title);
			const parsedTags = parseTaggedSessionTitle(title);
			if (
				sessionId &&
				parsedTags &&
				(parsedTags.callbackSession || parsedTags.callback_target_session_key)
			) {
				sessionTagCache.set(sessionId, parsedTags);
			}
			const tags =
				parsedTags ||
				(sessionId ? sessionTagCache.get(sessionId) || null : null);
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
					hookBaseUrlPreview: resolvedConfig.hookBaseUrl || null,
				},
				raw: event,
			});
			if (!tags || !(tags.callbackSession || tags.callback_target_session_key))
				return;
			if (!isTerminalEvent(event, type)) return;
			const dedupeKey = buildPluginCallbackDedupeKey({
				sessionId,
				runId: tags.runId || tags.run_id,
			});
			if (callbackDedupe.has(dedupeKey)) {
				appendAudit(directory, {
					phase: "deduped",
					event_type: type,
					session_id: sessionId,
					dedupeKey,
					tags,
				});
				return;
			}
			callbackDedupe.add(dedupeKey);
			const payload = buildHookContinuationPayload(tags, type, sessionId);
			if (!payload) {
				appendAudit(directory, {
					phase: "skipped_no_payload",
					event_type: type,
					session_id: sessionId,
					tags,
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
				callbackTargetSessionKey:
					tags.callbackSession || tags.callback_target_session_key,
				callbackTargetSessionId:
					tags.callbackSessionId || tags.callback_target_session_id,
				projectId: tags.projectId || tags.project_id,
				repoRoot: tags.repoRoot || tags.repo_root,
				workflowId: tags.workflowId || tags.workflow_id,
				stepId: tags.stepId || tags.step_id,
			});
		},
	};
};

export default OpenClawBridgeCallbackPlugin;
