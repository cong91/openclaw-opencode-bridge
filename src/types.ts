import type { EventScope, OpenCodeEventKind } from "./observability";

export type ProjectRegistryEntry = {
	projectId: string;
	repoRoot: string;
	serverUrl: string;
	idleTimeoutMs?: number;
};

export type RoutingEnvelope = {
	task_id: string;
	run_id: string;
	// OpenCode execution agent (resolved)
	agent_id: string;
	// OpenClaw requester agent before resolution/mapping
	requested_agent_id: string;
	// Explicit resolved execution agent id (same value as agent_id for audit clarity)
	resolved_agent_id: string;
	execution_agent_explicit?: boolean;
	session_key: string;
	origin_session_key: string;
	origin_session_id?: string;
	callback_target_session_key: string;
	callback_target_session_id?: string;
	project_id: string;
	repo_root: string;
	opencode_server_url: string;
	channel?: string;
	to?: string;
	deliver?: boolean;
	priority?: string;
};

export type BridgeLifecycleState =
	| "queued"
	| "server_ready"
	| "session_created"
	| "prompt_sent"
	| "planning"
	| "coding"
	| "verifying"
	| "blocked"
	| "running"
	| "awaiting_permission"
	| "stalled"
	| "failed"
	| "completed";

export type HooksAgentCallbackPayload = {
	message: string;
	name: string;
	agentId: string;
	sessionKey: string;
	sessionId?: string;
	wakeMode: "now" | "next-heartbeat";
	deliver: boolean;
	channel?: string;
	to?: string;
};

export type OpenCodeRunContinuationStep = {
	action: "launch_run" | "notify" | "none";
	taskId?: string;
	objective?: string;
	prompt?: string;
};

export type OpenCodeRunContinuation = {
	workflowId?: string;
	stepId?: string;
	callbackEventKind?: "opencode.callback";
	nextOnSuccess?: OpenCodeRunContinuationStep;
	nextOnFailure?: OpenCodeRunContinuationStep;
	promptVariant?: "medium" | "high";
	thinking?: boolean;
};

export type OpenCodeContinuationCallbackMetadata = {
	kind: "opencode.callback";
	eventType: string;
	runId?: string;
	taskId?: string;
	projectId?: string;
	repoRoot?: string;
	requestedAgentId?: string;
	resolvedAgentId?: string;
	callbackTargetSessionKey?: string;
	callbackTargetSessionId?: string;
	opencodeSessionId?: string;
	workflowId?: string;
	stepId?: string;
};

export type BridgeRunStatus = {
	taskId: string;
	runId: string;
	state: BridgeLifecycleState;
	lastEvent?: OpenCodeEventKind | null;
	lastSummary?: string;
	updatedAt: string;
	envelope: RoutingEnvelope;
	sessionId?: string;
	callbackSentAt?: string;
	callbackStatus?: number;
	callbackOk?: boolean;
	callbackBody?: string;
	callbackAttempts?: number;
	callbackError?: string;
	executionLane?: "session_api" | "attach_run";
	attachRun?: {
		command?: string;
		args?: string[];
		stdout?: string;
		stderr?: string;
		exitCode?: number | null;
		signal?: string | null;
		pid?: number;
		started?: boolean;
	};
	continuation?: OpenCodeRunContinuation;
};

export type OpenCodeApiSnapshot = {
	health?: any;
	sessionList?: any[];
	sessionStatus?: any;
	fetchedAt: string;
};

export type LifecycleSummary = {
	currentState: BridgeLifecycleState | null;
	current_state?: BridgeLifecycleState | null;
	last_event_kind: OpenCodeEventKind | null;
	last_event_at: string | null;
	files_changed: string[];
	verify_summary: {
		command?: string;
		exit?: number | null;
		output_preview?: string | null;
	}[];
	blockers: string[];
	completion_summary: string | null;
};

export type RunStatusResponse = {
	ok: boolean;
	source: {
		runArtifact: boolean;
		opencodeApi: boolean;
	};
	runId?: string;
	taskId?: string;
	projectId?: string;
	sessionId?: string;
	correlation?: {
		sessionResolution: {
			strategy: string;
			score?: number;
		};
	};
	state: BridgeLifecycleState;
	currentState?: BridgeLifecycleState | null;
	current_state?: BridgeLifecycleState | null;
	lastEvent?: OpenCodeEventKind | null;
	last_event_kind?: OpenCodeEventKind | null;
	lastSummary?: string;
	last_event_at?: string | null;
	files_changed?: string[];
	verify_summary?: {
		command?: string;
		exit?: number | null;
		output_preview?: string | null;
	}[];
	blockers?: string[];
	completion_summary?: string | null;
	updatedAt: string;
	timestamps: {
		artifactUpdatedAt?: string;
		apiFetchedAt?: string;
	};
	health?: {
		ok: boolean;
		version?: string;
	};
	apiSnapshot?: OpenCodeApiSnapshot;
	continuation?: OpenCodeRunContinuation;
	note?: string;
};

export type RunEventRecord = {
	index: number;
	scope: EventScope;
	rawLine: string;
	data?: any;
	normalizedKind?: OpenCodeEventKind | null;
	summary?: string;
	lifecycle_state?: BridgeLifecycleState | null;
	files_changed?: string[];
	verify_summary?: {
		command?: string;
		exit?: number | null;
		output_preview?: string | null;
	} | null;
	blockers?: string[];
	completion_summary?: string | null;
	runId?: string;
	taskId?: string;
	sessionId?: string;
	typedEvent?: any;
	timestamp: string;
};

export type RunEventsResponse = {
	ok: boolean;
	runId?: string;
	taskId?: string;
	sessionId?: string;
	correlation?: {
		sessionResolution?: {
			strategy: string;
			score?: number;
		};
	};
	scope: EventScope;
	schemaVersion: "opencode.event.v1";
	eventPath: string;
	eventCount: number;
	events: RunEventRecord[];
	continuation?: OpenCodeRunContinuation;
	truncated: boolean;
	timeoutMs: number;
};

export type SessionTailMessage = {
	index: number;
	role?: string;
	text?: string;
	createdAt?: number | string;
	id?: string;
	agent?: string;
	model?: string;
	raw?: any;
};

export type SessionTailResponse = {
	ok: boolean;
	sessionId: string;
	runId?: string;
	taskId?: string;
	correlation?: {
		sessionResolution: {
			strategy: string;
			score?: number;
		};
	};
	limit: number;
	totalMessages: number;
	messages: SessionTailMessage[];
	continuation?: OpenCodeRunContinuation;
	diff?: any;
	latestSummary?: any;
	fetchedAt: string;
};

export type CallbackAuditRecord = {
	taskId?: string;
	runId?: string;
	agentId?: string;
	requestedAgentId?: string;
	resolvedAgentId?: string;
	sessionKey?: string;
	callbackTargetSessionKey?: string;
	callbackTargetSessionId?: string;
	projectId?: string;
	repoRoot?: string;
	opencodeSessionId?: string;
	workflowId?: string;
	stepId?: string;
	event?: string;
	callbackStatus: number;
	callbackOk: boolean;
	callbackBody?: string;
	createdAt: string;
};

export type ServeRegistryEntry = {
	serve_id: string;
	opencode_server_url: string;
	pid?: number;
	status?: "running" | "stopped" | "unknown";
	last_event_at?: string;
	idle_timeout_ms?: number;
	updated_at: string;
};

export type ServeRegistryFile = {
	entries: ServeRegistryEntry[];
};

export type SessionRegistryEntry = {
	session_id: string;
	serve_id: string;
	opencode_server_url: string;
	directory: string;
	project_id?: string;
	session_title?: string;
	session_updated_at?: string;
	status?: "active" | "stale" | "closed";
	is_current_for_directory?: boolean;
	updated_at: string;
};

export type SessionRegistryFile = {
	entries: SessionRegistryEntry[];
};

export type BridgeConfigFile = {
	opencodeServerUrl?: string;
	projectRegistry?: {
		projectId: string;
		repoRoot: string;
		serverUrl: string;
		idleTimeoutMs?: number;
	}[];
	// Optional explicit mapping from requester agent -> OpenCode execution agent.
	// If present and no mapping matched, envelope build should fail (no silent fallback).
	executionAgentMappings?: {
		requestedAgentId: string;
		executionAgentId: string;
	}[];
	hookBaseUrl?: string;
	hookToken?: string;
};
