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
	const heartbeatCalls: any[] = [];
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
					requestHeartbeatNow(opts: any) {
						heartbeatCalls.push(opts);
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
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "sess-origin-1",
		wakeMode: "now",
		deliver: true,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-1",
			taskId: "task-visible-1",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "sess-origin-1",
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
	assert.equal(systemEvents[0]?.opts?.sessionId, payload.sessionId);
	assert.doesNotMatch(
		systemEvents[0].text,
		/OpenCode callback received for run run-visible-1; code finished; agent is continuing\./,
	);
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
	assert.equal(telegramSends.length, 1);
	assert.equal(telegramSends[0]?.to, "5165741309");
	assert.equal(telegramSends[0]?.text, "Background run update received.");
	assert.equal(telegramSends[0]?.opts?.silent, false);
	assert.equal(
		telegramSends[0]?.opts?.contextKey,
		"opencode:run-visible-1:message.updated:callback-ingress-telegram",
	);
});

test("callback http route still avoids user-visible ack text even when deliver=false", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const heartbeatCalls: any[] = [];
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
					requestHeartbeatNow(opts: any) {
						heartbeatCalls.push(opts);
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
		sessionKey: "agent:creator:telegram:direct:5165741309",
		sessionId: "sess-origin-2",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-visible-2",
			taskId: "task-visible-2",
			callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
			callbackTargetSessionId: "sess-origin-2",
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
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(heartbeatCalls[0]?.agentId, payload.agentId);
	assert.equal(telegramSends.length, 0);
});

test("callback http route does not send telegram notify for non-direct telegram session even when deliver=true", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const heartbeatCalls: any[] = [];
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
					requestHeartbeatNow(opts: any) {
						heartbeatCalls.push(opts);
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
		sessionKey: "agent:creator:telegram:group:-10011223344",
		sessionId: "sess-group-1",
		wakeMode: "now",
		deliver: true,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "message.updated",
			runId: "run-group-1",
			taskId: "task-group-1",
			callbackTargetSessionKey: "agent:creator:telegram:group:-10011223344",
			callbackTargetSessionId: "sess-group-1",
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
	assert.equal(heartbeatCalls.length, 1);
	assert.equal(heartbeatCalls[0]?.sessionKey, payload.sessionKey);
	assert.equal(heartbeatCalls[0]?.sessionId, payload.sessionId);
	assert.equal(telegramSends.length, 0);
});

test("callback http route sends exactly one telegram notify when continuation notify exists (no duplicate ingress ack)", async () => {
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
					callback_target_session_key:
						"agent:creator:telegram:direct:5165741309",
					callback_target_session_id: "sess-origin-continue-1",
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
	const heartbeatCalls: any[] = [];
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
					requestHeartbeatNow(opts: any) {
						heartbeatCalls.push(opts);
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
			sessionKey: "agent:creator:telegram:direct:5165741309",
			sessionId: "sess-origin-continue-1",
			wakeMode: "now",
			deliver: true,
			message: JSON.stringify({
				kind: "opencode.callback",
				eventType: "task.completed",
				runId: "run-visible-continue-1",
				taskId: "task-visible-continue-1",
				callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
				callbackTargetSessionId: "sess-origin-continue-1",
				opencodeSessionId: "oc-sess-continue-1",
			}),
		};

		const req = createMockReq(JSON.stringify(payload), "test-token");
		const res = createMockRes();
		const handled = await route!.handler(req, res);

		assert.equal(handled, true);
		assert.equal(res.statusCode, 200);
		assert.equal(systemEvents.length, 1);
		assert.match(systemEvents[0].text, /<opencode_callback_control_internal>/);
		assert.equal(heartbeatCalls.length, 1);
		assert.equal(telegramSends.length, 1);
		assert.equal(telegramSends[0]?.to, "5165741309");
		assert.equal(
			telegramSends[0]?.text,
			"Follow-up notification for direct session",
		);
		assert.equal(
			telegramSends[0]?.opts?.contextKey,
			"opencode:run-visible-continue-1:task.completed:continuation-notify-telegram",
		);
	} finally {
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
