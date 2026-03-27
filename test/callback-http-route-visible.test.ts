import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
	path: string;
	auth: "gateway" | "plugin";
	handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(
	body: string,
	token: string,
	authMode: "bearer" | "legacy" = "bearer",
) {
	const req = new EventEmitter() as any;
	req.method = "POST";
	req.url = "/plugin/opencode-bridge/callback";
	req.headers =
		authMode === "legacy"
			? { "x-openclaw-token": token }
			: { authorization: `Bearer ${token}` };
	process.nextTick(() => {
		req.emit("data", Buffer.from(body, "utf8"));
		req.emit("end");
	});
	return req;
}

function createMockRes() {
	return {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: "",
		setHeader(name: string, value: string) {
			this.headers[name] = value;
		},
		end(chunk?: string) {
			if (chunk) this.body += chunk;
		},
	} as any;
}

test("callback http route enqueues control message and wakes session without emitting user-visible ack text", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const telegramSends: any[] = [];

	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
					},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:opencode:creator:callback:run-visible-1",
		sessionId: "sess-origin-1",
		wakeMode: "now",
		deliver: true,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-1",
			taskId: "task-visible-1",
			callbackTargetSessionKey:
				"agent:creator:opencode:creator:callback:run-visible-1",
			callbackTargetSessionId: "sess-origin-1",
			callbackRelaySessionKey: "agent:creator:telegram:direct:5165741309",
			callbackRelaySessionId: "sess-origin-1",
			opencodeSessionId: "oc-sess-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback control message/,
	);
	assert.match(systemEvents[0].text, /"messageKind":"callback_control"/);
	assert.equal(systemEvents[0]?.opts?.sessionId, undefined);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback received for run run-visible-1; code finished; agent is continuing\./,
	);
	assert.equal(
		systemEvents[0]?.opts?.contextKey,
		"opencode:run-visible-1:message.updated:agent:creator:opencode:creator:callback:run-visible-1:callback_control",
	);
	assert.equal(telegramSends.length, 0);
});

test("callback http route still avoids user-visible ack text even when deliver=false", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const telegramSends: any[] = [];

	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
					},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:opencode:creator:callback:run-visible-2",
		sessionId: "sess-origin-2",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-2",
			taskId: "task-visible-2",
			callbackTargetSessionKey:
				"agent:creator:opencode:creator:callback:run-visible-2",
			callbackTargetSessionId: "sess-origin-2",
			callbackRelaySessionKey: "agent:creator:telegram:direct:5165741309",
			callbackRelaySessionId: "sess-origin-2",
			opencodeSessionId: "oc-sess-2",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback control message/,
	);
	assert.equal(telegramSends.length, 0);
});

test("callback http route does not send telegram notify for non-direct telegram session even when deliver=true", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const telegramSends: any[] = [];

	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
					},
				},
			},
		},
		{
			hookToken: "test-token",
		},
	);

	const route = routes.find(
		(x) => x.path === "/plugin/opencode-bridge/callback",
	);
	assert.ok(route, "callback route should be registered");

	const payload = {
		name: "OpenCode",
		agentId: "creator",
		sessionKey: "agent:creator:opencode:creator:callback:run-group-1",
		sessionId: "sess-group-1",
		wakeMode: "now",
		deliver: true,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-group-1",
			taskId: "task-group-1",
			callbackTargetSessionKey:
				"agent:creator:opencode:creator:callback:run-group-1",
			callbackTargetSessionId: "sess-group-1",
			callbackRelaySessionKey: "agent:creator:telegram:group:-10011223344",
			callbackRelaySessionId: "sess-group-1",
			opencodeSessionId: "oc-sess-group-1",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), "test-token");
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback control message/,
	);
	assert.equal(telegramSends.length, 0);
});

test("callback http route enqueues continuation notify internally when continuation notify exists", async () => {
	const tempRoot = mkdtempSync(
		join(tmpdir(), "opencode-bridge-callback-visible-"),
	);
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	mkdirSync(join(bridgeDir, "runs"), { recursive: true });
	writeFileSync(
		join(bridgeDir, "runs", "run-visible-continue-1.json"),
		JSON.stringify(
			{
				taskId: "task-visible-continue-1",
				runId: "run-visible-continue-1",
				state: "running",
				updatedAt: new Date().toISOString(),
				envelope: {
					task_id: "task-visible-continue-1",
					run_id: "run-visible-continue-1",
					agent_id: "builder",
					requested_agent_id: "creator",
					resolved_agent_id: "builder",
					session_key: "hook:opencode:builder:task-visible-continue-1",
					origin_session_key: "agent:creator:telegram:direct:5165741309",
					origin_session_id: "sess-origin-continue-1",
					callback_target_session_key:
						"agent:creator:opencode:creator:callback:sess-origin-continue-1",
					callback_relay_session_key:
						"agent:creator:telegram:direct:5165741309",
					callback_relay_session_id: "sess-origin-continue-1",
					project_id: "proj-visible-continue-1",
					repo_root: "/tmp/repo-visible-continue-1",
					opencode_server_url: "http://opencode.local",
				},
				continuation: {
					callbackEventKind: "opencode.callback",
					workflowId: "wf-visible-continue-1",
					stepId: "step-visible-continue-1",
					nextOnSuccess: {
						action: "notify",
						taskId: "task-followup-visible-1",
						objective: "Follow-up notification for direct session",
					},
					nextOnFailure: { action: "none" },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const telegramSends: any[] = [];

	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: any) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
				channel: {
					telegram: {
						async sendMessageTelegram(to: string, text: string, opts: any) {
							telegramSends.push({ to, text, opts });
							return { ok: true, channel: "telegram", to };
						},
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);

	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route, "callback route should be registered");

		const payload = {
			name: "OpenCode",
			agentId: "creator",
			sessionKey:
				"agent:creator:opencode:creator:callback:sess-origin-continue-1",
			sessionId: "sess-origin-continue-1",
			wakeMode: "now",
			deliver: true,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "task.completed",
				runId: "run-visible-continue-1",
				taskId: "task-visible-continue-1",
				callbackTargetSessionKey:
					"agent:creator:opencode:creator:callback:sess-origin-continue-1",
				callbackTargetSessionId: "sess-origin-continue-1",
				callbackRelaySessionKey: "agent:creator:telegram:direct:5165741309",
				callbackRelaySessionId: "sess-origin-continue-1",
				opencodeSessionId: "oc-sess-continue-1",
			}),
		};

		const req = createMockReq(JSON.stringify(payload), "test-token");
		const res = createMockRes();
		const handled = await route!.handler(req, res);

		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);
		assert.equal(systemEvents.length, 2);
		assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
		assert.equal(
			systemEvents[1]?.text,
			"Follow-up notification for direct session",
		);
		assert.equal(
			systemEvents[1]?.opts?.contextKey,
			"opencode:run-visible-continue-1:task.completed:agent:creator:opencode:creator:callback:sess-origin-continue-1:callback_control:continuation-notify",
		);
		assert.equal(telegramSends.length, 0);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("callback launch_run dispatches to custom hook endpoint instead of enqueueing session baton", async () => {
	const tempRoot = mkdtempSync(
		join(tmpdir(), "opencode-bridge-hook-dispatch-"),
	);
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(
		join(bridgeDir, "config.json"),
		JSON.stringify(
			{
				opencodeServerUrl: "http://127.0.0.1:4096",
				hookBaseUrl: "http://127.0.0.1:18789",
				hookToken: "test-token",
			},
			null,
			2,
		),
		"utf8",
	);
	const runId = "run-hook-dispatch-1";
	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify(
			{
				taskId: "task-hook-dispatch-1",
				runId,
				state: "running",
				lastEvent: "task.progress",
				updatedAt: "2000-01-01T00:00:00.000Z",
				envelope: {
					task_id: "task-hook-dispatch-1",
					run_id: runId,
					agent_id: "creator",
					requested_agent_id: "scrum",
					resolved_agent_id: "creator",
					session_key: "hook:opencode:creator:task-hook-dispatch-1",
					origin_session_key: "agent:scrum:telegram:direct:5165741309",
					origin_session_id: "telegram-msg-origin-1",
					callback_target_session_key:
						"agent:scrum:opencode:scrum:callback:telegram-msg-origin-1",
					callback_relay_session_key: "agent:scrum:telegram:direct:5165741309",
					callback_relay_session_id: "telegram-msg-origin-1",
					project_id: "proj-hook-dispatch-1",
					repo_root: "/tmp/repo-hook-dispatch-1",
					agent_workspace_dir: "/tmp/repo-hook-dispatch-1",
					opencode_server_url: "http://opencode.local",
				},
				continuation: {
					workflowId: "wf-hook-1",
					stepId: "step-hook-1",
					callbackEventKind: "opencode.callback",
					nextOnSuccess: {
						action: "launch_run",
						taskId: "verify-hook-1",
						objective: "Verify callback output",
						prompt: "Run verification now",
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	const oldFetch = globalThis.fetch;
	type FetchCall = { url: string; init?: RequestInit };
	const fetchCalls: FetchCall[] = [];
	globalThis.fetch = async (
		url: URL | RequestInfo,
		init?: RequestInit,
	): Promise<Response> => {
		fetchCalls.push({ url: String(url), init });
		return new Response('{"ok":true}', { status: 202 });
	};
	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: unknown }> = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent(text: string, opts: unknown) {
						systemEvents.push({ text, opts });
						return true;
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);
	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route);
		const payload = {
			name: "OpenCode",
			agentId: "scrum",
			sessionKey: "agent:scrum:opencode:scrum:callback:telegram-msg-origin-1",
			sessionId: "telegram-msg-origin-1",
			wakeMode: "now",
			deliver: false,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "task.completed",
				runId,
				taskId: "task-hook-dispatch-1",
				requestedAgentId: "scrum",
				resolvedAgentId: "creator",
				callbackTargetSessionKey:
					"agent:scrum:opencode:scrum:callback:telegram-msg-origin-1",
				callbackTargetSessionId: "telegram-msg-origin-1",
				callbackRelaySessionKey: "agent:scrum:telegram:direct:5165741309",
				callbackRelaySessionId: "telegram-msg-origin-1",
			}),
		};
		const req = createMockReq(JSON.stringify(payload), "test-token");
		const res = createMockRes();
		const handled = await route.handler(req, res);
		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);
		assert.equal(fetchCalls.length, 1);
		assert.equal(
			fetchCalls[0].url,
			"http://127.0.0.1:18789/hooks/opencode-callback",
		);
		const requestBody = fetchCalls[0].init?.body;
		assert.equal(typeof requestBody, "string");
		if (typeof requestBody !== "string") {
			throw new TypeError("expected request body to be a string");
		}
		const body = JSON.parse(requestBody);
		assert.equal(body.source, "opencode.callback");
		assert.equal(body.runId, runId);
		assert.equal(body.next.action, "launch_run");
		assert.equal(body.next.taskId, "verify-hook-1");
		assert.equal(systemEvents.length, 1);
		assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
	} finally {
		globalThis.fetch = oldFetch;
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("hook continuation payload includes derived loop intent for session.error callback", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-hook-intent-"));
	const stateDir = join(tempRoot, "state");
	const bridgeDir = join(stateDir, "opencode-bridge");
	const runsDir = join(bridgeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(
		join(bridgeDir, "config.json"),
		JSON.stringify(
			{
				opencodeServerUrl: "http://127.0.0.1:4096",
				hookBaseUrl: "http://127.0.0.1:18789",
				hookToken: "test-token",
			},
			null,
			2,
		),
		"utf8",
	);
	const runId = "run-hook-intent-1";
	writeFileSync(
		join(bridgeDir, "config.json"),
		JSON.stringify(
			{
				opencodeServerUrl: "http://127.0.0.1:4096",
				hookBaseUrl: "http://127.0.0.1:18789",
				hookToken: "test-token",
			},
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify(
			{
				taskId: "task-hook-intent-1",
				runId,
				state: "running",
				lastEvent: "task.progress",
				updatedAt: "2000-01-01T00:00:00.000Z",
				envelope: {
					task_id: "task-hook-intent-1",
					run_id: runId,
					agent_id: "scrum",
					requested_agent_id: "scrum",
					resolved_agent_id: "scrum",
					session_key: "hook:opencode:scrum:task-hook-intent-1",
					origin_session_key: "agent:scrum:telegram:direct:5165741309",
					origin_session_id: "probe-session-intent-1",
					callback_target_session_key:
						"agent:scrum:opencode:scrum:callback:probe-session-intent-1",
					callback_relay_session_key: "agent:scrum:telegram:direct:5165741309",
					callback_relay_session_id: "probe-session-intent-1",
					project_id: "TAA",
					repo_root: "/Users/mrcagents/Work/projects/TAA/repo",
					agent_workspace_dir: "/Users/mrcagents/.openclaw/workspace/scrum",
					opencode_server_url: "http://127.0.0.1:50565",
				},
				continuation: {
					workflowId: "wf-hook-intent-1",
					stepId: "step-hook-intent-1",
					callbackEventKind: "opencode.callback",
					nextOnFailure: {
						action: "launch_run",
						taskId: "fix-hook-intent-1",
						objective: "Fix verification failure",
						prompt:
							"Inspect the verification error and continue with the corrective next step",
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	const oldFetch = globalThis.fetch;
	type FetchCall = { url: string; init?: RequestInit };
	const fetchCalls: FetchCall[] = [];
	globalThis.fetch = async (
		url: URL | RequestInfo,
		init?: RequestInit,
	): Promise<Response> => {
		fetchCalls.push({ url: String(url), init });
		return new Response('{"ok":true}', { status: 202 });
	};
	const routes: RegisteredRoute[] = [];
	registerOpenCodeBridgeTools(
		{
			registerTool() {},
			registerHttpRoute(route: RegisteredRoute) {
				routes.push(route);
			},
			runtime: {
				system: {
					enqueueSystemEvent() {
						return true;
					},
				},
			},
		},
		{ hookToken: "test-token" },
	);
	try {
		const route = routes.find(
			(x) => x.path === "/plugin/opencode-bridge/callback",
		);
		assert.ok(route);
		const payload = {
			name: "OpenCode",
			agentId: "scrum",
			sessionKey: "agent:scrum:opencode:scrum:callback:probe-session-intent-1",
			sessionId: "probe-session-intent-1",
			wakeMode: "now",
			deliver: false,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "session.error",
				runId,
				taskId: "task-hook-intent-1",
				requestedAgentId: "scrum",
				resolvedAgentId: "scrum",
				callbackTargetSessionKey:
					"agent:scrum:opencode:scrum:callback:probe-session-intent-1",
				callbackTargetSessionId: "probe-session-intent-1",
				callbackRelaySessionKey: "agent:scrum:telegram:direct:5165741309",
				callbackRelaySessionId: "probe-session-intent-1",
			}),
		};
		const req = createMockReq(JSON.stringify(payload), "test-token");
		const res = createMockRes();
		const handled = await route.handler(req, res);
		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);
		assert.equal(fetchCalls.length, 1);
		const requestBody = fetchCalls[0].init?.body;
		assert.equal(typeof requestBody, "string");
		if (typeof requestBody !== "string") {
			throw new TypeError("expected request body to be a string");
		}
		const body = JSON.parse(requestBody);
		assert.equal(body.intent.kind, "launch_run");
		assert.equal(body.intent.taskId, "fix-hook-intent-1");
		assert.match(
			body.intent.prompt,
			/previous step failed|verification error|corrective next step/i,
		);
	} finally {
		globalThis.fetch = oldFetch;
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
