import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cleanupExpiredServes } from "../src/runtime";

const tmpDir = "/tmp/opencode-bridge-idle-cleanup-test";
const stateDir = join(tmpDir, ".openclaw", "opencode-bridge");
const registryPath = join(stateDir, "serves.json");

test("cleanupExpiredServes stops only idle entries and preserves busy runtime sessions", async () => {
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(stateDir, { recursive: true });
	process.env.OPENCLAW_STATE_DIR = join(tmpDir, ".openclaw");

	const now = Date.now();
	writeFileSync(
		registryPath,
		JSON.stringify(
			{
				entries: [
					{
						project_id: "idle-proj",
						repo_root: "/tmp/idle-proj",
						opencode_server_url: "http://127.0.0.1:5001",
						pid: 999999,
						status: "running",
						last_event_at: new Date(now - 20_000).toISOString(),
						idle_timeout_ms: 5_000,
						updated_at: new Date(now - 20_000).toISOString(),
					},
					{
						project_id: "busy-proj",
						repo_root: "/tmp/busy-proj",
						opencode_server_url: "http://127.0.0.1:5002",
						pid: 999998,
						status: "running",
						last_event_at: new Date(now - 20_000).toISOString(),
						idle_timeout_ms: 5_000,
						updated_at: new Date(now - 20_000).toISOString(),
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: string | URL | Request) => {
		const url = String(typeof input === "string" ? input : (input as any)?.url);
		let body: unknown = null;
		if (url.includes("5001") && url.endsWith("/session/status")) body = {};
		if (url.includes("5001") && url.endsWith("/session")) body = [];
		if (url.includes("5002") && url.endsWith("/session/status")) {
			body = { "sess-busy": { type: "busy" } };
		}
		if (url.includes("5002") && url.endsWith("/session")) {
			body = [{ id: "sess-busy" }];
		}
		if (body === null) {
			return new Response("unexpected url", { status: 500 });
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	try {
		const result = await cleanupExpiredServes(now);
		assert.equal(result.ok, true);
		assert.equal(result.stopped, 1);
		const idle = result.results.find((x) => x.project_id.includes(":5001"));
		const busy = result.results.find((x) => x.project_id.includes(":5002"));
		assert.equal(idle?.status, "stopped");
		assert.equal(idle?.reason, "idle_timeout_exceeded");
		assert.equal(busy?.status, "running");
		assert.equal(busy?.reason, "runtime_busy_session_detected");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
