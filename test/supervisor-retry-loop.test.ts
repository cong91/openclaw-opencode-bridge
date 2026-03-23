import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = { name: string; execute: (_id: string, params: any) => Promise<any> };

function parseToolJson(result: any) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string);
}

async function withMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function setupHarness(configFile: any) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-retry-test-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const tools = new Map<string, RegisteredTool>();
  registerOpenCodeBridgeTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } }, {});
  return {
    stateDir,
    tools,
    cleanup() {
      if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prevStateDir;
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test("supervisor loop auto-retries retryable attach-run once before terminal completion", async () => {
  let eventReadCount = 0;
  let callbackCount = 0;
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;

  const mock = await withMockServer(async (req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true }));
      return;
    }
    if (req.method === "GET" && url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "sess-retry-1", title: "task-retry-1 runId=run-retry-1 taskId=task-retry-1 requested=creator resolved=creator callbackSession=session:origin:retry-1 callbackSessionId=origin-retry-1 projectId=proj-retry-1 repoRoot=" + repoRoot, time: { updated: 10 } }]));
      return;
    }
    if (req.method === "GET" && (url === "/event" || url === "/global/event")) {
      eventReadCount += 1;
      res.setHeader("content-type", "text/event-stream");
      if (eventReadCount < 3) {
        res.end(["event: message", "data: {\"type\":\"task.progress\",\"run_id\":\"run-retry-1\",\"task_id\":\"task-retry-1\",\"session_id\":\"sess-retry-1\",\"text\":\"still running\"}", ""].join("\n"));
        return;
      }
      res.end(["event: message", "data: {\"type\":\"task.completed\",\"run_id\":\"run-retry-1\",\"task_id\":\"task-retry-1\",\"session_id\":\"sess-retry-1\",\"text\":\"done after retry\"}", ""].join("\n"));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-retry-1/message") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-retry-1/diff") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
      return;
    }
    if (req.method === "POST" && url === "/hooks/agent") {
      callbackCount += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, hookBaseUrl: mock.baseUrl, hookToken: "test-token", maxAutoRetries: 1 });
  const repoRoot = join(harness.stateDir, "repo-retry-1");
  mkdirSync(repoRoot, { recursive: true });
  const fakeBinDir = join(harness.stateDir, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(fakeBinDir, "opencode"), '#!/bin/sh\nif [ "$1" = "run" ]; then if [ -f "$PWD/.retry-once" ]; then exit 0; else touch "$PWD/.retry-once"; exit 1; fi; fi\nif [ "$1" = "serve" ]; then exit 0; fi\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
  process.env.PATH = `${fakeBinDir}:${originalPath || ""}`;

  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith(mock.baseUrl)) return originalFetch(input, init);
    if (typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const rewritten = mock.baseUrl + url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      return originalFetch(rewritten, init);
    }
    throw new Error(`unexpected fetch target: ${String(url)}`);
  };

  try {
    const tool = harness.tools.get("opencode_execute_task");
    assert.ok(tool);
    const result = await tool!.execute("test", {
      taskId: "task-retry-1",
      runId: "run-retry-1",
      agentId: "creator",
      originSessionKey: "session:origin:retry-1",
      originSessionId: "origin-retry-1",
      projectId: "proj-retry-1",
      repoRoot,
      objective: "retry loop test",
      pollIntervalMs: 250,
      maxWaitMs: 300,
    });
    parseToolJson(result);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const runStatus = JSON.parse(readFileSync(join(harness.stateDir, "opencode-bridge", "runs", "run-retry-1.json"), "utf8"));
    assert.equal(runStatus.state, "completed");
    assert.equal(runStatus.retryCount, 1);
    assert.equal(runStatus.supervisorState, "completed");
    assert.equal(Array.isArray(runStatus.retryHistory), true);
    assert.equal(runStatus.retryHistory.length, 1);
    assert.equal(callbackCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    await mock.close();
    harness.cleanup();
  }
});
