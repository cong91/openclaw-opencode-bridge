import { spawn, execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
	type EventScope,
	normalizeTypedEventV1,
	type OpenCodeEventKind,
	parseSseFramesFromBuffer,
	resolveSessionId,
	summarizeLifecycle,
} from "./observability";
import { buildTaggedSessionTitle, OPENCODE_CALLBACK_HTTP_PATH } from "./shared-contracts";
import type {
	BridgeConfigFile,
	BridgeLifecycleState,
	BridgeRunStatus,
	CallbackAuditRecord,
	HooksAgentCallbackPayload,
	OpenCodeContinuationCallbackMetadata,
	OpenCodeRunContinuation,
	ProjectRegistryEntry,
	RoutingEnvelope,
	RunEventRecord,
	ServeRegistryEntry,
	ServeRegistryFile,
	SessionRegistryEntry,
	SessionRegistryFile,
} from "./types";

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SOFT_STALL_MS = 60 * 1000;
export const DEFAULT_HARD_STALL_MS = 180 * 1000;
export const DEFAULT_OBS_TIMEOUT_MS = 3000;
export const DEFAULT_TAIL_LIMIT = 20;
export const DEFAULT_EVENT_LIMIT = 10;
export const HOOK_PREFIX = "hook:opencode:";

export function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

export function buildSessionKey(agentId: string, taskId: string): string {
	return `${HOOK_PREFIX}${agentId}:${taskId}`;
}

export function getBridgeStateDir(): string {
	const stateDir =
		process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
	return join(stateDir, "opencode-bridge");
}

export function getBridgeConfigPath(): string {
	return join(getBridgeStateDir(), "config.json");
}

export function ensureBridgeConfigFile(): BridgeConfigFile {
	const dir = getBridgeStateDir();
	mkdirSync(dir, { recursive: true });
	const path = getBridgeConfigPath();
	if (!existsSync(path)) {
		const initial: BridgeConfigFile = {
			opencodeServerUrl: "http://127.0.0.1:4096",
			projectRegistry: [],
		};
		writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");
		return initial;
	}
	return JSON.parse(readFileSync(path, "utf8")) as BridgeConfigFile;
}

export function writeBridgeConfigFile(data: BridgeConfigFile) {
	const path = getBridgeConfigPath();
	mkdirSync(getBridgeStateDir(), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
	return path;
}

export function getRuntimeConfig(cfg: any): BridgeConfigFile {
	const fileCfg = ensureBridgeConfigFile();
	return {
		opencodeServerUrl: fileCfg.opencodeServerUrl || cfg?.opencodeServerUrl,
		projectRegistry: fileCfg.projectRegistry || cfg?.projectRegistry || [],
		executionAgentMappings:
			fileCfg.executionAgentMappings || cfg?.executionAgentMappings || [],
		hookBaseUrl: fileCfg.hookBaseUrl || cfg?.hookBaseUrl,
		hookToken: fileCfg.hookToken || cfg?.hookToken,
	};
}

export function normalizeRegistry(raw: unknown): ProjectRegistryEntry[] {
	return asArray(raw)
		.map((item) => {
			const obj =
				item && typeof item === "object"
					? (item as Record<string, unknown>)
					: {};
			const projectId = asString(obj.projectId);
			const repoRoot = asString(obj.repoRoot);
			const serverUrl = asString(obj.serverUrl);
			const idleTimeoutMs = Number(
				obj.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS,
			);
			if (!projectId || !repoRoot || !serverUrl) return null;
			return {
				projectId,
				repoRoot,
				serverUrl,
				idleTimeoutMs: Number.isFinite(idleTimeoutMs)
					? idleTimeoutMs
					: DEFAULT_IDLE_TIMEOUT_MS,
			};
		})
		.filter(Boolean) as ProjectRegistryEntry[];
}

export function findRegistryEntry(
	cfg: any,
	projectId?: string,
	repoRoot?: string,
): ProjectRegistryEntry | undefined {
	const runtimeCfg = getRuntimeConfig(cfg);
	const dynamicRegistry = normalizeServeRegistry(
		readServeRegistry(),
	).entries.map((x) => ({
		projectId: undefined,
		repoRoot: undefined,
		serverUrl: x.opencode_server_url,
		idleTimeoutMs: x.idle_timeout_ms,
	}));
	const registry = [
		...dynamicRegistry,
		...normalizeRegistry(runtimeCfg.projectRegistry),
	].filter(Boolean) as ProjectRegistryEntry[];
	if (projectId) {
		const byProject = registry.find((x) => x.projectId === projectId);
		if (byProject) return byProject;
	}
	if (repoRoot) {
		const byRoot = registry.find((x) => x.repoRoot === repoRoot);
		if (byRoot) return byRoot;
	}
	return undefined;
}

export function resolveExecutionAgent(input: {
	cfg: any;
	requestedAgentId: string;
	explicitExecutionAgentId?: string;
}):
	| {
			ok: true;
			requestedAgentId: string;
			resolvedAgentId: string;
			strategy: "explicit_param" | "config_mapping" | "identity";
			executionAgentExplicit?: boolean;
	  }
	| {
			ok: false;
			requestedAgentId: string;
			error: string;
			mappingConfigured: boolean;
	  } {
	const requestedAgentId = asString(input.requestedAgentId);
	if (!requestedAgentId) {
		return {
			ok: false,
			requestedAgentId: "",
			mappingConfigured: false,
			error: "requestedAgentId is required",
		};
	}

	const explicitExecutionAgentId = asString(input.explicitExecutionAgentId);
	if (explicitExecutionAgentId) {
		return {
			ok: true,
			requestedAgentId,
			resolvedAgentId: explicitExecutionAgentId,
			strategy: "explicit_param",
		};
	}

	const runtimeCfg = getRuntimeConfig(input.cfg);
	const mappings = asArray(runtimeCfg.executionAgentMappings)
		.map((x) =>
			x && typeof x === "object" ? (x as Record<string, unknown>) : {},
		)
		.map((x) => ({
			requestedAgentId: asString(x.requestedAgentId),
			executionAgentId: asString(x.executionAgentId),
		}))
		.filter((x) => x.requestedAgentId && x.executionAgentId) as {
		requestedAgentId: string;
		executionAgentId: string;
	}[];

	if (mappings.length > 0) {
		const matched = mappings.find(
			(x) => x.requestedAgentId === requestedAgentId,
		);
		if (!matched) {
			return {
				ok: false,
				requestedAgentId,
				mappingConfigured: true,
				error: `Execution agent mapping is configured but no mapping matched requestedAgentId=${requestedAgentId}`,
			};
		}
		return {
			ok: true,
			requestedAgentId,
			resolvedAgentId: matched.executionAgentId,
			strategy: "config_mapping",
		};
	}

	return {
		ok: true,
		requestedAgentId,
		resolvedAgentId: requestedAgentId,
		strategy: "identity",
		executionAgentExplicit: false,
	};
}

export function buildEnvelope(input: {
	taskId: string;
	runId: string;
	requestedAgentId: string;
	resolvedAgentId: string;
	executionAgentExplicit?: boolean;
	originSessionKey: string;
	originSessionId?: string;
	projectId: string;
	repoRoot: string;
	serverUrl: string;
	channel?: string;
	to?: string;
	deliver?: boolean;
	priority?: string;
}): RoutingEnvelope {
	return {
		task_id: input.taskId,
		run_id: input.runId,
		agent_id: input.resolvedAgentId,
		requested_agent_id: input.requestedAgentId,
		resolved_agent_id: input.resolvedAgentId,
		...(input.executionAgentExplicit !== undefined
			? { execution_agent_explicit: input.executionAgentExplicit }
			: {}),
		session_key: buildSessionKey(input.resolvedAgentId, input.taskId),
		origin_session_key: input.originSessionKey,
		...(input.originSessionId
			? { origin_session_id: input.originSessionId }
			: {}),
		callback_target_session_key: input.originSessionKey,
		...(input.originSessionId
			? { callback_target_session_id: input.originSessionId }
			: {}),
		project_id: input.projectId,
		repo_root: input.repoRoot,
		opencode_server_url: input.serverUrl,
		...(input.channel ? { channel: input.channel } : {}),
		...(input.to ? { to: input.to } : {}),
		...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
		...(input.priority ? { priority: input.priority } : {}),
	};
}

export function mapEventToState(
	event: OpenCodeEventKind,
): BridgeLifecycleState {
	switch (event) {
		case "task.started":
			return "planning";
		case "task.progress":
			return "running";
		case "permission.requested":
			return "awaiting_permission";
		case "task.stalled":
			return "stalled";
		case "task.failed":
			return "failed";
		case "task.completed":
			return "completed";
		default:
			return "running";
	}
}

export function assertCallbackTargetSessionKey(
	envelope: RoutingEnvelope,
): string {
	const callbackTargetSessionKey = asString(
		(envelope as any)?.callback_target_session_key,
	);
	if (!callbackTargetSessionKey) {
		throw new Error(
			"Invalid routing envelope: missing callback_target_session_key (required for current-session callback integrity)",
		);
	}
	return callbackTargetSessionKey;
}

export function buildHooksAgentCallback(input: {
	event: OpenCodeEventKind;
	envelope: RoutingEnvelope;
	summary?: string;
}): HooksAgentCallbackPayload {
	const state = mapEventToState(input.event);
	const message =
		input.summary ||
		`OpenCode event=${input.event} state=${state} task=${input.envelope.task_id} run=${input.envelope.run_id} project=${input.envelope.project_id} requestedAgent=${input.envelope.requested_agent_id} resolvedAgent=${input.envelope.resolved_agent_id}`;

	const callbackTargetSessionKey = assertCallbackTargetSessionKey(
		input.envelope,
	);

	return {
		message,
		name: "OpenCode",
		// callback should wake requester/origin lane, not execution lane
		agentId: input.envelope.requested_agent_id,
		sessionKey: callbackTargetSessionKey,
		...(input.envelope.callback_target_session_id
			? { sessionId: input.envelope.callback_target_session_id }
			: {}),
		wakeMode: "now",
		deliver: false,
		...(input.envelope.channel ? { channel: input.envelope.channel } : {}),
		...(input.envelope.to ? { to: input.envelope.to } : {}),
	};
}

export function evaluateLifecycle(input: {
	lastEventKind?: OpenCodeEventKind | null;
	lastEventAtMs?: number;
	nowMs?: number;
	softStallMs?: number;
	hardStallMs?: number;
}) {
	const nowMs = input.nowMs ?? Date.now();
	const softStallMs = input.softStallMs ?? DEFAULT_SOFT_STALL_MS;
	const hardStallMs = input.hardStallMs ?? DEFAULT_HARD_STALL_MS;
	if (input.lastEventKind) {
		const state = mapEventToState(input.lastEventKind);
		return {
			state,
			escalateToMain: state === "failed" || state === "completed",
			needsPermissionHandling: state === "awaiting_permission",
			stallSeverity: null,
		};
	}
	if (!input.lastEventAtMs) {
		return {
			state: "queued" as BridgeLifecycleState,
			escalateToMain: false,
			needsPermissionHandling: false,
			stallSeverity: null,
		};
	}
	const age = nowMs - input.lastEventAtMs;
	if (age >= hardStallMs) {
		return {
			state: "stalled" as BridgeLifecycleState,
			escalateToMain: true,
			needsPermissionHandling: false,
			stallSeverity: "hard",
		};
	}
	if (age >= softStallMs) {
		return {
			state: "stalled" as BridgeLifecycleState,
			escalateToMain: false,
			needsPermissionHandling: false,
			stallSeverity: "soft",
		};
	}
	return {
		state: "running" as BridgeLifecycleState,
		escalateToMain: false,
		needsPermissionHandling: false,
		stallSeverity: null,
	};
}

export function getRunStateDir(): string {
	return join(getBridgeStateDir(), "runs");
}

export function writeRunStatus(status: BridgeRunStatus) {
	const dir = getRunStateDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${status.runId}.json`);
	writeFileSync(path, JSON.stringify(status, null, 2), "utf8");
	return path;
}

export function readRunStatus(runId: string): BridgeRunStatus | null {
	const path = join(getRunStateDir(), `${runId}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as BridgeRunStatus;
}

export function patchRunStatus(
	runId: string,
	patch:
		| Partial<BridgeRunStatus>
		| ((current: BridgeRunStatus) => BridgeRunStatus),
) {
	const current = readRunStatus(runId);
	if (!current) return null;
	const next =
		typeof patch === "function"
			? patch(current)
			: ({ ...current, ...patch } as BridgeRunStatus);
	writeRunStatus(next);
	return next;
}

export function listRunStatuses(): BridgeRunStatus[] {
	const dir = getRunStateDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			try {
				return JSON.parse(
					readFileSync(join(dir, name), "utf8"),
				) as BridgeRunStatus;
			} catch {
				return null;
			}
		})
		.filter(Boolean) as BridgeRunStatus[];
}

export function getAuditDir(): string {
	return join(getBridgeStateDir(), "audit");
}

export function appendAudit(record: CallbackAuditRecord) {
	const dir = getAuditDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "callbacks.jsonl");
	writeFileSync(path, JSON.stringify(record) + "\n", {
		encoding: "utf8",
		flag: "a",
	});
	return path;
}

export function getServeRegistryPath(): string {
	return join(getBridgeStateDir(), "serves.json");
}

export function getSessionRegistryPath(): string {
	return join(getBridgeStateDir(), "sessions.json");
}

export function readServeRegistry(): ServeRegistryFile {
	const path = getServeRegistryPath();
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf8")) as ServeRegistryFile;
	}
	return { entries: [] };
}

export function normalizeServeRegistry(
	registry: ServeRegistryFile,
): ServeRegistryFile {
	const entries = asArray(registry.entries)
		.map((entry) => {
			const e =
				entry && typeof entry === "object"
					? (entry as Record<string, unknown>)
					: {};
			const serve_id = asString(e.serve_id) || asString(e.opencode_server_url);
			const opencode_server_url = asString(e.opencode_server_url);
			if (!serve_id || !opencode_server_url) return null;
			return {
				serve_id,
				opencode_server_url,
				...(asNumber(e.pid) !== undefined ? { pid: asNumber(e.pid) } : {}),
				...(asString(e.status)
					? { status: asString(e.status) as ServeRegistryEntry["status"] }
					: {}),
				...(asString(e.last_event_at)
					? { last_event_at: asString(e.last_event_at) }
					: {}),
				idle_timeout_ms: asNumber(e.idle_timeout_ms) ?? DEFAULT_IDLE_TIMEOUT_MS,
				updated_at: asString(e.updated_at) || new Date().toISOString(),
			} as ServeRegistryEntry;
		})
		.filter(Boolean) as ServeRegistryEntry[];
	return { entries };
}

export function readSessionRegistry(): SessionRegistryFile {
	const path = getSessionRegistryPath();
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf8")) as SessionRegistryFile;
	}
	return { entries: [] };
}

export function normalizeSessionRegistry(
	registry: SessionRegistryFile,
): SessionRegistryFile {
	const entries = asArray(registry.entries)
		.map((entry) => {
			const e =
				entry && typeof entry === "object"
					? (entry as Record<string, unknown>)
					: {};
			const session_id = asString(e.session_id);
			const serve_id = asString(e.serve_id);
			const opencode_server_url = asString(e.opencode_server_url);
			const directory = asString(e.directory);
			if (!session_id || !serve_id || !opencode_server_url || !directory) return null;
			return {
				session_id,
				serve_id,
				opencode_server_url,
				directory,
				...(asString(e.project_id) ? { project_id: asString(e.project_id) } : {}),
				...(asString(e.session_title) ? { session_title: asString(e.session_title) } : {}),
				...(asString(e.session_updated_at) ? { session_updated_at: asString(e.session_updated_at) } : {}),
				...(asString(e.status) ? { status: asString(e.status) as SessionRegistryEntry["status"] } : {}),
				...(typeof e.is_current_for_directory === "boolean" ? { is_current_for_directory: e.is_current_for_directory } : {}),
				updated_at: asString(e.updated_at) || new Date().toISOString(),
			} as SessionRegistryEntry;
		})
		.filter(Boolean) as SessionRegistryEntry[];
	return { entries };
}

function compactServeRegistryLiveOnly(data: ServeRegistryFile): ServeRegistryFile {
	const normalized = normalizeServeRegistry(data);
	return {
		entries: normalized.entries.filter(
			(entry) => asString(entry.status) !== "stopped",
		),
	};
}

export function writeServeRegistryFile(data: ServeRegistryFile) {
	const path = getServeRegistryPath();
	writeFileSync(
		path,
		JSON.stringify(compactServeRegistryLiveOnly(data), null, 2),
		"utf8",
	);
	return path;
}

export function writeSessionRegistryFile(data: SessionRegistryFile) {
	const path = getSessionRegistryPath();
	writeFileSync(
		path,
		JSON.stringify(normalizeSessionRegistry(data), null, 2),
		"utf8",
	);
	return path;
}

export function upsertServeRegistry(entry: ServeRegistryEntry) {
	const registry = normalizeServeRegistry(readServeRegistry());
	const idx = registry.entries.findIndex(
		(x) => x.serve_id === entry.serve_id || x.opencode_server_url === entry.opencode_server_url,
	);
	if (idx >= 0) registry.entries[idx] = entry;
	else registry.entries.push(entry);
	if (entry.status === "running" || entry.status === "unknown") {
		registry.entries = registry.entries.filter(
			(x) => x.serve_id === entry.serve_id || x.opencode_server_url === entry.opencode_server_url,
		);
	}
	const path = writeServeRegistryFile(registry);
	return { path, registry: compactServeRegistryLiveOnly(registry) };
}

export function upsertSessionRegistry(entry: SessionRegistryEntry) {
	const registry = normalizeSessionRegistry(readSessionRegistry());
	for (const item of registry.entries) {
		if (item.serve_id === entry.serve_id && item.directory === entry.directory) {
			item.is_current_for_directory = false;
		}
	}
	const idx = registry.entries.findIndex(
		(x) => x.session_id === entry.session_id,
	);
	if (idx >= 0) registry.entries[idx] = entry;
	else registry.entries.push(entry);
	const path = writeSessionRegistryFile(registry);
	return { path, registry };
}

export function evaluateServeIdle(entry: ServeRegistryEntry, nowMs?: number) {
	const now = nowMs ?? Date.now();
	const last = entry.last_event_at ? Date.parse(entry.last_event_at) : NaN;
	const idleTimeoutMs = entry.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(last)) {
		return {
			shouldShutdown: false,
			idleMs: null,
			reason: "missing_last_event_at",
		};
	}
	const idleMs = now - last;
	return {
		shouldShutdown: idleMs >= idleTimeoutMs,
		idleMs,
		idleTimeoutMs,
		reason:
			idleMs >= idleTimeoutMs ? "idle_timeout_exceeded" : "within_idle_window",
	};
}

export async function allocatePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

export async function waitForHealth(serverUrl: string, timeoutMs = 10000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const r = await fetch(`${serverUrl}/global/health`);
			if (r.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

export async function fetchServeProjectBinding(serverUrl: string): Promise<{
	ok: boolean;
	directory?: string;
	project?: any;
	path?: any;
	session?: any;
	error?: string;
}> {
	const normalizedUrl = serverUrl.replace(/\/$/, "");
	const [projectRes, pathRes, sessionRes] = await Promise.all([
		fetchJsonSafe(`${normalizedUrl}/project/current`),
		fetchJsonSafe(`${normalizedUrl}/path`),
		fetchJsonSafe(`${normalizedUrl}/session`),
	]);

	const project = projectRes.ok ? projectRes.data : undefined;
	const path = pathRes.ok ? pathRes.data : undefined;
	const session = sessionRes.ok && Array.isArray(sessionRes.data)
		? sessionRes.data[0]
		: undefined;
	const directory =
		asString(project?.directory) ||
		asString(project?.path) ||
		asString(path?.directory) ||
		asString(path?.cwd) ||
		asString(path?.path);

	if (directory) {
		return { ok: true, directory, project, path, session };
	}

	return {
		ok: false,
		project,
		path,
		session,
		error:
			projectRes.error ||
			pathRes.error ||
			sessionRes.error ||
			"Could not determine serve project binding",
	};
}

export async function isServeBoundToRepo(
	serverUrl: string,
	repoRoot: string,
): Promise<boolean> {
	const binding = await fetchServeProjectBinding(serverUrl);
	return binding.ok && binding.directory === repoRoot;
}

export function getServeSpawnLockPath() {
	return join(getBridgeStateDir(), "serve-spawn.lock");
}

export function listLiveOpencodeServeProcesses(): Array<{ pid: number; serverUrl: string }> {
	try {
		const out = execSync("ps -axo pid,command | rg 'opencode serve --hostname 127.0.0.1 --port'", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.map((line: string) => line.trim())
			.filter(Boolean)
			.map((line: string) => {
				const match = line.match(/^(\d+)\s+.*--port\s+(\d+)/);
				if (!match) return null;
				const pid = Number(match[1]);
				const port = Number(match[2]);
				if (!Number.isFinite(pid) || !Number.isFinite(port)) return null;
				return { pid, serverUrl: `http://127.0.0.1:${port}` };
			})
			.filter(Boolean) as Array<{ pid: number; serverUrl: string }>;
	} catch {
		return [];
	}
}

async function withServeSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
	const lockPath = getServeSpawnLockPath();
	let fd: number | undefined;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			fd = openSync(lockPath, "wx");
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	if (fd === undefined) throw new Error("serve spawn lock timeout");
	try {
		return await fn();
	} finally {
		try { closeSync(fd); } catch {}
		try { unlinkSync(lockPath); } catch {}
	}
}

export async function spawnServeForProject(input: {
	project_id: string;
	repo_root: string;
	idle_timeout_ms?: number;
}) {
	return await withServeSpawnLock(async () => {
		const registry = normalizeServeRegistry(readServeRegistry());
		for (const existing of registry.entries) {
			if (existing.status !== "running") continue;
			const healthy = await waitForHealth(existing.opencode_server_url, 2000);
			if (!healthy) continue;
			return {
				reused: true,
				entry: existing,
				registryPath: getServeRegistryPath(),
				reuseStrategy: "registry_running",
			};
		}
		for (const live of listLiveOpencodeServeProcesses()) {
			const healthy = await waitForHealth(live.serverUrl, 2000);
			if (!healthy) continue;
			const entry: ServeRegistryEntry = {
				serve_id: live.serverUrl,
				opencode_server_url: live.serverUrl,
				pid: live.pid,
				status: "running",
				last_event_at: new Date().toISOString(),
				idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
				updated_at: new Date().toISOString(),
			};
			const result = upsertServeRegistry(entry);
			return { reused: true, adopted: true, entry, registryPath: result.path, reuseStrategy: "live_process_adopted" };
		}
		const port = await allocatePort();
		const runtimeCfg = getRuntimeConfig({});
		const child = spawn(
			"opencode",
			["serve", "--hostname", "127.0.0.1", "--port", String(port)],
			{
				cwd: input.repo_root,
				detached: true,
				stdio: "ignore",
				env: {
					...process.env,
					...(runtimeCfg.hookBaseUrl
						? { OPENCLAW_HOOK_BASE_URL: runtimeCfg.hookBaseUrl }
						: {}),
					...(runtimeCfg.hookToken
						? { OPENCLAW_HOOK_TOKEN: runtimeCfg.hookToken }
						: {}),
				},
			},
		);
		child.unref();
		const serverUrl = `http://127.0.0.1:${port}`;
		const healthy = await waitForHealth(serverUrl, 10000);
		const entry: ServeRegistryEntry = {
			serve_id: serverUrl,
			opencode_server_url: serverUrl,
			pid: child.pid,
			status: healthy ? "running" : "unknown",
			last_event_at: new Date().toISOString(),
			idle_timeout_ms: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
			updated_at: new Date().toISOString(),
		};
		const result = upsertServeRegistry(entry);
		return { reused: false, entry, healthy, registryPath: result.path, reuseStrategy: "spawned_new" };
	});
}

export function markServeStopped(serveId: string) {
	const registry = normalizeServeRegistry(readServeRegistry());
	const entry = registry.entries.find((x) => x.serve_id === serveId || x.opencode_server_url === serveId);
	if (!entry) return { ok: false, error: "Serve entry not found" };
	entry.status = "stopped";
	entry.updated_at = new Date().toISOString();
	const path = writeServeRegistryFile(registry);
	return { ok: true, path, entry, registry };
}

export function shutdownServe(entry: ServeRegistryEntry) {
	if (entry.pid) {
		try {
			process.kill(entry.pid, "SIGTERM");
		} catch {}
	}
	return markServeStopped(entry.serve_id);
}

export async function cleanupExpiredServes(nowMs?: number) {
	const registry = normalizeServeRegistry(readServeRegistry());
	const results: Array<{
		project_id: string;
		status: string;
		reason: string;
		idleMs?: number | null;
		idleTimeoutMs?: number;
		runtimeState?: string;
	}> = [];
	for (const entry of registry.entries) {
		if (entry.status !== "running") continue;
		const evaluation = evaluateServeIdle(entry, nowMs);
		if (!evaluation.shouldShutdown) {
			results.push({
				project_id: entry.serve_id,
				status: entry.status,
				reason: evaluation.reason,
				idleMs: evaluation.idleMs,
				idleTimeoutMs: evaluation.idleTimeoutMs,
			});
			continue;
		}

		const sessionStatus = await fetchJsonSafe(
			`${entry.opencode_server_url.replace(/\/$/, "")}/session/status`,
		);
		const sessionList = await fetchJsonSafe(
			`${entry.opencode_server_url.replace(/\/$/, "")}/session`,
		);
		const statusData = sessionStatus.ok && sessionStatus.data && typeof sessionStatus.data === "object"
			? (sessionStatus.data as Record<string, any>)
			: {};
		const sessions = sessionList.ok && Array.isArray(sessionList.data) ? sessionList.data : [];
		const hasBusySession = sessions.some((session: any) => {
			const sid = asString(session?.id);
			const state = sid ? statusData[sid] : undefined;
			return state && typeof state === "object" && asString((state as any).type) === "busy";
		});
		if (hasBusySession) {
			results.push({
				project_id: entry.serve_id,
				status: entry.status,
				reason: "runtime_busy_session_detected",
				idleMs: evaluation.idleMs,
				idleTimeoutMs: evaluation.idleTimeoutMs,
				runtimeState: "busy",
			});
			continue;
		}

		shutdownServe(entry);
		results.push({
			project_id: entry.serve_id,
			status: "stopped",
			reason: evaluation.reason,
			idleMs: evaluation.idleMs,
			idleTimeoutMs: evaluation.idleTimeoutMs,
			runtimeState: "idle_or_unknown",
		});
	}
	return {
		ok: true,
		checked: results.length,
		stopped: results.filter((x) => x.status === "stopped").length,
		results,
		registryPath: getServeRegistryPath(),
	};
}

export async function fetchSseEvents(
	serverUrl: string,
	options?: { maxEvents?: number; timeoutMs?: number },
) {
	const maxEvents = options?.maxEvents ?? 1;
	const timeoutMs = options?.timeoutMs ?? 3000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(
			`${serverUrl.replace(/\/$/, "")}/global/event`,
			{
				headers: { Accept: "text/event-stream" },
				signal: controller.signal,
			},
		);
		if (!response.ok || !response.body) {
			throw new Error(`SSE request failed with status ${response.status}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const lines: string[] = [];
		while (lines.length < maxEvents) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() || "";
			for (const line of parts) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				lines.push(trimmed);
				if (lines.length >= maxEvents) break;
			}
		}
		try {
			controller.abort();
		} catch {}
		try {
			await reader.cancel();
		} catch {}
		return lines;
	} catch (error: any) {
		if (error?.name === "AbortError") {
			return [];
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export function resolveServerUrl(cfg: any, params?: any): string {
	return (
		asString(params?.opencodeServerUrl) ||
		asString(params?.serverUrl) ||
		getRuntimeConfig(cfg).opencodeServerUrl ||
		"http://127.0.0.1:4096"
	);
}

export async function fetchJsonSafe(
	url: string,
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
	try {
		const response = await fetch(url);
		const text = await response.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			data = text;
		}
		return { ok: response.ok, status: response.status, data };
	} catch (error: any) {
		return { ok: false, error: error?.message || String(error) };
	}
}

export function resolveSessionForRun(input: {
	sessionId?: string;
	runStatus?: BridgeRunStatus | null;
	sessionList?: any[];
	runId?: string;
}): { sessionId?: string; strategy: string; score?: number } {
	const artifactEnvelope = input.runStatus?.envelope as any;

	// Prefer callback/origin correlation over execution lane keys to preserve
	// "current caller session" integrity when resolving observability surfaces.
	const callbackTargetSessionId =
		typeof artifactEnvelope?.callback_target_session_id === "string"
			? artifactEnvelope.callback_target_session_id
			: undefined;
	const originSessionId =
		typeof artifactEnvelope?.origin_session_id === "string"
			? artifactEnvelope.origin_session_id
			: undefined;

	const callbackTargetSessionKey =
		typeof artifactEnvelope?.callback_target_session_key === "string"
			? artifactEnvelope.callback_target_session_key
			: undefined;
	const originSessionKey =
		typeof artifactEnvelope?.origin_session_key === "string"
			? artifactEnvelope.origin_session_key
			: undefined;
	const executionSessionKey =
		typeof artifactEnvelope?.session_key === "string"
			? artifactEnvelope.session_key
			: undefined;

	const artifactSessionId =
		callbackTargetSessionId ||
		originSessionId ||
		(typeof artifactEnvelope?.session_id === "string"
			? artifactEnvelope.session_id
			: undefined) ||
		(typeof artifactEnvelope?.sessionId === "string"
			? artifactEnvelope.sessionId
			: undefined);

	const artifactSessionKey =
		callbackTargetSessionKey || originSessionKey || executionSessionKey;
	const artifactRepoRoot =
		typeof artifactEnvelope?.repo_root === "string"
			? artifactEnvelope.repo_root
			: undefined;
	const artifactProjectId =
		typeof artifactEnvelope?.project_id === "string"
			? artifactEnvelope.project_id
			: undefined;

	// When callback target key is available, avoid biasing scored fallback toward
	// execution lane sessions via runId/taskId tokens.
	const hasCallerSessionKey = Boolean(
		callbackTargetSessionKey || originSessionKey,
	);

	const filteredSessionList = Array.isArray(input.sessionList)
		? input.sessionList.filter((session: any) => {
			if (artifactRepoRoot && JSON.stringify(session || {}).includes(artifactRepoRoot)) return true;
			if (artifactProjectId && JSON.stringify(session || {}).includes(artifactProjectId)) return true;
			if (artifactSessionId && asString(session?.id) === artifactSessionId) return true;
			if (artifactSessionKey && JSON.stringify(session || {}).includes(artifactSessionKey)) return true;
			return !artifactRepoRoot && !artifactProjectId;
		})
		: [];
	const resolved = resolveSessionId({
		explicitSessionId: input.sessionId,
		runId: hasCallerSessionKey
			? undefined
			: input.runId || input.runStatus?.runId,
		taskId: hasCallerSessionKey ? undefined : input.runStatus?.taskId,
		sessionKey: artifactSessionKey,
		artifactSessionId,
		repoRoot: artifactRepoRoot,
		projectId: artifactProjectId,
		sessionList: filteredSessionList,
	});
	return {
		sessionId: resolved.sessionId,
		strategy: resolved.strategy,
		...(resolved.score !== undefined ? { score: resolved.score } : {}),
	};
}

export async function collectSseEvents(
	serverUrl: string,
	scope: EventScope,
	options?: {
		limit?: number;
		timeoutMs?: number;
		runIdHint?: string;
		taskIdHint?: string;
		sessionIdHint?: string;
	},
): Promise<RunEventRecord[]> {
	const eventPath = scope === "session" ? "/event" : "/global/event";
	const limit = Math.max(1, asNumber(options?.limit) || DEFAULT_EVENT_LIMIT);
	const timeoutMs = Math.max(
		200,
		asNumber(options?.timeoutMs) || DEFAULT_OBS_TIMEOUT_MS,
	);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const events: RunEventRecord[] = [];
	try {
		const response = await fetch(
			`${serverUrl.replace(/\/$/, "")}${eventPath}`,
			{
				headers: { Accept: "text/event-stream" },
				signal: controller.signal,
			},
		);
		if (!response.ok || !response.body) return events;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (events.length < limit) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			const parsed = parseSseFramesFromBuffer(buffer);
			buffer = parsed.remainder;

			for (const frame of parsed.frames) {
				const typed = normalizeTypedEventV1(frame, scope);
				events.push({
					index: events.length,
					scope,
					rawLine: frame.raw,
					data: typed.payload,
					normalizedKind: typed.kind,
					summary: typed.summary,
					lifecycle_state: typed.lifecycleState,
					files_changed: typed.filesChanged,
					verify_summary: typed.verifySummary,
					blockers: typed.blockers,
					completion_summary: typed.completionSummary,
					runId: typed.runId || options?.runIdHint,
					taskId: typed.taskId || options?.taskIdHint,
					sessionId: typed.sessionId || options?.sessionIdHint,
					typedEvent: typed,
					timestamp: new Date().toISOString(),
				});
				if (events.length >= limit) break;
			}
		}

		if (events.length < limit && buffer.trim()) {
			const tail = parseSseFramesFromBuffer(`${buffer}\n\n`);
			for (const frame of tail.frames) {
				const typed = normalizeTypedEventV1(frame, scope);
				events.push({
					index: events.length,
					scope,
					rawLine: frame.raw,
					data: typed.payload,
					normalizedKind: typed.kind,
					summary: typed.summary,
					lifecycle_state: typed.lifecycleState,
					files_changed: typed.filesChanged,
					verify_summary: typed.verifySummary,
					blockers: typed.blockers,
					completion_summary: typed.completionSummary,
					runId: typed.runId || options?.runIdHint,
					taskId: typed.taskId || options?.taskIdHint,
					sessionId: typed.sessionId || options?.sessionIdHint,
					typedEvent: typed,
					timestamp: new Date().toISOString(),
				});
				if (events.length >= limit) break;
			}
		}

		try {
			controller.abort();
		} catch {}
		try {
			await reader.cancel();
		} catch {}
		return events;
	} catch {
		return events;
	} finally {
		clearTimeout(timeout);
	}
}

export async function executeHooksAgentCallback(
	hookBaseUrl: string,
	hookToken: string,
	callback: HooksAgentCallbackPayload,
) {
	const response = await fetch(
		`${hookBaseUrl.replace(/\/$/, "")}${OPENCODE_CALLBACK_HTTP_PATH}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${hookToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(callback),
		},
	);
	const text = await response.text();
	return {
		ok: response.ok,
		status: response.status,
		body: text,
	};
}

function coerceLifecycleState(
	value: string | undefined | null,
): BridgeLifecycleState {
	if (!value) return "running";
	if (
		value === "queued" ||
		value === "server_ready" ||
		value === "session_created" ||
		value === "prompt_sent" ||
		value === "planning" ||
		value === "coding" ||
		value === "verifying" ||
		value === "blocked" ||
		value === "running" ||
		value === "awaiting_permission" ||
		value === "stalled" ||
		value === "failed" ||
		value === "completed"
	) {
		return value;
	}
	return "running";
}


export function buildTaggedTitleForEnvelope(envelope: RoutingEnvelope): string {
	return buildTaggedSessionTitle({
		runId: envelope.run_id,
		taskId: envelope.task_id,
		requested: envelope.requested_agent_id,
		resolved: envelope.resolved_agent_id,
		callbackSession: envelope.callback_target_session_key,
		callbackSessionId: envelope.callback_target_session_id,
		callbackDeliver: envelope.deliver,
		projectId: envelope.project_id,
		repoRoot: envelope.repo_root,
	});
}

export async function createSessionForEnvelope(
	envelope: RoutingEnvelope,
): Promise<{ sessionId: string; created: any }> {
	const serverUrl = envelope.opencode_server_url.replace(/\/$/, "");
	const taggedTitle = buildTaggedTitleForEnvelope(envelope);
	const createdRes = await fetch(`${serverUrl}/session`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-opencode-directory": envelope.repo_root,
		},
		body: JSON.stringify({ title: taggedTitle }),
	});
	const createdText = await createdRes.text();
	let created: any;
	try {
		created = createdText ? JSON.parse(createdText) : null;
	} catch {
		created = { raw: createdText };
	}
	if (!createdRes.ok) {
		throw new Error(
			`session create failed: ${createdRes.status} ${createdText}`,
		);
	}
	const sessionId = asString(created?.id);
	if (!sessionId) {
		throw new Error("session create failed: missing session id");
	}
	return { sessionId, created };
}

function resolvePromptAsyncModel(model?: string) {
	const raw = asString(model);
	if (!raw) return undefined;
	const parts = raw.split("/");
	if (parts.length === 2 && parts[0] && parts[1]) {
		return { providerID: parts[0], modelID: parts[1] };
	}
	return { providerID: "proxy", modelID: raw };
}

function normalizeAttachRunModel(model?: string): string | undefined {
	const raw = asString(model);
	if (!raw) return undefined;
	if (raw.includes("/")) return raw;
	return `proxy/${raw}`;
}

function normalizePromptVariant(value: unknown): "medium" | "high" | undefined {
	const raw = asString(value)?.toLowerCase();
	if (raw === "high" || raw === "hard") return "high";
	if (raw === "medium") return "medium";
	return undefined;
}

function selectPromptVariant(input: {
	promptVariant?: unknown;
	priority?: unknown;
	objective?: unknown;
	prompt?: unknown;
	constraints?: unknown;
	acceptanceCriteria?: unknown;
}) {
	const explicit = normalizePromptVariant(input.promptVariant);
	if (explicit) return explicit;
	const priority = asString(input.priority)?.toLowerCase();
	if (priority === "high" || priority === "urgent" || priority === "critical") {
		return "high";
	}
	const objective = asString(input.objective) || "";
	const prompt = asString(input.prompt) || "";
	const constraintCount = Array.isArray(input.constraints) ? input.constraints.length : 0;
	const acceptanceCount = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.length : 0;
	const complexityScore =
		objective.length +
		prompt.length +
		constraintCount * 120 +
		acceptanceCount * 120;
	return complexityScore >= 900 ? "high" : "medium";
}

export async function promptAsyncForSession(input: {
	envelope: RoutingEnvelope;
	sessionId: string;
	prompt: string;
	model?: string;
	promptVariant?: "medium" | "high";
}) {
	const serverUrl = input.envelope.opencode_server_url.replace(/\/$/, "");
	const payload = {
		agent: input.envelope.resolved_agent_id,
		...(resolvePromptAsyncModel(input.model)
			? { model: resolvePromptAsyncModel(input.model) }
			: {}),
		...(input.promptVariant ? { reasoningEffort: input.promptVariant } : {}),
		messageID: `msg_${input.envelope.run_id}`,
		parts: [
			{
				id: `prt_${input.envelope.run_id}`,
				type: "text",
				text: input.prompt,
			},
		],
	};
	const response = await fetch(
		`${serverUrl}/session/${input.sessionId}/prompt_async`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-opencode-directory": input.envelope.repo_root,
			},
			body: JSON.stringify(payload),
		},
	);
	const text = await response.text();
	let data: any;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text };
	}
	if (!response.ok) {
		throw new Error(`prompt_async failed: ${response.status} ${text}`);
	}
	return { ok: true, payload, response: data, status: response.status };
}

export async function verifyPromptAsyncMaterialized(input: {
	envelope: RoutingEnvelope;
	sessionId: string;
	messageId: string;
	attempts?: number;
	delayMs?: number;
}) {
	const serverUrl = input.envelope.opencode_server_url.replace(/\/$/, "");
	const attempts = input.attempts ?? 6;
	const delayMs = input.delayMs ?? 1000;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const [messageRes, sessionRes] = await Promise.all([
			fetchJsonSafe(`${serverUrl}/session/${input.sessionId}/message`),
			fetchJsonSafe(`${serverUrl}/session/${input.sessionId}`),
		]);
		const messages = messageRes.ok && Array.isArray(messageRes.data)
			? messageRes.data
			: [];
		const hasMessage = messages.some((message: any) => {
			const info = message?.info;
			return (
				asString(info?.id) === input.messageId ||
				asString(message?.id) === input.messageId ||
				asString(info?.parentID) === input.messageId
			);
		});
		const sessionTitle = asString(sessionRes.data?.title);
		const expectedTitle = buildTaggedTitleForEnvelope(input.envelope);
		const titleTagged = sessionTitle === expectedTitle;
		if (hasMessage || titleTagged) {
			return {
				ok: true,
				hasMessage,
				titleTagged,
				attempt: attempt + 1,
				messageCount: messages.length,
				sessionTitle,
			};
		}
		if (attempt < attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return { ok: false, hasMessage: false, titleTagged: false };
}

export async function resolveAttachRunSession(input: {
	envelope: RoutingEnvelope;
	runId: string;
	attempts?: number;
	delayMs?: number;
}) {
	const serverUrl = input.envelope.opencode_server_url.replace(/\/$/, "");
	const attempts = input.attempts ?? 8;
	const delayMs = input.delayMs ?? 1000;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const sessionRes = await fetchJsonSafe(`${serverUrl}/session`);
		const sessionList = Array.isArray(sessionRes.data) ? sessionRes.data : [];
		const match = sessionList.find((session: any) => {
			const text = JSON.stringify(session || {});
			return (
				text.includes(`runId=${input.runId}`) &&
				text.includes(input.envelope.repo_root)
			);
		});
		const matchedId = asString(match?.id);
		if (matchedId) {
			return {
				ok: true,
				sessionId: matchedId,
				sessionResolvedAt: new Date().toISOString(),
				sessionResolutionStrategy: "title_match",
				attempt: attempt + 1,
			};
		}
		if (attempt < attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return {
		ok: false,
		sessionResolutionPending: true,
		sessionResolutionStrategy: "title_match_pending",
	};
}

export async function runAttachExecutionForEnvelope(input: {
	cfg: any;
	envelope: RoutingEnvelope;
	prompt: string;
	model?: string;
	promptVariant?: "medium" | "high";
	thinking?: boolean;
}) {
	const taggedTitle = buildTaggedSessionTitle({
		runId: input.envelope.run_id,
		taskId: input.envelope.task_id,
		requested: input.envelope.requested_agent_id,
		resolved: input.envelope.resolved_agent_id,
		callbackSession: input.envelope.callback_target_session_key,
		callbackSessionId: input.envelope.callback_target_session_id,
		callbackDeliver: input.envelope.deliver,
		projectId: input.envelope.project_id,
		repoRoot: input.envelope.repo_root,
	});
	const args = [
		"run",
		"--attach",
		input.envelope.opencode_server_url,
		"--dir",
		input.envelope.repo_root,
		"--title",
		taggedTitle,
	];
	if (
		input.envelope.execution_agent_explicit &&
		input.envelope.resolved_agent_id
	) {
		args.push("--agent", input.envelope.resolved_agent_id);
	}
	const attachRunModel = normalizeAttachRunModel(input.model);
	if (attachRunModel) {
		args.push("--model", attachRunModel);
	}
	if (input.promptVariant) {
		args.push("--variant", input.promptVariant);
	}
	if (input.thinking) {
		args.push("--thinking");
	}
	args.push(input.prompt);
	const runtimeCfg = getRuntimeConfig(input.cfg);
	const child = spawn("opencode", args, {
		cwd: input.envelope.repo_root,
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			...(runtimeCfg.hookBaseUrl
				? { OPENCLAW_HOOK_BASE_URL: runtimeCfg.hookBaseUrl }
				: {}),
			...(runtimeCfg.hookToken
				? { OPENCLAW_HOOK_TOKEN: runtimeCfg.hookToken }
				: {}),
		},
	});
	child.unref();
	return {
		command: "opencode",
		args,
		stdout: "",
		stderr: "",
		exitCode: null,
		signal: null,
		pid: child.pid,
		started: true,
	};
}

export function buildContinuationCallbackMetadata(input: {
	runStatus: BridgeRunStatus;
	eventType: string;
}): OpenCodeContinuationCallbackMetadata {
	const continuation = input.runStatus.continuation;
	return {
		kind: "opencode.callback",
		eventType: input.eventType,
		runId: input.runStatus.runId,
		taskId: input.runStatus.taskId,
		projectId: input.runStatus.envelope.project_id,
		repoRoot: input.runStatus.envelope.repo_root,
		requestedAgentId: input.runStatus.envelope.requested_agent_id,
		resolvedAgentId: input.runStatus.envelope.resolved_agent_id,
		callbackTargetSessionKey:
			input.runStatus.envelope.callback_target_session_key,
		callbackTargetSessionId:
			input.runStatus.envelope.callback_target_session_id,
		opencodeSessionId: input.runStatus.sessionId,
		workflowId: continuation?.workflowId,
		stepId: continuation?.stepId,
	};
}

export async function startExecutionRun(input: {
	cfg: any;
	envelope: RoutingEnvelope;
	prompt: string;
	model?: string;
	continuation?: OpenCodeRunContinuation;
	pollIntervalMs?: number;
	maxWaitMs?: number;
}) {
	const initial: BridgeRunStatus = {
		taskId: input.envelope.task_id,
		runId: input.envelope.run_id,
		state: "queued",
		lastEvent: null,
		lastSummary: undefined,
		updatedAt: new Date().toISOString(),
		envelope: input.envelope,
		continuation: input.continuation,
	};
	writeRunStatus(initial);

	const serveRegistry = normalizeServeRegistry(readServeRegistry());
	const serveEntry = serveRegistry.entries.find(
		(entry) => entry.opencode_server_url === input.envelope.opencode_server_url,
	);
	const sessionRegistry = normalizeSessionRegistry(readSessionRegistry());
	const sessionEntry = sessionRegistry.entries.find(
		(entry) =>
			entry.opencode_server_url === input.envelope.opencode_server_url &&
			entry.directory === input.envelope.repo_root &&
			entry.is_current_for_directory === true,
	);
	const promptVariant = selectPromptVariant({
		promptVariant: input.continuation?.promptVariant,
		priority: input.envelope.priority,
		objective: input.prompt,
		prompt: input.prompt,
	});
	const attachRun = await runAttachExecutionForEnvelope({
		cfg: input.cfg,
		envelope: input.envelope,
		prompt: input.prompt,
		model: input.model,
		promptVariant,
		thinking: true,
	});
	const sessionResolution = await resolveAttachRunSession({
		envelope: input.envelope,
		runId: input.envelope.run_id,
	});
	const nowIso = new Date().toISOString();
	if (serveEntry) {
		upsertServeRegistry({
			...serveEntry,
			last_event_at: nowIso,
			updated_at: nowIso,
		});
	}
	const current =
		patchRunStatus(input.envelope.run_id, (status) => ({
			...status,
			sessionId: sessionResolution.ok ? sessionResolution.sessionId : status.sessionId,
			opencodeSessionId: sessionResolution.ok ? sessionResolution.sessionId : status.opencodeSessionId,
			sessionResolvedAt: sessionResolution.ok ? sessionResolution.sessionResolvedAt : status.sessionResolvedAt,
			sessionResolutionStrategy: sessionResolution.sessionResolutionStrategy,
			sessionResolutionPending: sessionResolution.ok ? false : true,
			executionLane: "attach_run",
			state: attachRun.started ? "running" : "failed",
			attachRun,
			lastSummary: attachRun.started
				? "Attach-run dispatched; terminal callback owned by OpenCode-side plugin"
				: "attach-run execution failed",
			updatedAt: new Date().toISOString(),
		})) || initial;

	return {
		ok: Boolean(attachRun.started),
		runId: input.envelope.run_id,
		taskId: input.envelope.task_id,
		sessionId: undefined,
		state: current.state,
		sessionMode: "attach_run",
		createdSession: null,
		attachRun,
	};
}

export function buildHookPolicyChecklist(agentId: string, sessionKey: string) {
	return {
		primaryCallbackPath: OPENCODE_CALLBACK_HTTP_PATH,
		requirements: {
			hooksEnabled: true,
			allowRequestSessionKey: true,
			allowedAgentIdsMustInclude: agentId,
			callbackTargetSessionKeyMustBeExplicit: true,
			executionSessionKeyPrefix: HOOK_PREFIX,
			deliverDefault: false,
		},
		sessionKey,
		suggestedConfig: {
			hooks: {
				enabled: true,
				allowRequestSessionKey: true,
				allowedAgentIds: [agentId],
			},
		},
		note: "callback target session keys are origin-session scoped and are not required to share the execution HOOK_PREFIX",
	};
}
