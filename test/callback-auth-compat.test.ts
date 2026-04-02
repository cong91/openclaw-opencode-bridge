import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import OpenClawBridgeCallbackPlugin from "../opencode-plugin/openclaw-bridge-callback";
import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
	path: string;
	auth: "gateway" | "plugin";
	handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(body: string, headers: Record<string, string>) {
	const req = new EventEmitter() as any;
	req.method = "POST";
	req.url = "/plugin/opencode-bridge/callback";
	req.headers = headers;
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

test("callback http route accepts legacy x-openclaw-token auth header", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: Array<{ text: string; opts: any }> = [];
	const heartbeats: any[] = [];

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
						heartbeats.push(opts);
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
		sessionKey: "session:origin:auth-compat",
		sessionId: "sess-origin-auth-compat",
		wakeMode: "now",
		deliver: false,
		message: JSON.stringify({
			kind: "opencode.callback",
			eventType: "session.idle",
			runId: "run-auth-compat",
			taskId: "task-auth-compat",
			callbackTargetSessionKey: "session:origin:auth-compat",
			callbackTargetSessionId: "sess-origin-auth-compat",
		}),
	};

	const req = createMockReq(JSON.stringify(payload), {
		"x-openclaw-token": "test-token",
	});
	const res = createMockRes();
	const handled = await route!.handler(req, res);

	assert.equal(handled, true);
	assert.equal(res.statusCode, 200);
	assert.equal(systemEvents.length, 1);
	assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
	assert.equal(heartbeats.length, 1);
});

test("OpenCode-side plugin sends bearer auth while preserving legacy header for compatibility", async () => {
	const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
	const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
	const oldFetch = globalThis.fetch;
	const callbackRequests: any[] = [];

	process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
	process.env.OPENCLAW_HOOK_TOKEN = "token-test";

	globalThis.fetch = async (_input: any, init?: any) => {
		callbackRequests.push({
			url: String(_input),
			headers: init?.headers || {},
			body: JSON.parse(String(init?.body || "{}")),
		});
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true }),
		} as any;
	};

	try {
		const plugin = await OpenClawBridgeCallbackPlugin({
			client: { app: { log: async () => {} } },
			directory: process.cwd(),
		} as any);

		await plugin.event({
			event: {
				type: "session.created",
				properties: {
					info: {
						id: "sess-auth-plugin",
						title:
							"demo runId=run-auth-plugin taskId=task-auth-plugin requested=creator resolved=builder callbackSession=session:origin:auth-plugin callbackSessionId=sess-origin-auth-plugin callbackDeliver=false",
					},
				},
			},
		});

		await plugin.event({
			event: {
				type: "message.updated",
				properties: {
					info: {
						sessionID: "sess-auth-plugin",
						finish: "stop",
					},
				},
			},
		});

		assert.equal(callbackRequests.length, 1);
		assert.equal(
			callbackRequests[0]?.url,
			"http://callback.test/hooks/opencode-callback",
		);
		assert.equal(
			callbackRequests[0]?.headers?.Authorization,
			"Bearer token-test",
		);
		assert.equal(
			callbackRequests[0]?.headers?.["x-openclaw-token"],
			"token-test",
		);
		assert.equal(
			callbackRequests[0]?.body?.sessionKey,
			"session:origin:auth-plugin",
		);
	} finally {
		globalThis.fetch = oldFetch;
		if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
		else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
		if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
		else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
	}
});
