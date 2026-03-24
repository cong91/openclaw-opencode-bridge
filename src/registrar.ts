import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventScope } from "./observability";
import { summarizeLifecycle } from "./observability";
import {
	asNumber,
	asString,
	buildEnvelope,
	buildHookPolicyChecklist,
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
	listRunStatuses,
	normalizeRegistry,
	normalizeServeRegistry,
	readRunStatus,
	readServeRegistry,
	resolveExecutionAgent,
	resolveServerUrl,
	resolveSessionForRun,
	shutdownServe,
	spawnServeForProject,
	startExecutionRun,
	upsertServeRegistry,
	cleanupExpiredServes,
	writeServeRegistryFile,
} from "./runtime";
import { OPENCODE_CALLBACK_HTTP_PATH } from "./shared-contracts";
import type { OpenCodeContinuationCallbackMetadata } from "./types";
import type {
	BridgeRunStatus,
	OpenCodeRunContinuation,
	RunEventsResponse,
	RunStatusResponse,
	ServeRegistryEntry,
	SessionTailMessage,
	SessionTailResponse,
} from "./types";

const PLUGIN_VERSION = "0.1.6";

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


function parseOpencodeCallbackPayload(raw: string): {
	ok: true;
	body: {
		message: string;
		name?: string;
		agentId?: string;
		sessionKey: string;
		sessionId?: string;
		wakeMode?: "now" | "next-heartbeat";
		deliver?: boolean;
	};
	metadata: OpenCodeContinuationCallbackMetadata | null;
} | {
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
	const message = typeof parsed?.message === "string" ? parsed.message : undefined;
	if (!sessionKey) return { ok: false, error: "sessionKey required" };
	if (!message) return { ok: false, error: "message required" };
	let metadata: OpenCodeContinuationCallbackMetadata | null = null;
	try {
		const typed = JSON.parse(message);
		if (typed && typeof typed === "object" && typed.kind === "opencode.callback") {
			metadata = typed as OpenCodeContinuationCallbackMetadata;
		}
	} catch {}
	return {
		ok: true,
		body: {
			message,
			...(asString(parsed?.name) ? { name: asString(parsed?.name) } : {}),
			...(asString(parsed?.agentId) ? { agentId: asString(parsed?.agentId) } : {}),
			sessionKey,
			...(asString(parsed?.sessionId) ? { sessionId: asString(parsed?.sessionId) } : {}),
			wakeMode:
				parsed?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now",
			deliver: parsed?.deliver === true,
		},
		metadata,
	};
}

function registerCallbackIngressRoute(api: any, cfg: any) {
	if (
		typeof api?.registerHttpRoute !== "function" ||
		typeof api?.runtime?.system?.enqueueSystemEvent !== "function" ||
		typeof api?.runtime?.system?.requestHeartbeatNow !== "function"
	) {
		return;
	}
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
			const expectedToken = asString(cfg?.hookToken) || asString(runtimeCfg.hookToken);
			const authz = req.headers.authorization;
			const bearer = typeof authz === "string" && authz.startsWith("Bearer ")
				? authz.slice("Bearer ".length).trim()
				: undefined;
			if (!expectedToken || !bearer || bearer !== expectedToken) {
				sendJson(res, 401, { ok: false, error: "unauthorized" });
				return true;
			}
			const bodyText = await readRequestBody(req);
			const parsed = parseOpencodeCallbackPayload(bodyText);
			if (!parsed.ok) {
				sendJson(res, 400, { ok: false, error: parsed.error });
				return true;
			}
			const callback = parsed.body;
			const dedupeKey = parsed.metadata?.runId && parsed.metadata?.eventType
				? `opencode:${parsed.metadata.runId}:${parsed.metadata.eventType}`
				: undefined;
			api.runtime.system.enqueueSystemEvent(callback.message, {
				sessionKey: callback.sessionKey,
				...(dedupeKey ? { contextKey: dedupeKey } : {}),
			});
			if (callback.deliver === true) {
				const ackText = parsed.metadata
					? `OpenCode callback received for run ${parsed.metadata.runId || "unknown-run"}; continuing processing in this session.`
					: "OpenCode callback received; continuing processing in this session.";
				api.runtime.system.enqueueSystemEvent(ackText, {
					sessionKey: callback.sessionKey,
					...(dedupeKey ? { contextKey: `${dedupeKey}:visible-ack` } : {}),
				});
				appendCallbackDebugAudit({
					phase: "visible_ack_enqueued",
					sessionKey: callback.sessionKey,
					dedupeKey,
					runId: parsed.metadata?.runId || null,
					ackText,
				});
			}
			if ((callback.wakeMode || "now") === "now") {
				api.runtime.system.requestHeartbeatNow({
					reason: dedupeKey || "opencode-callback",
				});
			}
			appendCallbackDebugAudit({
				phase: "callback_enqueued",
				sessionKey: callback.sessionKey,
				dedupeKey,
				runId: parsed.metadata?.runId || null,
				eventType: parsed.metadata?.eventType || null,
				deliver: callback.deliver === true,
			});
			sendJson(res, 200, {
				ok: true,
				routed: {
					sessionKey: callback.sessionKey,
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
		constraints.length
			? `Constraints:\n- ${constraints.join("\n- ")}`
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
				"Kiểm tra checklist/policy tối thiểu cho callback `/hooks/agent` với agentId và sessionKey cụ thể.",
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
				const opportunisticCleanup = cleanupExpiredServes();
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

				const spawned = await spawnServeForProject({
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
				const continuation = continuationEnabled
					? {
							...(workflowId ? { workflowId } : {}),
							...(stepId ? { stepId } : {}),
							callbackEventKind: "opencode.callback" as const,
							...(nextOnSuccess ? { nextOnSuccess } : {}),
							...(nextOnFailure ? { nextOnFailure } : {}),
						}
					: undefined;
				const execution = await startExecutionRun({
					cfg,
					envelope,
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
									envelope,
									prompt,
									execution: {
										ok: execution.ok,
										runId: execution.runId,
										taskId: execution.taskId,
										sessionId: execution.sessionId,
										state: execution.state,
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
				const state =
					(lifecycleSummary.currentState as any) ||
					artifact?.state ||
					(sessionId ? "running" : "queued");

				const response: RunStatusResponse = {
					ok: true,
					source: {
						runArtifact: Boolean(artifact),
						opencodeApi: true,
					},
					runId: runId || undefined,
					taskId: artifact?.taskId,
					projectId: artifact?.envelope?.project_id,
					sessionId,
					correlation: {
						sessionResolution: {
							strategy: resolution.strategy,
							...(resolution.score !== undefined
								? { score: resolution.score }
								: {}),
						},
					},
					state,
					currentState: (lifecycleSummary.currentState as any) || state,
					current_state: (lifecycleSummary.currentState as any) || state,
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
				const response: RunEventsResponse = {
					ok: true,
					...(runId ? { runId } : {}),
					...(artifact?.taskId ? { taskId: artifact.taskId } : {}),
					...(sessionId ? { sessionId } : {}),
					correlation: {
						sessionResolution: {
							strategy: resolution.strategy,
							...(resolution.score !== undefined
								? { score: resolution.score }
								: {}),
						},
					},
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
				const opportunisticCleanup = cleanupExpiredServes();
				const result = await spawnServeForProject({
					project_id: params.project_id,
					repo_root: params.repo_root,
					idle_timeout_ms: asNumber(params.idle_timeout_ms),
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, opportunisticCleanup, ...result }, null, 2),
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
				"Đọc serve registry hiện tại của OpenCode bridge để xem mapping project -> serve URL -> pid -> status.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const registry = readServeRegistry();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: true, path: getServeRegistryPath(), registry },
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
					project_id: { type: "string" },
					repo_root: { type: "string" },
					opencode_server_url: { type: "string" },
					pid: { type: "number" },
					status: { type: "string", enum: ["running", "stopped", "unknown"] },
					last_event_at: { type: "string" },
					idle_timeout_ms: { type: "number" },
				},
				required: ["project_id", "repo_root", "opencode_server_url"],
			},
			async execute(_id: string, params: any) {
				const entry: ServeRegistryEntry = {
					project_id: params.project_id,
					repo_root: params.repo_root,
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
				"Cleanup/normalize serve registry: loại bỏ entry không đủ field hoặc normalize schema lưu trữ hiện tại.",
			parameters: { type: "object", properties: {} },
			async execute() {
				const before = readServeRegistry();
				const normalized = normalizeServeRegistry(before);
				const path = writeServeRegistryFile(normalized);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ok: true, path, before, after: normalized },
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
				"Đánh dấu stopped và gửi SIGTERM cho serve của một project nếu registry có pid.",
			parameters: {
				type: "object",
				properties: { project_id: { type: "string" } },
				required: ["project_id"],
			},
			async execute(_id: string, params: any) {
				const registry = normalizeServeRegistry(readServeRegistry());
				const entry = registry.entries.find(
					(x) => x.project_id === params.project_id,
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
			name: "opencode_serve_idle_check",
			label: "OpenCode Serve Idle Check",
			description:
				"Đánh giá một serve registry entry có nên shutdown theo idle timeout hay chưa.",
			parameters: {
				type: "object",
				properties: {
					project_id: { type: "string" },
					nowMs: { type: "number" },
				},
				required: ["project_id"],
			},
			async execute(_id: string, params: any) {
				const registry = normalizeServeRegistry(readServeRegistry());
				const entry = registry.entries.find(
					(x) => x.project_id === params.project_id,
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
