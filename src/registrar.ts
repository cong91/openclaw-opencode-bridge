import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { mapCallbackEventToContinuationIntent } from "./hook-continuation";
import type { EventScope } from "./observability";
import { summarizeLifecycle } from "./observability";
import {
	asNumber,
	asString,
	buildEnvelope,
	buildHookPolicyChecklist,
	cleanupExpiredServes,
	collectSseEvents,
	DEFAULT_EVENT_LIMIT,
	DEFAULT_OBS_TIMEOUT_MS,
	DEFAULT_TAIL_LIMIT,
	evaluateLifecycle,
	evaluateServeIdle,
	fetchJsonSafe,
	findRegistryEntry,
	getAuditDir,
	getBridgeConfigPath,
	getBridgeStateDir,
	getRunStateDir,
	getRuntimeConfig,
	getServeRegistryPath,
	getSessionRegistryPath,
	listLiveOpencodeServeProcesses,
	listRunStatuses,
	normalizeRegistry,
	normalizeServeRegistry,
	normalizeSessionRegistry,
	patchRunStatus,
	readRunStatus,
	readServeRegistry,
	readSessionRegistry,
	resolveExecutionAgent,
	resolveServerUrl,
	resolveSessionForRun,
	shutdownServe,
	spawnServeForProject,
	startExecutionRun,
	upsertServeRegistry,
	writeServeRegistryFile,
	writeSessionRegistryFile,
} from "./runtime";
import {
	buildCanonicalCallbackSessionKey,
	isCanonicalCallbackSessionKey,
	OPENCODE_CALLBACK_HTTP_PATH,
	OPENCODE_CONTINUATION_CONTROL_HTTP_PATH,
	OPENCODE_CONTINUATION_HOOK_PATH,
} from "./shared-contracts";
import type {
	BridgeRunStatus,
	OpenCodeContinuationCallbackMetadata,
	OpenCodeRunContinuation,
	RunEventsResponse,
	RunStatusResponse,
	ServeRegistryEntry,
	SessionTailMessage,
	SessionTailResponse,
} from "./types";

const PLUGIN_VERSION = "0.1.6";

function deriveAgentIdFromSessionKey(sessionKey?: string): string | undefined {
	if (!sessionKey) return undefined;
	const matched = sessionKey.match(/^agent:([^:]+):/);
	return matched?.[1];
}

function asContinuationStep(
	value: unknown,
): OpenCodeRunContinuation["nextOnSuccess"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const action = asString(raw.action);
	if (action !== "launch_run" && action !== "notify" && action !== "none") {
		return undefined;
	}
	return {
		action,
		...(asString(raw.taskId) ? { taskId: asString(raw.taskId) } : {}),
		...(asString(raw.objective) ? { objective: asString(raw.objective) } : {}),
		...(asString(raw.prompt) ? { prompt: asString(raw.prompt) } : {}),
	};
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

function appendCallbackDebugAudit(record: Record<string, unknown>) {
	const dir = join(getAuditDir(), "debug");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "callback-visible-ack.jsonl");
	appendFileSync(
		path,
		JSON.stringify({ ...record, createdAt: new Date().toISOString() }) + "\n",
		"utf8",
	);
	return path;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function buildContinuationCommandPayload(input: {
	runStatus: BridgeRunStatus;
	metadata: OpenCodeContinuationCallbackMetadata | null;
	step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>;
}) {
	return {
		version: "v1",
		sourceRunId: input.metadata?.runId || input.runStatus.runId,
		sourceTaskId: input.metadata?.taskId || input.runStatus.taskId,
		eventType: input.metadata?.eventType || null,
		projectId: input.runStatus.envelope.project_id,
		repoRoot: input.runStatus.envelope.repo_root,
		agentWorkspaceDir:
			input.runStatus.envelope.agent_workspace_dir ||
			input.runStatus.envelope.repo_root,
		requestedAgentId: input.runStatus.envelope.requested_agent_id,
		resolvedAgentId: input.runStatus.envelope.resolved_agent_id,
		originSessionKey: input.runStatus.envelope.origin_session_key,
		originSessionId: input.runStatus.envelope.origin_session_id,
		callbackTargetSessionKey:
			input.runStatus.envelope.callback_target_session_key,
		callbackTargetSessionId:
			input.runStatus.envelope.callback_target_session_id,
		callbackRelaySessionKey:
			input.runStatus.envelope.callback_relay_session_key,
		callbackRelaySessionId: input.runStatus.envelope.callback_relay_session_id,
		workflowId: input.runStatus.continuation?.workflowId,
		stepId: input.runStatus.continuation?.stepId,
		next: input.step,
	};
}

async function dispatchContinuationToCustomHook(input: {
	cfg: any;
	metadata: OpenCodeContinuationCallbackMetadata | null;
	runStatus: BridgeRunStatus;
	step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>;
}) {
	const runtimeCfg = getRuntimeConfig(input.cfg);
	const hookBaseUrl = asString(runtimeCfg.hookBaseUrl);
	const hookToken = asString(runtimeCfg.hookToken);
	if (!hookBaseUrl || !hookToken) {
		return { ok: false as const, error: "hook base/token missing" };
	}
	const intent = mapCallbackEventToContinuationIntent({
		metadata: input.metadata,
		next: input.step,
	});
	const payload = {
		source: "opencode.callback",
		kind: "opencode.callback",
		runId: input.metadata?.runId || input.runStatus.runId,
		taskId: input.metadata?.taskId || input.runStatus.taskId,
		eventType: input.metadata?.eventType || null,
		projectId: input.runStatus.envelope.project_id,
		repoRoot: input.runStatus.envelope.repo_root,
		agentWorkspaceDir:
			input.runStatus.envelope.agent_workspace_dir ||
			input.runStatus.envelope.repo_root,
		requestedAgentId: input.runStatus.envelope.requested_agent_id,
		resolvedAgentId: input.runStatus.envelope.resolved_agent_id,
		originSessionKey: input.runStatus.envelope.origin_session_key,
		originSessionId: input.runStatus.envelope.origin_session_id,
		callbackTargetSessionKey:
			input.runStatus.envelope.callback_target_session_key,
		callbackTargetSessionId:
			input.runStatus.envelope.callback_target_session_id,
		workflowId: input.runStatus.continuation?.workflowId,
		stepId: input.runStatus.continuation?.stepId,
		next: input.step,
		intent,
	};
	const url = `${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CONTINUATION_HOOK_PATH}`;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${hookToken}`,
			},
			body: JSON.stringify(payload),
		});
		const bodyText = await response.text().catch(() => "");
		return {
			ok: response.ok,
			status: response.status,
			body: bodyText,
			url,
		};
	} catch (error) {
		return {
			ok: false as const,
			error: error instanceof Error ? error.message : String(error),
			url,
		};
	}
}

function registerContinuationCommand(api: any, cfg: any) {
	if (typeof api?.registerCommand !== "function") return;
	api.registerCommand({
		name: "opencode-continue",
		description:
			"Continue a bridge-managed workflow step after OpenCode callback",
		acceptsArgs: true,
		requireAuth: false,
		handler: async ({ args }: { args?: string }) => {
			const payload = parseJsonObject(args || "");
			if (!payload) {
				return { text: "❌ Invalid /opencode-continue payload." };
			}
			const next = payload.next as Record<string, unknown> | undefined;
			const taskId =
				asString(next?.taskId) ||
				asString(payload.sourceTaskId) ||
				"opencode-continue";
			const runId = `${taskId}-${Date.now()}`;
			const requestedAgentId = asString(payload.requestedAgentId) || "creator";
			const resolvedAgentId =
				asString(payload.resolvedAgentId) || requestedAgentId || "creator";
			const projectId = asString(payload.projectId) || "unknown-project";
			const repoRoot = asString(payload.repoRoot) || ".";
			const agentWorkspaceDir = asString(payload.agentWorkspaceDir) || repoRoot;
			const originSessionKey =
				asString(payload.originSessionKey) || "session:unknown";
			const serverUrl =
				findRegistryEntry({
					cfg,
					projectId,
					repoRoot,
				})?.serverUrl || resolveServerUrl(cfg);
			const envelope = buildEnvelope({
				taskId,
				runId,
				requestedAgentId,
				resolvedAgentId,
				originSessionKey,
				originSessionId: asString(payload.originSessionId),
				projectId,
				repoRoot,
				agentWorkspaceDir,
				serverUrl,
				deliver: true,
			});
			const continuation = asString(payload.workflowId)
				? {
						workflowId: asString(payload.workflowId),
						stepId: asString(next?.taskId) || asString(payload.stepId),
						callbackEventKind: "opencode.callback" as const,
					}
				: undefined;
			await startExecutionRun({
				cfg,
				envelope,
				prompt:
					asString(next?.prompt) ||
					asString(next?.objective) ||
					"Continue workflow step.",
				continuation,
			});
			appendCallbackDebugAudit({
				phase: "plugin_command_child_run_started",
				taskId,
				runId,
				sourceRunId: asString(payload.sourceRunId) || null,
			});
			return { text: `▶️ Continued workflow as ${taskId} (${runId}).` };
		},
	});
}

function parseOpencodeCallbackPayload(raw: string):
	| {
			ok: true;
			body: {
				message: string;
				name?: string;
				agentId?: string;
				sessionKey: string;
				sessionId?: string;
				wakeMode?: "now" | "next-heartbeat";
				deliver?: boolean;
				channel?: string;
				to?: string;
			};
			metadata: OpenCodeContinuationCallbackMetadata | null;
	  }
	| {
			ok: false;
			error: string;
	  } {
	let parsed: any;
	try {
		parsed = JSON.parse(raw || "{}");
	} catch {
		return { ok: false, error: "invalid JSON body" };
	}
	const sessionKey = asString(parsed?.sessionKey);
	const message =
		typeof parsed?.message === "string" ? parsed.message : undefined;
	if (!sessionKey) return { ok: false, error: "sessionKey required" };
	if (!message) return { ok: false, error: "message required" };
	let metadata: OpenCodeContinuationCallbackMetadata | null = null;
	try {
		const typed = JSON.parse(message);
		if (
			typed &&
			typeof typed === "object" &&
			typed.kind === "opencode.callback"
		) {
			metadata = typed as OpenCodeContinuationCallbackMetadata;
		}
	} catch {}
	return {
		ok: true,
		body: {
			message,
			...(asString(parsed?.name) ? { name: asString(parsed?.name) } : {}),
			...(asString(parsed?.agentId)
				? { agentId: asString(parsed?.agentId) }
				: {}),
			sessionKey,
			...(asString(parsed?.sessionId)
				? { sessionId: asString(parsed?.sessionId) }
				: {}),
			wakeMode:
				parsed?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now",
			deliver: parsed?.deliver === true,
			...(asString(parsed?.channel)
				? { channel: asString(parsed?.channel) }
				: {}),
			...(asString(parsed?.to) ? { to: asString(parsed?.to) } : {}),
		},
		metadata,
	};
}

function mapCallbackEventToArtifactState(eventType?: string): {
	state: BridgeRunStatus["state"];
	lastEvent: BridgeRunStatus["lastEvent"];
	terminal: boolean;
} | null {
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
			return {
				state: "completed",
				lastEvent: "task.completed",
				terminal: true,
			};
		default:
			return null;
	}
}

function isTerminalState(state?: BridgeRunStatus["state"] | null): boolean {
	return state === "completed" || state === "failed" || state === "stalled";
}

function resolveCanonicalCallbackRoute(input: {
	callback: { sessionKey: string };
	metadata: OpenCodeContinuationCallbackMetadata | null;
}) {
	if (isCanonicalCallbackSessionKey(input.metadata?.callbackTargetSessionKey)) {
		return input.metadata?.callbackTargetSessionKey as string;
	}
	const requestedAgentId = asString(input.metadata?.requestedAgentId);
	const callbackAnchor =
		asString(input.metadata?.callbackTargetSessionId) ||
		asString(input.metadata?.originSessionId) ||
		asString(input.metadata?.runId) ||
		asString(input.metadata?.taskId);
	if (requestedAgentId && callbackAnchor) {
		return buildCanonicalCallbackSessionKey({
			agentId: requestedAgentId,
			anchor: callbackAnchor,
		});
	}
	if (isCanonicalCallbackSessionKey(input.callback.sessionKey)) {
		return input.callback.sessionKey;
	}
	return input.callback.sessionKey;
}

function resolveContinuationStep(input: {
	runStatus: BridgeRunStatus | null;
	eventType?: string;
}): OpenCodeRunContinuation["nextOnSuccess"] | undefined {
	if (!input.runStatus?.continuation) return undefined;
	return input.eventType === "task.failed" ||
		input.eventType === "task.stalled" ||
		input.eventType === "session.error"
		? input.runStatus.continuation.nextOnFailure
		: input.runStatus.continuation.nextOnSuccess;
}

function registerCallbackIngressRoute(api: any, cfg: any) {
	if (
		typeof api?.registerHttpRoute !== "function" ||
		typeof api?.runtime?.system?.enqueueSystemEvent !== "function"
	) {
		return;
	}
	api.registerHttpRoute({
		path: OPENCODE_CONTINUATION_CONTROL_HTTP_PATH,
		auth: "plugin",
		handler: async (req: IncomingMessage, res: ServerResponse) => {
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.setHeader("Allow", "POST");
				res.end("Method Not Allowed");
				return true;
			}
			const runtimeCfg = getRuntimeConfig(cfg);
			const expectedToken =
				asString(cfg?.hookToken) || asString(runtimeCfg.hookToken);
			const authz = req.headers.authorization;
			const bearer =
				typeof authz === "string" && authz.startsWith("Bearer ")
					? authz.slice("Bearer ".length).trim()
					: undefined;
			const legacyTokenHeader = req.headers["x-openclaw-token"];
			const legacyToken =
				typeof legacyTokenHeader === "string"
					? legacyTokenHeader.trim()
					: Array.isArray(legacyTokenHeader)
						? asString(legacyTokenHeader[0])
						: undefined;
			const providedToken = bearer || legacyToken;
			if (!expectedToken || !providedToken || providedToken !== expectedToken) {
				sendJson(res, 401, { ok: false, error: "unauthorized" });
				return true;
			}
			const bodyText = await readRequestBody(req);
			let payload: Record<string, unknown> | null = null;
			try {
				payload = bodyText.trim()
					? (JSON.parse(bodyText) as Record<string, unknown>)
					: {};
			} catch {
				sendJson(res, 400, { ok: false, error: "invalid_json" });
				return true;
			}
			const metadata =
				payload as unknown as OpenCodeContinuationCallbackMetadata;
			const retryCount = Math.max(0, Number(payload.retryCount || 0));
			const fallbackAgentId =
				asString(payload.resolvedAgentId) ||
				asString(payload.requestedAgentId) ||
				deriveAgentIdFromSessionKey(
					asString(payload.callbackTargetSessionKey),
				) ||
				"unknown-agent";
			const fakeRunStatus = {
				taskId: asString(payload.taskId) || "",
				runId: asString(payload.runId) || "",
				state: "running",
				updatedAt: new Date().toISOString(),
				envelope: {
					task_id: asString(payload.taskId) || "",
					run_id: asString(payload.runId) || "",
					agent_id: fallbackAgentId,
					requested_agent_id:
						asString(payload.requestedAgentId) || fallbackAgentId,
					resolved_agent_id:
						asString(payload.resolvedAgentId) || fallbackAgentId,
					session_key: asString(payload.callbackTargetSessionKey) || "",
					origin_session_key:
						asString(payload.originSessionKey) ||
						asString(payload.callbackRelaySessionKey) ||
						asString(payload.callbackTargetSessionKey) ||
						"",
					origin_session_id:
						asString(payload.originSessionId) ||
						asString(payload.callbackRelaySessionId) ||
						asString(payload.callbackTargetSessionId),
					callback_target_session_key:
						asString(payload.callbackTargetSessionKey) || "",
					callback_target_session_id: asString(payload.callbackTargetSessionId),
					callback_relay_session_key:
						asString(payload.callbackRelaySessionKey) ||
						asString(payload.originSessionKey),
					callback_relay_session_id:
						asString(payload.callbackRelaySessionId) ||
						asString(payload.originSessionId),
					project_id: asString(payload.projectId) || "",
					repo_root: asString(payload.repoRoot) || "",
					opencode_server_url:
						asString(getRuntimeConfig(cfg).opencodeServerUrl) || "",
				},
				continuation: {
					nextOnSuccess: {
						action: "launch_run",
						taskId: asString((payload as any)?.next?.taskId),
						objective: asString((payload as any)?.next?.objective),
						prompt: asString((payload as any)?.next?.prompt),
					},
					nextOnFailure: {
						action: "launch_run",
						taskId: asString((payload as any)?.next?.taskId),
						objective: asString((payload as any)?.next?.objective),
						prompt: asString((payload as any)?.next?.prompt),
					},
				},
			} as unknown as BridgeRunStatus;
			if (
				(metadata.eventType === "session.error" ||
					metadata.eventType === "task.failed") &&
				retryCount >= 2
			) {
				sendJson(res, 200, {
					ok: true,
					blocked: true,
					reason: "max_retry_reached",
					retryCount,
				});
				return true;
			}
			const step = {
				action: "launch_run",
				taskId: asString((payload as any)?.next?.taskId),
				objective: asString((payload as any)?.next?.objective),
				prompt: asString((payload as any)?.next?.prompt),
			};
			const nextPayload = {
				...payload,
				retryCount: retryCount + 1,
			};
			const hookDispatch = await (async () => {
				const runtimeCfg = getRuntimeConfig(cfg);
				const hookBaseUrl = asString(runtimeCfg.hookBaseUrl);
				const hookToken = asString(runtimeCfg.hookToken);
				if (!hookBaseUrl || !hookToken)
					return { ok: false as const, error: "hook base/token missing" };
				const url = `${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CONTINUATION_HOOK_PATH}`;
				try {
					const response = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${hookToken}`,
						},
						body: JSON.stringify(nextPayload),
					});
					const bodyText = await response.text().catch(() => "");
					return {
						ok: response.ok,
						status: response.status,
						body: bodyText,
						url,
					};
				} catch (error) {
					return {
						ok: false as const,
						error: error instanceof Error ? error.message : String(error),
						url,
					};
				}
			})();
			sendJson(res, hookDispatch.ok ? 200 : 500, {
				ok: hookDispatch.ok,
				hookDispatch,
				retryCount: retryCount + 1,
			});
			return true;
		},
	});

	// Deprecated compatibility shim only.
	// Primary callback ingress is /hooks/opencode-callback; keep this legacy
	// route registered for controlled compatibility while preventing it from
	// being treated as the primary path in source/wording.
	api.registerHttpRoute({
		path: OPENCODE_CALLBACK_HTTP_PATH,
		auth: "plugin",
		handler: async (req: IncomingMessage, res: ServerResponse) => {
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.setHeader("Allow", "POST");
				res.end("Method Not Allowed");
				return true;
			}
			const runtimeCfg = getRuntimeConfig(cfg);
			const expectedToken =
				asString(cfg?.hookToken) || asString(runtimeCfg.hookToken);
			const authz = req.headers.authorization;
			const bearer =
				typeof authz === "string" && authz.startsWith("Bearer ")
					? authz.slice("Bearer ".length).trim()
					: undefined;
			const legacyTokenHeader = req.headers["x-openclaw-token"];
			const legacyToken =
				typeof legacyTokenHeader === "string"
					? legacyTokenHeader.trim()
					: Array.isArray(legacyTokenHeader)
						? asString(legacyTokenHeader[0])
						: undefined;
			const providedToken = bearer || legacyToken;
			if (!expectedToken || !providedToken || providedToken !== expectedToken) {
				sendJson(res, 401, { ok: false, error: "unauthorized" });
				return true;
			}
			const bodyText = await readRequestBody(req);
			const parsed = parseOpencodeCallbackPayload(bodyText);
			if (!parsed.ok) {
				sendJson(res, 400, { ok: false, error: parsed.error });
				return true;
			}
			appendCallbackDebugAudit({
				phase: "deprecated_callback_http_route_used",
				path: OPENCODE_CALLBACK_HTTP_PATH,
				primaryPath: OPENCODE_CONTINUATION_HOOK_PATH,
				eventType: parsed.metadata?.eventType || null,
				runId: parsed.metadata?.runId || null,
			});
			const callback = parsed.body;
			const routedCallbackSessionKey = resolveCanonicalCallbackRoute({
				callback,
				metadata: parsed.metadata,
			});
			const messageKind = "callback_control";
			const dedupeKey =
				parsed.metadata?.runId && parsed.metadata?.eventType
					? `opencode:${parsed.metadata.runId}:${parsed.metadata.eventType}:${routedCallbackSessionKey}:${messageKind}`
					: undefined;
			const runStatus = parsed.metadata?.runId
				? readRunStatus(parsed.metadata.runId)
				: null;
			const continuationStep = resolveContinuationStep({
				runStatus,
				eventType: parsed.metadata?.eventType,
			});
			const callbackAt = new Date().toISOString();
			const callbackPersistence = mapCallbackEventToArtifactState(
				parsed.metadata?.eventType,
			);
			if (parsed.metadata?.runId) {
				patchRunStatus(parsed.metadata.runId, (current) => {
					const isTerminalCallbackIngressEvent =
						parsed.metadata?.eventType === "message.updated" ||
						parsed.metadata?.eventType === "session.idle" ||
						parsed.metadata?.eventType === "session.error";
					const shouldForceTerminal = Boolean(
						callbackPersistence?.terminal && isTerminalCallbackIngressEvent,
					);
					const preserveTerminal =
						isTerminalState(current.state) &&
						(!callbackPersistence || !callbackPersistence.terminal) &&
						!shouldForceTerminal;
					const summary = parsed.metadata?.eventType
						? callbackPersistence?.terminal
							? `Terminal callback materialized (${parsed.metadata.eventType})`
							: `Callback materialized (${parsed.metadata.eventType})`
						: "Callback materialized";
					const callbackBody = JSON.stringify(
						{
							ok: true,
							routed: {
								sessionKey: routedCallbackSessionKey,
								eventType: parsed.metadata?.eventType || null,
								runId: parsed.metadata?.runId || null,
							},
						},
						null,
						0,
					);
					return {
						...current,
						...(callbackPersistence && !preserveTerminal
							? {
									state: callbackPersistence.state,
									lastEvent: callbackPersistence.lastEvent,
								}
							: {}),
						lastSummary: preserveTerminal
							? current.lastSummary || summary
							: summary,
						callbackSentAt: callbackAt,
						callbackStatus: 200,
						callbackOk: true,
						callbackBody,
						callbackError: undefined,
						updatedAt: callbackAt,
					};
				});
			}
			const preferredSessionId = isCanonicalCallbackSessionKey(
				routedCallbackSessionKey,
			)
				? undefined
				: parsed.metadata?.callbackTargetSessionId;
			const callbackTarget = {
				sessionKey: routedCallbackSessionKey,
				...(preferredSessionId ? { sessionId: preferredSessionId } : {}),
			};
			const sessionIdMatched = Boolean(preferredSessionId);
			const fallbackToSessionKey = !preferredSessionId;
			const callbackControlEnvelope = parsed.metadata
				? {
						messageKind,
						callbackHandling: "continue_workflow",
						humanActionRequired: false,
						callback: parsed.metadata,
					}
				: {
						messageKind,
						callbackHandling: "continue_workflow",
						humanActionRequired: false,
						callback: callback.message,
					};
			const heartbeatAgentId =
				callback.agentId || deriveAgentIdFromSessionKey(callback.sessionKey);

			const callbackMessageText = [
				"<opencode_callback_control_internal>",
				JSON.stringify(callbackControlEnvelope),
				"</opencode_callback_control_internal>",
			].join("\n");
			api.runtime.system.enqueueSystemEvent(callbackMessageText, {
				...callbackTarget,
				...(dedupeKey ? { contextKey: dedupeKey } : {}),
			});
			appendCallbackDebugAudit({
				phase: "callback_enqueued",
				sessionKey: routedCallbackSessionKey,
				sessionId: preferredSessionId || null,
				sessionIdMatched,
				fallbackToSessionKey,
				dedupeKey,
				runId: parsed.metadata?.runId || null,
				eventType: parsed.metadata?.eventType || null,
				deliver: callback.deliver === true,
				hasContinuation: Boolean(runStatus?.continuation),
				continuation: runStatus?.continuation || null,
			});
			if (callbackPersistence?.terminal && parsed.metadata?.runId) {
				const refreshedRun = readRunStatus(parsed.metadata.runId);
				const attachPid = refreshedRun?.attachRun?.pid;
				if (typeof attachPid === "number") {
					let killResult = "not_attempted";
					try {
						process.kill(attachPid, "SIGTERM");
						killResult = "sigterm_sent";
					} catch (error) {
						killResult = error instanceof Error ? error.message : String(error);
					}
					patchRunStatus(parsed.metadata.runId, (current) => ({
						...current,
						callbackCleaned: killResult === "sigterm_sent",
						attachRun: {
							...current.attachRun,
							cleaned: killResult === "sigterm_sent",
							cleanedAt: new Date().toISOString(),
							killSignal: "SIGTERM",
							killResult,
						},
						updatedAt: new Date().toISOString(),
					}));
					appendCallbackDebugAudit({
						phase: "attach_run_pid_killed",
						runId: parsed.metadata.runId,
						sessionKey: routedCallbackSessionKey,
						pid: attachPid,
						killSignal: "SIGTERM",
						killResult,
					});
				}
			}
			let dispatchedToHook = false;
			if (runStatus?.continuation) {
				const step = continuationStep;
				appendCallbackDebugAudit({
					phase: "continuation_evaluated",
					sessionKey: routedCallbackSessionKey,
					dedupeKey,
					runId: parsed.metadata?.runId || null,
					eventType: parsed.metadata?.eventType || null,
					selectedStep: step || null,
				});
				if (step?.action === "launch_run") {
					const commandPayload = buildContinuationCommandPayload({
						runStatus,
						metadata: parsed.metadata,
						step,
					});
					const hookDispatch = await dispatchContinuationToCustomHook({
						cfg,
						metadata: parsed.metadata,
						runStatus,
						step,
					});
					appendCallbackDebugAudit({
						phase: hookDispatch.ok
							? "continuation_hook_dispatched"
							: "continuation_hook_failed",
						sessionKey: routedCallbackSessionKey,
						dedupeKey,
						runId: parsed.metadata?.runId || null,
						commandPayload,
						hookDispatch,
					});
				} else if (step?.action === "notify") {
					const notifyMessage =
						step.objective ||
						step.prompt ||
						"Next step requires operator notice.";
					api.runtime.system.enqueueSystemEvent(notifyMessage, {
						...callbackTarget,
						...(dedupeKey
							? { contextKey: `${dedupeKey}:continuation-notify` }
							: {}),
					});
					appendCallbackDebugAudit({
						phase: "continuation_notify_enqueued",
						sessionKey: routedCallbackSessionKey,
						dedupeKey,
						runId: parsed.metadata?.runId || null,
						notifyMessage,
						reason: "registrar_authority",
					});
				}
			} else {
				const runtimeCfg = getRuntimeConfig(cfg);
				const hookBaseUrl = asString(runtimeCfg.hookBaseUrl);
				const hookToken = asString(runtimeCfg.hookToken);
				if (hookBaseUrl && hookToken) {
					const hookUrl = `${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CONTINUATION_HOOK_PATH}`;
					try {
						const hookRes = await fetch(hookUrl, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${hookToken}`,
								"Content-Type": "application/json",
							},
							body: bodyText,
						});
						const hookBody = await hookRes.text().catch(() => "");
						appendCallbackDebugAudit({
							phase: "terminal_callback_forwarded",
							sessionKey: routedCallbackSessionKey,
							dedupeKey,
							runId: parsed.metadata?.runId || null,
							url: hookUrl,
							ok: hookRes.ok,
							status: hookRes.status,
							body: hookBody,
						});
					} catch (error: any) {
						appendCallbackDebugAudit({
							phase: "terminal_callback_forward_failed",
							sessionKey: routedCallbackSessionKey,
							dedupeKey,
							runId: parsed.metadata?.runId || null,
							error: error?.message || String(error),
						});
					}
				}
			}
			sendJson(res, 200, {
				ok: true,
				routed: {
					sessionKey: routedCallbackSessionKey,
					eventType: parsed.metadata?.eventType || null,
					runId: parsed.metadata?.runId || null,
				},
			});
			return true;
		},
	});
}

function buildExecutionPrompt(params: any, envelope: any): string {
	const providedPrompt = asString(params?.prompt);
	if (providedPrompt) return providedPrompt;
	const objective =
		asString(params?.objective) ||
		asString(params?.message) ||
		`Complete task ${envelope.task_id}`;
	const constraints = Array.isArray(params?.constraints)
		? params.constraints.filter((x: any) => typeof x === "string" && x.trim())
		: [];
	const acceptance = Array.isArray(params?.acceptanceCriteria)
		? params.acceptanceCriteria.filter(
				(x: any) => typeof x === "string" && x.trim(),
			)
		: [];
	const beadId = asString(params?.beadId);
	const policyConstraints =
		envelope.resolved_agent_id === "build"
			? [
					"Do not spawn more than one explore subagent unless blocked by missing exact file/function location.",
					"Do not use explore for generic repo layout discovery when repo scope is already explicit.",
					"After the first useful audit result, continue implementation directly.",
					"If scoped changes are complete and unrelated tests fail outside approved scope, do not ask for approval. Report unrelated failures separately and stop after scoped completion.",
					"Do not expand scope to fix unrelated failures unless the packet explicitly authorizes scope expansion.",
					"Do not open a decision checkpoint for unrelated red tests outside the approved scope.",
					"If no patch is needed, conclude explicitly instead of continuing reconnaissance.",
					"Do not loop on todowrite more than once per milestone.",
				]
			: [];
	const mergedConstraints = [...constraints, ...policyConstraints];
	return [
		`Task: ${objective}`,
		`Run ID: ${envelope.run_id}`,
		`Task ID: ${envelope.task_id}`,
		beadId ? `Bead ID: ${beadId}` : undefined,
		`Requested agent: ${envelope.requested_agent_id}`,
		`Resolved execution agent: ${envelope.resolved_agent_id}`,
		beadId
			? `Use bead/task identity '${beadId}' as the execution identity inside OpenCode. Do not call 'br show ${envelope.task_id}' if that Jira key is not a bead id; use the bead id above when interacting with beads.`
			: undefined,
		mergedConstraints.length
			? `Constraints:\n- ${mergedConstraints.join("\n- ")}`
			: undefined,
		acceptance.length
			? `Acceptance criteria:\n- ${acceptance.join("\n- ")}`
			: undefined,
		"When complete, summarize files changed, verification performed, blockers (if any), and completion outcome in the session output.",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function registerOpenCodeBridgeTools(api: any, cfg: any) {
	console.log("[opencode-bridge] plugin loaded");
	console.log(
		`[opencode-bridge] opencodeServerUrl=${cfg.opencodeServerUrl || "(unset)"}`,
	);
	console.log("[opencode-bridge] registering opencode_* tools");
	registerContinuationCommand(api, cfg);
	registerCallbackIngressRoute(api, cfg);

	api.registerTool(
		{
			name: "opencode_status",
			label: "OpenCode Status",
			description:
				"Hiển thị contract hiện tại của OpenCode bridge: sessionKey convention, routing envelope schema, registry, lifecycle state skeleton và assumption 1 project = 1 serve.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const runtimeCfg = getRuntimeConfig(cfg);
				const registry = normalizeRegistry(runtimeCfg.projectRegistry);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									pluginId: "opencode-bridge",
									version: PLUGIN_VERSION,
									assumption: "1 project = 1 opencode serve instance",
									sessionKeyConvention: "hook:opencode:<agentId>:<taskId>",
									lifecycleStates: [
										"queued",
										"server_ready",
										"session_created",
										"prompt_sent",
										"planning",
										"coding",
										"verifying",
										"blocked",
										"running",
										"awaiting_permission",
										"stalled",
										"failed",
										"completed",
									],
									requiredEnvelopeFields: [
										"task_id",
										"run_id",
										"agent_id",
										"requested_agent_id",
										"resolved_agent_id",
										"session_key",
										"origin_session_key",
										"callback_target_session_key",
										"project_id",
										"repo_root",
										"opencode_server_url",
									],
									statusFields: [
										"state",
										"currentState",
										"current_state",
										"lastEvent",
										"last_event_kind",
										"lastSummary",
									],
									primaryCallbackPath: OPENCODE_CALLBACK_HTTP_PATH,
									alternativeSignalPaths: [
										"/hooks/wake",
										"cron",
										"group:sessions",
									],
									config: {
										bridgeConfigPath: getBridgeConfigPath(),
										opencodeServerUrl: runtimeCfg.opencodeServerUrl || null,
										hookBaseUrl: runtimeCfg.hookBaseUrl || null,
										hookTokenPresent: Boolean(runtimeCfg.hookToken),
										projectRegistry: registry,
										executionAgentMappings:
											runtimeCfg.executionAgentMappings || [],
										stateDir: getBridgeStateDir(),
										runStateDir: getRunStateDir(),
										auditDir: getAuditDir(),
									},
									note: "Plugin-owned config/state is stored under ~/.openclaw/opencode-bridge. New projects are auto-registered only when using opencode_serve_spawn, not by passive envelope build alone.",
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_resolve_project",
			label: "OpenCode Resolve Project",
			description:
				"Resolve project registry entry theo projectId hoặc repoRoot, áp dụng assumption 1 project = 1 serve instance.",
			parameters: {
				type: "object",
				properties: {
					projectId: { type: "string" },
					repoRoot: { type: "string" },
				},
			},
			async execute(_id: string, params: any) {
				const entry = findRegistryEntry(
					cfg,
					params?.projectId,
					params?.repoRoot,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, match: entry || null }, null, 2),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_build_envelope",
			label: "OpenCode Build Envelope",
			description:
				"Dựng routing envelope chuẩn cho task delegate sang OpenCode với sessionKey convention hook:opencode:<agentId>:<taskId>.",
			parameters: {
				type: "object",
				properties: {
					taskId: { type: "string" },
					runId: { type: "string" },
					agentId: { type: "string", description: "Requester/origin agent id" },
					executionAgentId: {
						type: "string",
						description: "Optional explicit OpenCode execution agent id",
					},
					originSessionKey: { type: "string" },
					originSessionId: { type: "string" },
					projectId: { type: "string" },
					repoRoot: { type: "string" },
					channel: { type: "string" },
					to: { type: "string" },
					deliver: { type: "boolean" },
					priority: { type: "string" },
				},
				required: [
					"taskId",
					"runId",
					"agentId",
					"originSessionKey",
					"projectId",
					"repoRoot",
				],
			},
			async execute(_id: string, params: any) {
				const entry = findRegistryEntry(
					cfg,
					params?.projectId,
					params?.repoRoot,
				);
				const serverUrl = entry?.serverUrl;
				if (!serverUrl) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error:
											"Missing project registry mapping. Use opencode_serve_spawn for the project or add a matching projectRegistry entry in ~/.openclaw/opencode-bridge/config.json first.",
									},
									null,
									2,
								),
							},
						],
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error: resolved.error,
										requestedAgentId: resolved.requestedAgentId,
										mappingConfigured: resolved.mappingConfigured,
									},
									null,
									2,
								),
							},
						],
					};
				}

				const envelope = buildEnvelope({
					taskId: params.taskId,
					runId: params.runId,
					requestedAgentId: resolved.requestedAgentId,
					resolvedAgentId: resolved.resolvedAgentId,
					executionAgentExplicit: resolved.executionAgentExplicit,
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
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									envelope,
									agentResolution: resolved,
									registryMatch: entry || null,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_check_hook_policy",
			label: "OpenCode Check Hook Policy",
			description:
				"Kiểm tra checklist/policy tối thiểu cho primary callback `/hooks/opencode-callback`; `/plugin/opencode-bridge/callback` chỉ còn compat/deprecated.",
			parameters: {
				type: "object",
				properties: {
					agentId: { type: "string" },
					sessionKey: { type: "string" },
				},
				required: ["agentId", "sessionKey"],
			},
			async execute(_id: string, params: any) {
				const checklist = buildHookPolicyChecklist(
					params.agentId,
					params.sessionKey,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, checklist }, null, 2),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_execute_task",
			label: "OpenCode Execute Task",
			description:
				"Execution entrypoint: resolve/spawn serve, launch attach-run, persist run artifact, and rely on OpenCode-side plugin for terminal callback authority.",
			parameters: {
				type: "object",
				properties: {
					taskId: { type: "string" },
					runId: { type: "string" },
					agentId: { type: "string", description: "Requester/origin agent id" },
					executionAgentId: { type: "string" },
					originSessionKey: { type: "string" },
					originSessionId: { type: "string" },
					projectId: { type: "string" },
					repoRoot: { type: "string" },
					agentWorkspaceDir: { type: "string" },
					prompt: { type: "string" },
					objective: { type: "string" },
					message: { type: "string" },
					constraints: { type: "array", items: { type: "string" } },
					acceptanceCriteria: { type: "array", items: { type: "string" } },
					channel: { type: "string" },
					to: { type: "string" },
					deliver: { type: "boolean" },
					priority: { type: "string" },
					model: { type: "string" },
					idleTimeoutMs: { type: "number" },
					pollIntervalMs: { type: "number" },
					maxWaitMs: { type: "number" },
					workflowId: { type: "string" },
					stepId: { type: "string" },
					nextOnSuccess: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["launch_run", "notify", "none"],
							},
							taskId: { type: "string" },
							objective: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["action"],
					},
					nextOnFailure: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["launch_run", "notify", "none"],
							},
							taskId: { type: "string" },
							objective: { type: "string" },
							prompt: { type: "string" },
						},
						required: ["action"],
					},
				},
				required: [
					"taskId",
					"runId",
					"agentId",
					"originSessionKey",
					"projectId",
					"repoRoot",
				],
			},
			async execute(_id: string, params: any) {
				const opportunisticCleanup = await cleanupExpiredServes();
				const resolved = resolveExecutionAgent({
					cfg,
					requestedAgentId: asString(params?.agentId) || "",
					explicitExecutionAgentId: asString(params?.executionAgentId),
				});
				if (!resolved.ok) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error: resolved.error,
										requestedAgentId: resolved.requestedAgentId,
										mappingConfigured: resolved.mappingConfigured,
									},
									null,
									2,
								),
							},
						],
					};
				}

				const explicitServerUrl = resolveServerUrl(cfg, params);
				const shouldUseExplicitServer = Boolean(
					asString(params?.opencodeServerUrl) || asString(params?.serverUrl),
				);
				const spawned = shouldUseExplicitServer
					? {
							reused: true,
							entry: {
								serve_id: explicitServerUrl,
								opencode_server_url: explicitServerUrl,
								status: "running",
								updated_at: new Date().toISOString(),
							},
							reuseStrategy: "explicit_server_url",
						}
					: await spawnServeForProject({
							project_id: params.projectId,
							repo_root: params.repoRoot,
							idle_timeout_ms: asNumber(params.idleTimeoutMs),
						});
				const serverUrl = spawned.entry.opencode_server_url;
				const envelope = buildEnvelope({
					taskId: params.taskId,
					runId: params.runId,
					requestedAgentId: resolved.requestedAgentId,
					resolvedAgentId: resolved.resolvedAgentId,
					originSessionKey: params.originSessionKey,
					originSessionId: asString(params.originSessionId),
					projectId: params.projectId,
					repoRoot: params.repoRoot,
					agentWorkspaceDir:
						asString(params.agentWorkspaceDir) || asString(params.repoRoot),
					serverUrl,
					channel: params.channel,
					to: params.to,
					deliver: params.deliver,
					priority: params.priority,
				});
				const prompt = buildExecutionPrompt(params, envelope);
				const workflowId = asString(params.workflowId);
				const stepId = asString(params.stepId);
				const nextOnSuccess = asContinuationStep(params.nextOnSuccess);
				const nextOnFailure = asContinuationStep(params.nextOnFailure);
				const continuationEnabled = Boolean(
					workflowId || stepId || nextOnSuccess || nextOnFailure,
				);
				if (params.deliver === true && !continuationEnabled) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error:
											"deliver=true requires continuation metadata (workflowId/stepId and nextOnSuccess or nextOnFailure) so callback can resume work instead of wake-only.",
										requiredForAutoResume: true,
										provided: {
											workflowId,
											stepId,
											nextOnSuccess: nextOnSuccess || null,
											nextOnFailure: nextOnFailure || null,
										},
									},
									null,
									2,
								),
							},
						],
					};
				}
				const requestedPromptVariant = asString(
					params.promptVariant,
				)?.toLowerCase();
				const promptVariant: "medium" | "high" =
					requestedPromptVariant === "high" ||
					requestedPromptVariant === "hard" ||
					asString(params.priority)?.toLowerCase() === "high"
						? "high"
						: "medium";
				const allowedExecutionAgents = new Set([
					"build",
					"plan",
					"fullstack",
					"creator",
					"general",
					"review",
					"explore",
					"scout",
					"vision",
					"compaction",
					"painter",
				]);
				const requestedExecutionAgent = asString(
					params.executionAgentId,
				)?.trim();
				const normalizedExecutionAgent =
					requestedExecutionAgent &&
					allowedExecutionAgents.has(requestedExecutionAgent)
						? requestedExecutionAgent
						: undefined;
				const continuation = continuationEnabled
					? {
							...(workflowId ? { workflowId } : {}),
							...(stepId ? { stepId } : {}),
							callbackEventKind: "opencode.callback" as const,
							promptVariant,
							thinking: true,
							...(nextOnSuccess ? { nextOnSuccess } : {}),
							...(nextOnFailure ? { nextOnFailure } : {}),
						}
					: { promptVariant, thinking: true };
				const executionEnvelope = normalizedExecutionAgent
					? {
							...envelope,
							agent_id: normalizedExecutionAgent,
							resolved_agent_id: normalizedExecutionAgent,
							execution_agent_explicit: true,
						}
					: envelope;
				const execution = await startExecutionRun({
					cfg,
					envelope: executionEnvelope,
					prompt,
					model: asString(params.model),
					continuation,
					pollIntervalMs: asNumber(params.pollIntervalMs),
					maxWaitMs: asNumber(params.maxWaitMs),
				});
				const snapshot =
					listRunStatuses().find(
						(item: BridgeRunStatus) => item.runId === params.runId,
					) || null;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									opportunisticCleanup,
									spawned,
									envelope: executionEnvelope,
									prompt,
									execution: {
										ok: execution.ok,
										runId: execution.runId,
										taskId: execution.taskId,
										sessionId: execution.sessionId,
										opencodeSessionId: (execution as any).opencodeSessionId,
										sessionResolvedAt: (execution as any).sessionResolvedAt,
										sessionResolutionStrategy: (execution as any)
											.sessionResolutionStrategy,
										sessionResolutionPending: (execution as any)
											.sessionResolutionPending,
										state: execution.state,
										attachRun: (execution as any).attachRun,
										callbackAuthority: "opencode_plugin",
										continuationEnabled,
									},
									runStatus: snapshot,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_evaluate_lifecycle",
			label: "OpenCode Evaluate Lifecycle",
			description:
				"Đánh giá lifecycle state hiện tại từ event cuối cùng hoặc thời gian im lặng để hỗ trợ stalled/permission/failure handling baseline.",
			parameters: {
				type: "object",
				properties: {
					lastEventKind: {
						type: "string",
						enum: [
							"task.started",
							"task.progress",
							"permission.requested",
							"task.stalled",
							"task.failed",
							"task.completed",
						],
					},
					lastEventAtMs: { type: "number" },
					nowMs: { type: "number" },
					softStallMs: { type: "number" },
					hardStallMs: { type: "number" },
				},
			},
			async execute(_id: string, params: any) {
				const evaluation = evaluateLifecycle({
					lastEventKind: params.lastEventKind,
					lastEventAtMs: asNumber(params.lastEventAtMs),
					nowMs: asNumber(params.nowMs),
					softStallMs: asNumber(params.softStallMs),
					hardStallMs: asNumber(params.hardStallMs),
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, evaluation }, null, 2),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_run_status",
			label: "OpenCode Run Status",
			description:
				"Read-only run snapshot: hợp nhất artifact run status local và API snapshot từ OpenCode serve (/global/health, /session, /session/status).",
			parameters: {
				type: "object",
				properties: {
					runId: { type: "string" },
					sessionId: { type: "string" },
					opencodeServerUrl: { type: "string" },
				},
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

				const sessionList = Array.isArray(sessionRes.data)
					? sessionRes.data
					: [];
				const resolution = resolveSessionForRun({
					sessionId: asString(params?.sessionId),
					runStatus: artifact,
					sessionList,
					runId,
				});
				const sessionId = resolution.sessionId;
				const eventScope: EventScope = sessionId ? "session" : "global";
				const events = await collectSseEvents(serverUrl, eventScope, {
					limit: DEFAULT_EVENT_LIMIT,
					timeoutMs: DEFAULT_OBS_TIMEOUT_MS,
					runIdHint: runId,
					taskIdHint: artifact?.taskId,
					sessionIdHint: sessionId,
				});
				const lifecycleSummary = summarizeLifecycle(
					events.map((event) => ({
						kind: event.normalizedKind,
						summary: event.summary,
						lifecycleState: event.lifecycle_state as any,
						filesChanged: event.files_changed,
						verifySummary: event.verify_summary as any,
						blockers: event.blockers,
						completionSummary: event.completion_summary,
						timestamp: event.timestamp,
					})),
				);
				const state = artifact?.state || (sessionId ? "running" : "queued");
				const migratedSessionId =
					artifact?.sessionId || artifact?.opencodeSessionId;
				const currentState = isTerminalState(artifact?.state)
					? artifact!.state
					: (lifecycleSummary.currentState as any) || state;
				const warnings: string[] = [];
				if (
					artifact?.state === "running" &&
					lifecycleSummary.currentState === "completed"
				) {
					warnings.push("artifact_running_but_session_completed");
				}
				if (
					artifact?.state === "running" &&
					artifact?.sessionResolutionPending
				) {
					warnings.push("session_resolution_pending");
				}
				if (!artifact?.sessionId && artifact?.opencodeSessionId) {
					warnings.push(
						"legacy_artifact_sessionid_backfilled_from_opencodesessionid",
					);
				}
				if (artifact?.state === "running" && !sessionId) {
					warnings.push("no_session_materialized");
				}
				if (
					artifact?.callbackOk === true &&
					!isTerminalState(artifact?.state)
				) {
					warnings.push("callback_sent_but_not_reconciled");
				}
				if (
					artifact?.state === "running" &&
					artifact?.attachRun?.pid &&
					artifact?.callbackCleaned
				) {
					warnings.push("attach_run_cleaned_but_artifact_not_terminal");
				}
				if (
					artifact?.state === "running" &&
					artifact?.attachRun?.pid &&
					artifact?.callbackCleaned === false
				) {
					warnings.push("process_missing_but_running_artifact");
				}
				const stateConfidence = isTerminalState(artifact?.state)
					? "artifact_plus_callback"
					: sessionId
						? "artifact_plus_session"
						: "artifact_only";

				const callbackSummary = artifact
					? {
							...(typeof artifact.callbackOk === "boolean"
								? { ok: artifact.callbackOk }
								: {}),
							...(typeof artifact.callbackStatus === "number"
								? { status: artifact.callbackStatus }
								: {}),
							...(typeof artifact.callbackBody === "string"
								? { body: artifact.callbackBody }
								: {}),
						}
					: undefined;
				const attachRunSummary = artifact?.attachRun
					? {
							...(typeof artifact.attachRun.pid === "number"
								? { pid: artifact.attachRun.pid }
								: {}),
							...(typeof artifact.attachRun.started === "boolean"
								? { started: artifact.attachRun.started }
								: {}),
							...(typeof artifact.attachRun.cleaned === "boolean"
								? { cleaned: artifact.attachRun.cleaned }
								: {}),
							...(typeof artifact.attachRun.cleanedAt === "string"
								? { cleanedAt: artifact.attachRun.cleanedAt }
								: {}),
							...(typeof artifact.attachRun.killSignal === "string"
								? { killSignal: artifact.attachRun.killSignal }
								: {}),
							...(typeof artifact.attachRun.killResult === "string"
								? { killResult: artifact.attachRun.killResult }
								: {}),
						}
					: undefined;
				const operatorHints: string[] = [];
				if (warnings.includes("artifact_running_but_session_completed")) {
					operatorHints.push(
						"Artifact is lagging behind runtime; trust realState over state for this run.",
					);
				}
				if (
					warnings.includes("session_resolution_pending") ||
					warnings.includes("no_session_materialized")
				) {
					operatorHints.push(
						"Session resolution is incomplete; audit with project-aware session lookup before acting on artifact state.",
					);
				}
				if (warnings.includes("callback_sent_but_not_reconciled")) {
					operatorHints.push(
						"Callback evidence exists but artifact is not terminal; inspect callback reconciliation before rerunning.",
					);
				}
				const response: RunStatusResponse = {
					ok: true,
					source: {
						runArtifact: Boolean(artifact),
						opencodeApi: true,
					},
					runId: runId || undefined,
					taskId: artifact?.taskId,
					projectId: artifact?.envelope?.project_id,
					sessionId: sessionId || migratedSessionId,
					correlation: {
						sessionResolution: {
							strategy: resolution.strategy,
							...(resolution.score !== undefined
								? { score: resolution.score }
								: {}),
						},
					},
					state,
					realState: currentState,
					stateConfidence,
					warnings,
					currentState,
					current_state: currentState,
					lastEvent: artifact?.lastEvent,
					last_event_kind: artifact?.lastEvent,
					lastSummary: artifact?.lastSummary,
					last_event_at: artifact?.updatedAt || new Date().toISOString(),
					files_changed: lifecycleSummary.files_changed,
					verify_summary: lifecycleSummary.verify_summary,
					blockers: lifecycleSummary.blockers,
					completion_summary:
						lifecycleSummary.completion_summary ||
						artifact?.lastSummary ||
						null,
					updatedAt: new Date().toISOString(),
					timestamps: {
						...(artifact?.updatedAt
							? { artifactUpdatedAt: artifact.updatedAt }
							: {}),
						apiFetchedAt: new Date().toISOString(),
					},
					health: {
						ok: Boolean(
							healthRes.ok &&
								(healthRes.data?.healthy === true || healthRes.status === 200),
						),
						...(asString(healthRes?.data?.version)
							? { version: asString(healthRes?.data?.version) }
							: {}),
					},
					apiSnapshot: {
						health: healthRes.data,
						sessionList,
						sessionStatus: sessionStatusRes.data,
						fetchedAt: new Date().toISOString(),
					},
					...(artifact?.continuation
						? { continuation: artifact.continuation }
						: {}),
					...(callbackSummary ? { callbackSummary } : {}),
					...(attachRunSummary ? { attachRunSummary } : {}),
					...(operatorHints.length ? { operatorHints } : {}),
					...(artifact
						? {}
						: {
								note: "No local run artifact found for runId. Returned API-only snapshot.",
							}),
				};

				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_run_events",
			label: "OpenCode Run Events",
			description:
				"Read-only event probe: lấy SSE event từ /event hoặc /global/event, normalize sơ bộ về OpenCodeEventKind.",
			parameters: {
				type: "object",
				properties: {
					scope: { type: "string", enum: ["session", "global"] },
					limit: { type: "number" },
					timeoutMs: { type: "number" },
					runId: { type: "string" },
					sessionId: { type: "string" },
					opencodeServerUrl: { type: "string" },
				},
			},
			async execute(_id: string, params: any) {
				const serverUrl = resolveServerUrl(cfg, params);
				const runId = asString(params?.runId);
				const artifact = runId ? readRunStatus(runId) : null;
				const scope: EventScope =
					params?.scope === "global" ? "global" : "session";
				const timeoutMs = Math.max(
					200,
					asNumber(params?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS,
				);
				const limit = Math.max(
					1,
					asNumber(params?.limit) || DEFAULT_EVENT_LIMIT,
				);

				const sessionListRes = await fetchJsonSafe(
					`${serverUrl.replace(/\/$/, "")}/session`,
				);
				const sessionList = Array.isArray(sessionListRes.data)
					? sessionListRes.data
					: [];
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
				const progressionSummary = {
					hasStarted: events.some(
						(e) =>
							e.normalizedKind === "task.started" ||
							e.normalizedKind === "task.progress",
					),
					hasSubagentActivity: events.some(
						(e) =>
							JSON.stringify(e.data || {}).includes("@explore") ||
							JSON.stringify(e.data || {}).includes("@general"),
					),
					hasToolHeavyLoop:
						events.filter((e) => e.normalizedKind === "task.progress").length >=
						3,
					hasCallbackEvidence: Boolean(artifact?.callbackOk),
					hasTerminalEvent: events.some(
						(e) =>
							e.normalizedKind === "task.completed" ||
							e.normalizedKind === "task.failed" ||
							e.normalizedKind === "task.stalled",
					),
				};
				const response: RunEventsResponse = {
					ok: true,
					...(runId ? { runId } : {}),
					...(artifact?.taskId ? { taskId: artifact.taskId } : {}),
					...(sessionId ? { sessionId } : {}),
					...(artifact?.envelope?.project_id
						? { projectId: artifact.envelope.project_id }
						: {}),
					...(artifact?.envelope?.repo_root
						? { repoRoot: artifact.envelope.repo_root }
						: {}),
					correlation: {
						sessionResolution: {
							strategy: resolution.strategy,
							...(resolution.score !== undefined
								? { score: resolution.score }
								: {}),
						},
					},
					progressionSummary,
					scope,
					schemaVersion: "opencode.event.v1",
					eventPath: scope === "global" ? "/global/event" : "/event",
					eventCount: events.length,
					events,
					...(artifact?.continuation
						? { continuation: artifact.continuation }
						: {}),
					truncated: events.length >= limit,
					timeoutMs,
				};
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_session_tail",
			label: "OpenCode Session Tail",
			description:
				"Read-only session tail: đọc message tail từ /session/{id}/message và optional diff từ /session/{id}/diff.",
			parameters: {
				type: "object",
				properties: {
					sessionId: { type: "string" },
					runId: { type: "string" },
					limit: { type: "number" },
					includeDiff: { type: "boolean" },
					opencodeServerUrl: { type: "string" },
				},
			},
			async execute(_id: string, params: any) {
				const serverUrl = resolveServerUrl(cfg, params);
				const runId = asString(params?.runId);
				const artifact = runId ? readRunStatus(runId) : null;

				const sessionListRes = await fetchJsonSafe(
					`${serverUrl.replace(/\/$/, "")}/session`,
				);
				const sessionList = Array.isArray(sessionListRes.data)
					? sessionListRes.data
					: [];
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
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error:
											"Missing sessionId and could not resolve from run artifact/session list.",
									},
									null,
									2,
								),
							},
						],
					};
				}

				const limit = Math.max(
					1,
					asNumber(params?.limit) || DEFAULT_TAIL_LIMIT,
				);
				const includeDiff = params?.includeDiff !== false;

				const [messagesRes, diffRes, sessionRes] = await Promise.all([
					fetchJsonSafe(
						`${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message`,
					),
					includeDiff
						? fetchJsonSafe(
								`${serverUrl.replace(/\/$/, "")}/session/${sessionId}/diff`,
							)
						: Promise.resolve({ ok: false, data: undefined }),
					fetchJsonSafe(`${serverUrl.replace(/\/$/, "")}/session/${sessionId}`),
				]);

				const rawMessages = Array.isArray(messagesRes.data)
					? messagesRes.data
					: [];
				const tail = rawMessages
					.slice(Math.max(0, rawMessages.length - limit))
					.map((msg: any, idx: number) => {
						const info = msg?.info || {};
						const parts = Array.isArray(msg?.parts) ? msg.parts : [];
						const text = parts
							.filter(
								(p: any) => p?.type === "text" && typeof p?.text === "string",
							)
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
					...(artifact?.envelope?.project_id
						? { projectId: artifact.envelope.project_id }
						: {}),
					...(artifact?.envelope?.repo_root
						? { repoRoot: artifact.envelope.repo_root }
						: {}),
					resolvedFrom:
						resolution.strategy === "explicit_session_id"
							? "explicit_session_id"
							: artifact?.sessionId || artifact?.opencodeSessionId
								? "artifact_session_id"
								: artifact?.envelope?.callback_target_session_key
									? "callback_target"
									: resolution.strategy.includes("project")
										? "project_filtered_fallback"
										: "scored_fallback",
					correlation: {
						sessionResolution: {
							strategy: resolution.strategy,
							...(resolution.score !== undefined
								? { score: resolution.score }
								: {}),
						},
					},
					limit,
					totalMessages: rawMessages.length,
					messages: tail,
					...(artifact?.continuation
						? { continuation: artifact.continuation }
						: {}),
					...(includeDiff ? { diff: diffRes.data } : {}),
					latestSummary: sessionRes.data,
					fetchedAt: new Date().toISOString(),
				};

				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_serve_spawn",
			label: "OpenCode Serve Spawn",
			description:
				"Bật một opencode serve riêng cho project, tự cấp port động và ghi registry entry tương ứng.",
			parameters: {
				type: "object",
				properties: {
					project_id: { type: "string" },
					repo_root: { type: "string" },
					idle_timeout_ms: { type: "number" },
				},
				required: ["project_id", "repo_root"],
			},
			async execute(_id: string, params: any) {
				const opportunisticCleanup = await cleanupExpiredServes();
				const result = await spawnServeForProject({
					project_id: params.project_id,
					repo_root: params.repo_root,
					idle_timeout_ms: asNumber(params.idle_timeout_ms),
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: true, opportunisticCleanup, ...result },
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_registry_get",
			label: "OpenCode Registry Get",
			description:
				"Đọc session-centric registry hiện tại của OpenCode bridge để xem serve registry và session registry.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const serveRegistry = readServeRegistry();
				const sessionRegistry = readSessionRegistry();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									servePath: getServeRegistryPath(),
									sessionPath: getSessionRegistryPath(),
									serveRegistry,
									sessionRegistry,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_registry_upsert",
			label: "OpenCode Registry Upsert",
			description:
				"Ghi hoặc cập nhật một serve registry entry cho project hiện tại (1 project = 1 serve).",
			parameters: {
				type: "object",
				properties: {
					serve_id: { type: "string" },
					opencode_server_url: { type: "string" },
					pid: { type: "number" },
					status: { type: "string", enum: ["running", "stopped", "unknown"] },
					last_event_at: { type: "string" },
					idle_timeout_ms: { type: "number" },
				},
				required: ["serve_id", "opencode_server_url"],
			},
			async execute(_id: string, params: any) {
				const entry: ServeRegistryEntry = {
					serve_id: params.serve_id,
					opencode_server_url: params.opencode_server_url,
					...(params.pid !== undefined ? { pid: Number(params.pid) } : {}),
					...(params.status ? { status: params.status } : {}),
					...(params.last_event_at
						? { last_event_at: params.last_event_at }
						: {}),
					...(params.idle_timeout_ms !== undefined
						? { idle_timeout_ms: Number(params.idle_timeout_ms) }
						: {}),
					updated_at: new Date().toISOString(),
				};
				const result = upsertServeRegistry(entry);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									path: result.path,
									entry,
									registry: result.registry,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_registry_cleanup",
			label: "OpenCode Registry Cleanup",
			description:
				"Cleanup/normalize serve + session registry theo schema session-centric hiện tại.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const beforeServes = readServeRegistry();
				const beforeSessions = readSessionRegistry();
				const normalizedServes = normalizeServeRegistry(beforeServes);
				const normalizedSessions = normalizeSessionRegistry(beforeSessions);
				const servePath = writeServeRegistryFile(normalizedServes);
				const sessionPath = writeSessionRegistryFile(normalizedSessions);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									servePath,
									sessionPath,
									beforeServes,
									afterServes: normalizedServes,
									beforeSessions,
									afterSessions: normalizedSessions,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_serve_shutdown",
			label: "OpenCode Serve Shutdown",
			description:
				"Đánh dấu stopped và gửi SIGTERM cho serve theo serve_id hoặc server URL nếu registry có pid.",
			parameters: {
				type: "object",
				properties: {
					project_id: { type: "string" },
					serve_id: { type: "string" },
				},
				required: [],
			},
			async execute(_id: string, params: any) {
				const target = asString(params.serve_id) || asString(params.project_id);
				const registry = normalizeServeRegistry(readServeRegistry());
				const entry = registry.entries.find(
					(x) => x.serve_id === target || x.opencode_server_url === target,
				);
				if (!entry) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{ ok: false, error: "Project entry not found" },
									null,
									2,
								),
							},
						],
					};
				}
				const result = shutdownServe(entry);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					...(result.ok ? {} : { isError: true }),
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_process_audit",
			label: "OpenCode Process Audit",
			description:
				"Classify OpenCode processes into active/orphan/stale buckets for shared-serve runtime hygiene.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const registry = normalizeServeRegistry(readServeRegistry());
				const activeServePids = new Set(
					registry.entries
						.filter(
							(entry) =>
								entry.status === "running" && typeof entry.pid === "number",
						)
						.map((entry) => entry.pid as number),
				);
				const runStatuses = listRunStatuses();
				const activeAttachPids = new Map<number, BridgeRunStatus>();
				for (const run of runStatuses) {
					const pid = run.attachRun?.pid;
					if (typeof pid === "number") activeAttachPids.set(pid, run);
				}
				const processes = listLiveOpencodeServeProcesses();
				const serveProcesses = processes.map(
					(item: { pid: number; serverUrl: string }) => ({
						pid: item.pid,
						serverUrl: item.serverUrl,
						class: activeServePids.has(item.pid)
							? "active_serve"
							: "orphan_serve",
					}),
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
									activeServeRegistry: registry.entries,
									serveProcesses,
									attachRunArtifacts: runStatuses.map((run) => ({
										runId: run.runId,
										state: run.state,
										pid: run.attachRun?.pid,
										repoRoot: run.envelope.repo_root,
										serverUrl: run.envelope.opencode_server_url,
										classification:
											typeof run.attachRun?.pid === "number"
												? run.state === "running" ||
													run.state === "queued" ||
													run.state === "planning" ||
													run.state === "awaiting_permission" ||
													run.state === "stalled"
													? "active_attach_run"
													: "stale_attach_run"
												: "no_pid",
									})),
								},
								null,
								2,
							),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_process_cleanup",
			label: "OpenCode Process Cleanup",
			description:
				"Dry-run/apply cleanup for orphan serves and stale/orphan attach-run processes.",
			parameters: {
				type: "object",
				properties: {
					apply: { type: "boolean" },
				},
			},
			async execute(_id: string, params: any) {
				const apply = params?.apply === true;
				const registry = normalizeServeRegistry(readServeRegistry());
				const activeServePids = new Set(
					registry.entries
						.filter(
							(entry) =>
								entry.status === "running" && typeof entry.pid === "number",
						)
						.map((entry) => entry.pid as number),
				);
				const runStatuses = listRunStatuses();
				const keepAttachPids = new Set<number>();
				for (const run of runStatuses) {
					const pid = run.attachRun?.pid;
					if (
						typeof pid === "number" &&
						(run.state === "running" ||
							run.state === "queued" ||
							run.state === "planning" ||
							run.state === "awaiting_permission" ||
							run.state === "stalled")
					) {
						keepAttachPids.add(pid);
					}
				}
				const ps = execSync("ps -axo pid,command", {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				const actions: any[] = [];
				const selfPid = process.pid;
				const parentPid = process.ppid;
				for (const line of ps.split("\n")) {
					const match = line.trim().match(/^(\d+)\s+(.*)$/);
					if (!match) continue;
					const pid = Number(match[1]);
					const cmd = match[2];
					if (pid === selfPid || pid === parentPid) continue;
					if (cmd.startsWith("opencode serve --hostname 127.0.0.1 --port")) {
						if (!activeServePids.has(pid)) {
							actions.push({
								pid,
								kind: "orphan_serve",
								action: apply ? "killed" : "would_kill",
							});
							if (apply) {
								try {
									process.kill(pid, "SIGTERM");
								} catch {}
							}
						}
					} else if (cmd.startsWith("opencode run --attach")) {
						if (!keepAttachPids.has(pid)) {
							actions.push({
								pid,
								kind: "orphan_or_stale_attach_run",
								action: apply ? "killed" : "would_kill",
							});
							if (apply) {
								try {
									process.kill(pid, "SIGTERM");
								} catch {}
							}
						}
					}
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, apply, actions }, null, 2),
						},
					],
				};
			},
		},
		{ optional: true },
	);

	api.registerTool(
		{
			name: "opencode_serve_idle_check",
			label: "OpenCode Serve Idle Check",
			description:
				"Đánh giá một serve registry entry có nên shutdown theo idle timeout hay chưa.",
			parameters: {
				type: "object",
				properties: {
					project_id: { type: "string" },
					serve_id: { type: "string" },
					nowMs: { type: "number" },
				},
				required: [],
			},
			async execute(_id: string, params: any) {
				const target = asString(params.serve_id) || asString(params.project_id);
				const registry = normalizeServeRegistry(readServeRegistry());
				const entry = registry.entries.find(
					(x) => x.serve_id === target || x.opencode_server_url === target,
				);
				if (!entry) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{ ok: false, error: "Project entry not found" },
									null,
									2,
								),
							},
						],
					};
				}
				const evaluation = evaluateServeIdle(entry, asNumber(params.nowMs));
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, entry, evaluation }, null, 2),
						},
					],
				};
			},
		},
		{ optional: true },
	);
}
