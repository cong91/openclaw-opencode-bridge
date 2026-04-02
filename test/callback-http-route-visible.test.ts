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
			: { authorization: "Bearer " + token };
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

test("callback http route forwards to custom hook when configured", async () => {
	const routes: RegisteredRoute[] = [];
	const systemEvents: any[] = [];
	const api = {
		registerHttpRoute(route: RegisteredRoute) {
			routes.push(route);
		},
		registerTool() {},
		runtime: {
			system: {
				enqueueSystemEvent(text: string, opts: any) {
					systemEvents.push({ text, opts });
				},
			},
		},
	};

	const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-test-"));
	const stateDir = join(tempRoot, "state");
	mkdirSync(join(stateDir, "opencode-bridge"), { recursive: true });
	writeFileSync(join(stateDir, "opencode-bridge", "config.json"), JSON.stringify({ hookBaseUrl: "http://callback.test", hookToken: "token-test" }), "utf8");

	const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
	const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;
	const oldStateDir = process.env.OPENCLAW_STATE_DIR;
	const oldFetch = globalThis.fetch;
	const fetchCalls: any[] = [];

	process.env.OPENCLAW_HOOK_BASE_URL = "http://callback.test";
	process.env.OPENCLAW_HOOK_TOKEN = "token-test";
	process.env.OPENCLAW_STATE_DIR = stateDir;
	globalThis.fetch = async (input: any, init?: any) => {
		fetchCalls.push({ input, init });
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, routed: true }),
		} as any;
	};

	try {
		registerOpenCodeBridgeTools(api, {});
		const handler = routes.find(
			(r) => r.path === "/plugin/opencode-bridge/callback",
		)?.handler;
		assert.ok(handler);

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

		const req = createMockReq(JSON.stringify(payload), "token-test");
		const res = createMockRes();

		await handler(req, res);

		assert.equal(res.statusCode, 200);
		assert.match(res.body, /"ok":true/);
		assert.match(res.body, /"runId":"run-visible-1"/);

		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0].input, "http://callback.test/hooks/opencode-callback");
		assert.equal(fetchCalls[0].init.method, "POST");
		assert.equal(fetchCalls[0].init.headers["Authorization"], "Bearer token-test");
		assert.match(fetchCalls[0].init.body, /run-visible-1/);

		
	} finally {
		if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
		else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
		if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
		else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
		if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = oldStateDir;
		globalThis.fetch = oldFetch;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
