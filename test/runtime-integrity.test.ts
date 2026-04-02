import assert from "node:assert/strict";
import test from "node:test";

import {
	assertCallbackTargetSessionKey,
	buildContinuationCallbackMetadata,
	buildEnvelope,
	buildHookPolicyChecklist,
	buildHooksAgentCallback,
	evaluateServeIdle,
	getDefaultServePort,
	getDefaultServeUrl,
	inferServeUrlFromCommand,
	isOpencodeServeCommand,
	resolveExecutionAgent,
	resolveServerUrl,
	resolveSessionForRun,
} from "../src/runtime";

test("resolveExecutionAgent uses explicit executionAgentId when provided", () => {
	const resolved = resolveExecutionAgent({
		cfg: {},
		requestedAgentId: "creator",
		explicitExecutionAgentId: "coder-lane",
	});

	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.requestedAgentId, "creator");
	assert.equal(resolved.resolvedAgentId, "coder-lane");
	assert.equal(resolved.strategy, "explicit_param");
});

test("resolveExecutionAgent fails when mappings exist but requested agent is unmapped", () => {
	const resolved = resolveExecutionAgent({
		cfg: {
			executionAgentMappings: [
				{ requestedAgentId: "creator", executionAgentId: "coder-lane" },
			],
		},
		requestedAgentId: "scrum",
	});

	assert.equal(resolved.ok, false);
	if (resolved.ok) return;
	assert.equal(resolved.mappingConfigured, true);
	assert.match(resolved.error, /no mapping matched/i);
});

test("buildEnvelope preserves origin session context and callback target", () => {
	const envelope = buildEnvelope({
		taskId: "task-1",
		runId: "run-1",
		requestedAgentId: "creator",
		resolvedAgentId: "coder-lane",
		originSessionKey: "session:origin:key",
		originSessionId: "session-origin-id",
		projectId: "proj-1",
		repoRoot: "/tmp/repo",
		serverUrl: "http://127.0.0.1:4096",
	});

	assert.equal(envelope.agent_id, "coder-lane");
	assert.equal(envelope.requested_agent_id, "creator");
	assert.equal(envelope.resolved_agent_id, "coder-lane");
	assert.equal(envelope.origin_session_key, "session:origin:key");
	assert.equal(envelope.origin_session_id, "session-origin-id");
	assert.equal(
		envelope.callback_target_session_key,
		"agent:creator:opencode:creator:callback:session%3Aorigin%3Akey",
	);
	assert.equal(envelope.callback_target_session_id, undefined);
	assert.equal(envelope.callback_relay_session_key, "session:origin:key");
	assert.equal(envelope.callback_relay_session_id, "session-origin-id");
});

test("buildHooksAgentCallback routes callback to requester agent + origin session", () => {
	const envelope = buildEnvelope({
		taskId: "task-2",
		runId: "run-2",
		requestedAgentId: "creator",
		resolvedAgentId: "coder-lane",
		originSessionKey: "session:origin:key:2",
		originSessionId: "origin-session-2",
		projectId: "proj-2",
		repoRoot: "/tmp/repo2",
		serverUrl: "http://127.0.0.1:4097",
	});

	const callback = buildHooksAgentCallback({
		event: "task.progress",
		envelope,
	});

	assert.equal(callback.agentId, "creator");
	assert.equal(
		callback.sessionKey,
		"agent:creator:opencode:creator:callback:session%3Aorigin%3Akey%3A2",
	);
	assert.equal(callback.sessionId, undefined);
	assert.match(callback.message, /requestedAgent=creator/);
	assert.match(callback.message, /resolvedAgent=coder-lane/);
});

test("assertCallbackTargetSessionKey fails fast when callback_target_session_key is missing", () => {
	const envelope = buildEnvelope({
		taskId: "task-2b",
		runId: "run-2b",
		requestedAgentId: "creator",
		resolvedAgentId: "coder-lane",
		originSessionKey: "session:origin:key:2b",
		projectId: "proj-2b",
		repoRoot: "/tmp/repo2b",
		serverUrl: "http://127.0.0.1:4097",
	});

	const brokenEnvelope = { ...envelope } as any;
	delete brokenEnvelope.callback_target_session_key;

	assert.throws(
		() => assertCallbackTargetSessionKey(brokenEnvelope),
		/missing callback_target_session_key/i,
	);
	assert.throws(
		() =>
			buildHooksAgentCallback({
				event: "task.progress",
				envelope: brokenEnvelope,
			}),
		/missing callback_target_session_key/i,
	);
});

test("resolveSessionForRun prefers callback_target_session_id over execution session artifacts", () => {
	const runStatus = {
		taskId: "task-3",
		runId: "run-3",
		state: "running",
		updatedAt: new Date().toISOString(),
		envelope: {
			task_id: "task-3",
			run_id: "run-3",
			agent_id: "coder-lane",
			requested_agent_id: "creator",
			resolved_agent_id: "coder-lane",
			session_key: "hook:opencode:coder-lane:task-3",
			origin_session_key: "session:origin:key:3",
			callback_target_session_key:
				"agent:creator:opencode:creator:callback:sess-origin-3",
			callback_relay_session_key: "session:origin:key:3",
			callback_relay_session_id: "sess-origin-3",
			project_id: "proj-3",
			repo_root: "/tmp/repo3",
			opencode_server_url: "http://127.0.0.1:4098",
		},
	} as any;

	const resolved = resolveSessionForRun({
		runStatus,
		sessionList: [
			{
				id: "sess-exec-3",
				time: { updated: 300 },
				metadata: {
					run_id: "run-3",
					session_key: "hook:opencode:coder-lane:task-3",
				},
			},
			{
				id: "sess-origin-3",
				time: { updated: 200 },
				metadata: { session_key: "session:origin:key:3" },
			},
		],
	});

	assert.equal(resolved.sessionId, "sess-origin-3");
	assert.equal(resolved.strategy, "artifact");
});

test("resolveSessionForRun falls back to callback target session key before execution session key", () => {
	const runStatus = {
		taskId: "task-4",
		runId: "run-4",
		state: "running",
		updatedAt: new Date().toISOString(),
		envelope: {
			task_id: "task-4",
			run_id: "run-4",
			agent_id: "coder-lane",
			requested_agent_id: "creator",
			resolved_agent_id: "coder-lane",
			session_key: "hook:opencode:coder-lane:task-4",
			origin_session_key: "session:origin:key:4",
			callback_target_session_key:
				"agent:creator:opencode:creator:callback:run-4",
			callback_relay_session_key: "session:origin:key:4",
			project_id: "proj-4",
			repo_root: "/tmp/repo4",
			opencode_server_url: "http://127.0.0.1:4099",
		},
	} as any;

	const resolved = resolveSessionForRun({
		runStatus,
		sessionList: [
			{
				id: "sess-exec-4",
				time: { updated: 400 },
				metadata: {
					run_id: "run-4",
					session_key: "hook:opencode:coder-lane:task-4",
				},
			},
			{
				id: "sess-origin-4",
				time: { updated: 250 },
				metadata: { session_key: "session:origin:key:4" },
			},
		],
	});

	assert.equal(resolved.sessionId, "sess-origin-4");
	assert.equal(resolved.strategy, "scored_fallback");
});

test("evaluateServeIdle returns shutdown signal when idle timeout is exceeded", () => {
	const now = Date.now();
	const result = evaluateServeIdle({
		serve_id: "http://127.0.0.1:5000",
		opencode_server_url: "http://127.0.0.1:5000",
		last_event_at: new Date(now - 20_000).toISOString(),
		idle_timeout_ms: 5_000,
		updated_at: new Date(now).toISOString(),
	});

	assert.equal(result.shouldShutdown, true);
	assert.equal(result.reason, "idle_timeout_exceeded");
});

test("buildHookPolicyChecklist documents origin callback session key semantics", () => {
	const checklist = buildHookPolicyChecklist("creator", "session:origin:key");

	assert.equal(
		checklist.requirements.callbackTargetSessionKeyMustBeExplicit,
		true,
	);
	assert.equal(
		checklist.requirements.executionSessionKeyPrefix,
		"hook:opencode:",
	);
	assert.equal(
		"allowedSessionKeyPrefixesMustInclude" in checklist.requirements,
		false,
	);
	assert.match(String(checklist.note), /origin-session scoped/i);
});

test("buildContinuationCallbackMetadata projects continuation correlation fields", () => {
	const runStatus = {
		taskId: "task-5",
		runId: "run-5",
		state: "running",
		updatedAt: new Date().toISOString(),
		sessionId: "sess-opencode-5",
		continuation: {
			workflowId: "wf-5",
			stepId: "step-5",
			callbackEventKind: "opencode.callback",
		},
		envelope: {
			task_id: "task-5",
			run_id: "run-5",
			agent_id: "coder-lane",
			requested_agent_id: "creator",
			resolved_agent_id: "coder-lane",
			session_key: "hook:opencode:coder-lane:task-5",
			origin_session_key: "session:origin:key:5",
			callback_target_session_key:
				"agent:creator:opencode:creator:callback:run-5",
			callback_relay_session_key: "session:origin:key:5",
			callback_relay_session_id: "sess-origin-5",
			project_id: "proj-5",
			repo_root: "/tmp/repo5",
			agent_workspace_dir: "/tmp/workspaces/agent-5",
			opencode_server_url: "http://127.0.0.1:4100",
		},
	} as any;

	const metadata = buildContinuationCallbackMetadata({
		runStatus,
		eventType: "session.idle",
	});
	assert.equal(metadata.kind, "opencode.callback");
	assert.equal(metadata.eventType, "session.idle");
	assert.equal(metadata.runId, "run-5");
	assert.equal(metadata.taskId, "task-5");
	assert.equal(metadata.projectId, "proj-5");
	assert.equal(metadata.repoRoot, "/tmp/repo5");
	assert.equal(metadata.agentWorkspaceDir, "/tmp/workspaces/agent-5");
	assert.equal(metadata.requestedAgentId, "creator");
	assert.equal(metadata.resolvedAgentId, "coder-lane");
	assert.equal(
		metadata.callbackTargetSessionKey,
		"agent:creator:opencode:creator:callback:run-5",
	);
	assert.equal(metadata.callbackTargetSessionId, undefined);
	assert.equal(metadata.callbackRelaySessionKey, "session:origin:key:5");
	assert.equal(metadata.callbackRelaySessionId, "sess-origin-5");
	assert.equal(metadata.opencodeSessionId, "sess-opencode-5");
	assert.equal(metadata.workflowId, "wf-5");
	assert.equal(metadata.stepId, "step-5");
});

test("default serve helpers resolve canonical URL", () => {
	assert.equal(getDefaultServePort(), 4096);
	assert.equal(getDefaultServeUrl(), "http://127.0.0.1:4096");
	assert.equal(resolveServerUrl({}, {}), "http://127.0.0.1:4096");
});

test("serve command detector supports legacy and default-port forms", () => {
	assert.equal(isOpencodeServeCommand("opencode serve"), true);
	assert.equal(
		isOpencodeServeCommand("opencode serve --hostname 127.0.0.1"),
		true,
	);
	assert.equal(
		isOpencodeServeCommand("opencode serve --hostname 127.0.0.1 --port 5173"),
		true,
	);
	assert.equal(
		isOpencodeServeCommand("/usr/local/bin/opencode serve --port=5173"),
		true,
	);
	assert.equal(isOpencodeServeCommand("opencode run --attach"), false);

	assert.equal(
		inferServeUrlFromCommand("opencode serve"),
		"http://127.0.0.1:4096",
	);
	assert.equal(
		inferServeUrlFromCommand("opencode serve --hostname 127.0.0.1"),
		"http://127.0.0.1:4096",
	);
	assert.equal(
		inferServeUrlFromCommand("opencode serve --hostname 127.0.0.1 --port 6123"),
		"http://127.0.0.1:6123",
	);
	assert.equal(
		inferServeUrlFromCommand("opencode serve --hostname 127.0.0.1 --port=7123"),
		"http://127.0.0.1:7123",
	);
	assert.equal(inferServeUrlFromCommand("opencode run --attach"), undefined);
});
