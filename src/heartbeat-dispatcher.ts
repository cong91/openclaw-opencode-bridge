import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	asString,
	findRegistryEntry,
	getRuntimeConfig,
	normalizeSessionRegistry,
	readSessionRegistry,
} from "./runtime";
import type {
	BridgeRunStatus,
	OpenCodeContinuationCallbackMetadata,
} from "./types";

export type CallbackPendingLifecycle = "pending" | "claimed" | "done";

export type CallbackPendingItem = {
	id: string;
	dedupeKey?: string;
	runId?: string;
	eventType?: string;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	status: CallbackPendingLifecycle;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string;
	doneAt?: string;
	metadata?: OpenCodeContinuationCallbackMetadata | null;
	rawMessage?: string;
};

export type CallbackPendingState = {
	version: "v1";
	agentId: string;
	sessionKey: string;
	sessionId: string;
	workspaceDir: string;
	updatedAt: string;
	items: CallbackPendingItem[];
};

export type CallbackIngressResolution = {
	agentId?: string;
	sessionId?: string;
	sessionKey: string;
	workspaceDir?: string;
	workspaceSource:
		| "session_registry"
		| "run_status_repo_root"
		| "metadata_repo_root"
		| "project_registry"
		| "unresolved";
};

export function deriveAgentIdFromSessionKey(
	sessionKey?: string,
): string | undefined {
	if (!sessionKey) return undefined;
	const matched = sessionKey.match(/^agent:([^:]+):/);
	return matched?.[1];
}

function sanitizeSessionId(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		throw new Error(
			`Invalid sessionId for callback pending path: ${sessionId}`,
		);
	}
	return sessionId;
}

function assertInsideWorkspace(
	workspaceDir: string,
	targetPath: string,
): string {
	const root = resolve(workspaceDir);
	const target = resolve(targetPath);
	if (target !== root && !target.startsWith(`${root}${sep}`)) {
		throw new Error(
			`Callback pending path escapes workspace root (root=${root}, target=${target})`,
		);
	}
	return target;
}

function parsePendingState(raw: string): CallbackPendingState | null {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		if (!Array.isArray((parsed as any).items)) return null;
		return parsed as CallbackPendingState;
	} catch {
		return null;
	}
}

export function resolveCallbackIngressTarget(input: {
	cfg: any;
	callback: {
		agentId?: string;
		sessionKey: string;
		sessionId?: string;
	};
	metadata?: OpenCodeContinuationCallbackMetadata | null;
	runStatus?: BridgeRunStatus | null;
}): CallbackIngressResolution {
	const sessionId =
		asString(input.metadata?.callbackTargetSessionId) ||
		asString(input.callback.sessionId);
	const agentId =
		asString(input.callback.agentId) ||
		asString(input.metadata?.requestedAgentId) ||
		asString(input.runStatus?.envelope?.requested_agent_id) ||
		deriveAgentIdFromSessionKey(input.callback.sessionKey);

	const registry = normalizeSessionRegistry(readSessionRegistry());
	const workspaceSessionCandidates = [
		asString(input.metadata?.opencodeSessionId),
		asString(input.runStatus?.opencodeSessionId),
		asString(input.runStatus?.sessionId),
		sessionId,
	].filter(Boolean) as string[];
	for (const candidateSessionId of workspaceSessionCandidates) {
		const bySessionId = registry.entries.find(
			(entry) => entry.session_id === candidateSessionId,
		);
		if (!bySessionId?.directory) continue;
		return {
			agentId,
			sessionId,
			sessionKey: input.callback.sessionKey,
			workspaceDir: bySessionId.directory,
			workspaceSource: "session_registry",
		};
	}

	const runRepoRoot = asString(input.runStatus?.envelope?.repo_root);
	if (runRepoRoot) {
		return {
			agentId,
			sessionId,
			sessionKey: input.callback.sessionKey,
			workspaceDir: runRepoRoot,
			workspaceSource: "run_status_repo_root",
		};
	}

	const metadataRepoRoot = asString(input.metadata?.repoRoot);
	if (metadataRepoRoot) {
		return {
			agentId,
			sessionId,
			sessionKey: input.callback.sessionKey,
			workspaceDir: metadataRepoRoot,
			workspaceSource: "metadata_repo_root",
		};
	}

	const cfg = getRuntimeConfig(input.cfg);
	const registryEntry = findRegistryEntry(
		cfg,
		asString(input.metadata?.projectId) ||
			asString(input.runStatus?.envelope?.project_id),
		metadataRepoRoot || asString(input.runStatus?.envelope?.repo_root),
	);
	if (registryEntry?.repoRoot) {
		return {
			agentId,
			sessionId,
			sessionKey: input.callback.sessionKey,
			workspaceDir: registryEntry.repoRoot,
			workspaceSource: "project_registry",
		};
	}

	return {
		agentId,
		sessionId,
		sessionKey: input.callback.sessionKey,
		workspaceSource: "unresolved",
	};
}

export function getCallbackPendingFilePath(input: {
	workspaceDir: string;
	sessionId: string;
}) {
	const safeSessionId = sanitizeSessionId(input.sessionId);
	const pendingDir = assertInsideWorkspace(
		input.workspaceDir,
		join(input.workspaceDir, ".callback-pending"),
	);
	const filePath = assertInsideWorkspace(
		input.workspaceDir,
		join(pendingDir, `${safeSessionId}.json`),
	);
	return { pendingDir, filePath };
}

export function readCallbackPendingState(input: {
	workspaceDir: string;
	sessionId: string;
	defaultAgentId: string;
	sessionKey: string;
}): { filePath: string; state: CallbackPendingState } {
	const { filePath } = getCallbackPendingFilePath({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
	});
	if (!existsSync(filePath)) {
		return {
			filePath,
			state: {
				version: "v1",
				agentId: input.defaultAgentId,
				sessionKey: input.sessionKey,
				sessionId: input.sessionId,
				workspaceDir: resolve(input.workspaceDir),
				updatedAt: new Date().toISOString(),
				items: [],
			},
		};
	}
	const parsed = parsePendingState(readFileSync(filePath, "utf8"));
	if (parsed) {
		return { filePath, state: parsed };
	}
	return {
		filePath,
		state: {
			version: "v1",
			agentId: input.defaultAgentId,
			sessionKey: input.sessionKey,
			sessionId: input.sessionId,
			workspaceDir: resolve(input.workspaceDir),
			updatedAt: new Date().toISOString(),
			items: [],
		},
	};
}

function writePendingState(input: {
	workspaceDir: string;
	sessionId: string;
	state: CallbackPendingState;
}) {
	const { pendingDir, filePath } = getCallbackPendingFilePath({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
	});
	mkdirSync(pendingDir, { recursive: true });
	writeFileSync(filePath, JSON.stringify(input.state, null, 2), "utf8");
	return filePath;
}

export function upsertCallbackPendingItem(input: {
	workspaceDir: string;
	agentId: string;
	sessionKey: string;
	sessionId: string;
	dedupeKey?: string;
	runId?: string;
	eventType?: string;
	metadata?: OpenCodeContinuationCallbackMetadata | null;
	rawMessage?: string;
}) {
	const now = new Date().toISOString();
	const { state } = readCallbackPendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		defaultAgentId: input.agentId,
		sessionKey: input.sessionKey,
	});
	const dedupeId =
		input.dedupeKey ||
		[input.runId || "run", input.eventType || "event", input.sessionId].join(
			":",
		);
	const existing = state.items.find((item) => item.id === dedupeId);
	if (existing) {
		existing.updatedAt = now;
		existing.metadata = input.metadata ?? existing.metadata;
		existing.rawMessage = input.rawMessage ?? existing.rawMessage;
		state.updatedAt = now;
		const filePath = writePendingState({
			workspaceDir: input.workspaceDir,
			sessionId: input.sessionId,
			state,
		});
		return { filePath, state, item: existing, deduped: true };
	}
	const item: CallbackPendingItem = {
		id: dedupeId,
		...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
		...(input.runId ? { runId: input.runId } : {}),
		...(input.eventType ? { eventType: input.eventType } : {}),
		agentId: input.agentId,
		sessionKey: input.sessionKey,
		sessionId: input.sessionId,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		...(input.metadata ? { metadata: input.metadata } : {}),
		...(input.rawMessage ? { rawMessage: input.rawMessage } : {}),
	};
	state.items.push(item);
	state.updatedAt = now;
	state.workspaceDir = resolve(input.workspaceDir);
	state.agentId = input.agentId;
	state.sessionId = input.sessionId;
	state.sessionKey = input.sessionKey;
	const filePath = writePendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		state,
	});
	return { filePath, state, item, deduped: false };
}

export function claimNextCallbackPendingItem(input: {
	workspaceDir: string;
	sessionId: string;
	claimer: string;
}) {
	const now = new Date().toISOString();
	const { state } = readCallbackPendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		defaultAgentId: input.claimer,
		sessionKey: "unknown",
	});
	const item = state.items.find((candidate) => candidate.status === "pending");
	if (!item) return { claimed: null, state, filePath: null };
	item.status = "claimed";
	item.claimedAt = now;
	item.updatedAt = now;
	state.updatedAt = now;
	const filePath = writePendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		state,
	});
	return { claimed: item, state, filePath };
}

export function markCallbackPendingItemDone(input: {
	workspaceDir: string;
	sessionId: string;
	itemId: string;
}) {
	const now = new Date().toISOString();
	const { state } = readCallbackPendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		defaultAgentId: "unknown",
		sessionKey: "unknown",
	});
	const item = state.items.find((candidate) => candidate.id === input.itemId);
	if (!item) return { done: null, state, filePath: null };
	item.status = "done";
	item.doneAt = now;
	item.updatedAt = now;
	state.updatedAt = now;
	const filePath = writePendingState({
		workspaceDir: input.workspaceDir,
		sessionId: input.sessionId,
		state,
	});
	return { done: item, state, filePath };
}
