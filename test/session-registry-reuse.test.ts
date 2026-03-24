import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { startExecutionRun, buildEnvelope } from "../src/runtime";

async function withMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

test("startExecutionRun reuses project session from registry and updates registry metadata", async () => {
  let createSessionCount = 0;
  let promptAsyncCount = 0;

  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (req.method === "POST" && url === "/session") {
      createSessionCount += 1;
      assert.equal(req.headers["x-opencode-directory"], repoRoot);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "sess-new", title: "new session" }));
      return;
    }
    if (req.method === "POST" && url === "/session/sess-existing/prompt_async") {
      promptAsyncCount += 1;
      assert.equal(req.headers["x-opencode-directory"], repoRoot);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([
        {
          id: "sess-existing",
          title: "existing session title",
          time: { updated: 1774341000000 },
        },
      ]));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const tempRoot = mkdtempSync(join(tmpdir(), "opb-session-registry-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  const repoRoot = join(tempRoot, "repo");
  mkdirSync(bridgeDir, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;

  writeFileSync(
    join(bridgeDir, "serves.json"),
    JSON.stringify({
      entries: [
        {
          serve_id: mock.baseUrl,
          opencode_server_url: mock.baseUrl,
          status: "running",
          updated_at: new Date().toISOString(),
        },
      ],
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(bridgeDir, "sessions.json"),
    JSON.stringify({
      entries: [
        {
          session_id: "sess-existing",
          serve_id: mock.baseUrl,
          opencode_server_url: mock.baseUrl,
          directory: repoRoot,
          project_id: "proj-1",
          status: "active",
          is_current_for_directory: true,
          updated_at: new Date().toISOString(),
        },
      ],
    }, null, 2),
    "utf8",
  );

  try {
    const envelope = buildEnvelope({
      taskId: "task-1",
      runId: "run-1",
      requestedAgentId: "creator",
      resolvedAgentId: "creator",
      originSessionKey: "session:origin:1",
      originSessionId: "origin-1",
      projectId: "proj-1",
      repoRoot,
      serverUrl: mock.baseUrl,
      deliver: true,
    });

    const result = await startExecutionRun({
      cfg: {},
      envelope,
      prompt: "hello world",
      model: "proxy/gpt-5.4",
    });

    assert.equal(result.ok, true);
    assert.equal(result.sessionId, "sess-existing");
    assert.equal(result.sessionMode, "reused");
    assert.equal(createSessionCount, 0);
    assert.equal(promptAsyncCount, 1);

    const serveRegistry = JSON.parse(readFileSync(join(bridgeDir, "serves.json"), "utf8"));
    const serveEntry = serveRegistry.entries[0];
    assert.equal(serveEntry.serve_id, mock.baseUrl);
    const sessionRegistry = JSON.parse(readFileSync(join(bridgeDir, "sessions.json"), "utf8"));
    const entry = sessionRegistry.entries.find((x: any) => x.session_id === "sess-existing");
    assert.equal(entry.session_id, "sess-existing");
    assert.equal(entry.session_title, "existing session title");
    assert.ok(entry.session_updated_at);
    assert.equal(entry.is_current_for_directory, true);
  } finally {
    await mock.close();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
  }
});
