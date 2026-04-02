import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEnvelope, startExecutionRun } from "../src/runtime";

async function withMockServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
	const server = createServer(handler);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const baseUrl = `http://127.0.0.1:${port}`;
	return {
		baseUrl,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}

test("startExecutionRun persists resolved opencode session id for attach-run", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "opb-attach-session-persist-"));
	const stateDir = join(tempRoot, "state");
	const repoRoot = join(tempRoot, "repo");
	mkdirSync(repoRoot, { recursive: true });
	const prevStateDir = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const mock = await withMockServer((req, res) => {
		const url = req.url || "/";
		if (url === "/session") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						id: "sess-attach-persist-1",
						title: `task-attach-session runId=run-attach-session-1 taskId=task-attach-session-1 requested=creator resolved=build callbackSession=agent:creator:opencode:creator:callback:04577833-156b-4989-80ab-13067a0949f3 originSession=agent:creator:telegram:direct:5165741309 originSessionId=04577833-156b-4989-80ab-13067a0949f3 callbackRelaySession=agent:creator:telegram:direct:5165741309 callbackRelaySessionId=04577833-156b-4989-80ab-13067a0949f3 callbackDeliver=false projectId=proj-attach-session repoRoot=${repoRoot}`,
						directory: repoRoot,
						time: { updated: Date.now() },
					},
				]),
			);
			return;
		}
		if (url === "/global/health") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ healthy: true }));
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	try {
		const envelope = buildEnvelope({
			taskId: "task-attach-session-1",
			runId: "run-attach-session-1",
			requestedAgentId: "creator",
			resolvedAgentId: "build",
			originSessionKey: "agent:creator:telegram:direct:5165741309",
			originSessionId: "04577833-156b-4989-80ab-13067a0949f3",
			projectId: "proj-attach-session",
			repoRoot,
			serverUrl: mock.baseUrl,
			deliver: false,
			priority: "high",
		});

		const result = await startExecutionRun({
			cfg: {},
			envelope,
			prompt: "Implement test task",
			model: "proxy/gpt-5.4",
			continuation: { promptVariant: "high", thinking: true },
		});

		assert.equal(result.ok, true);
		const runPath = join(
			stateDir,
			"opencode-bridge",
			"runs",
			"run-attach-session-1.json",
		);
		const persisted = JSON.parse(readFileSync(runPath, "utf8"));
		assert.equal(persisted.sessionId, "sess-attach-persist-1");
		assert.equal(persisted.opencodeSessionId, "sess-attach-persist-1");
		assert.equal(persisted.sessionResolutionPending, false);
		assert.equal(persisted.sessionResolutionStrategy, "title_match");

		const sessionsPath = join(stateDir, "opencode-bridge", "sessions.json");
		assert.equal(existsSync(sessionsPath), true);
		const sessionsRegistry = JSON.parse(readFileSync(sessionsPath, "utf8"));
		assert.equal(Array.isArray(sessionsRegistry.entries), true);
		const current = sessionsRegistry.entries.find(
			(entry: any) => entry.session_id === "sess-attach-persist-1",
		);
		assert.equal(current?.opencode_server_url, mock.baseUrl);
		assert.equal(current?.directory, repoRoot);
		assert.equal(current?.project_id, "proj-attach-session");
		assert.equal(current?.is_current_for_directory, true);
		assert.equal(current?.status, "active");
	} finally {
		await mock.close();
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
