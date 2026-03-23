import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = {
  name: string;
  execute: (_id: string, params: any) => Promise<any>;
};

function swallowSpawnEnoent(error: any) {
  if (error?.code === "ENOENT" && String(error?.message || "").includes("spawn opencode")) {
    return;
  }
  throw error;
}

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
  const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-timeout-test-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const tools = new Map<string, RegisteredTool>();
  const api = { registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } };
  registerOpenCodeBridgeTools(api, {});
  return {
    stateDir,
    tools,
    cleanup() {
      if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prevStateDir;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

test("attach-run timeout promotes materialized output to verifying instead of failing white", async () => {
  let eventReads = 0;
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  const mock = await withMockServer(async (req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (req.method === "GET" && url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "sess-timeout-1", title: "task-timeout-1 runId=run-timeout-1 taskId=task-timeout-1 requested=creator resolved=creator callbackSession=session:origin:timeout-1 callbackSessionId=origin-timeout-1 projectId=proj-timeout-1 repoRoot=/tmp/repo-timeout-1", time: { updated: 10 } }]));
      return;
    }
    if (req.method === "GET" && (url === "/event" || url === "/global/event")) {
      eventReads += 1;
      res.setHeader("content-type", "text/event-stream");
      res.end(["event: message","data: {\"type\":\"task.progress\",\"run_id\":\"run-timeout-1\",\"task_id\":\"task-timeout-1\",\"session_id\":\"sess-timeout-1\",\"text\":\"working\"}",""].join("\n"));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-timeout-1/message") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ info: { id: "msg-1" }, parts: [{ type: "text", text: "partial output" }] }]));
      return;
    }
    if (req.method === "GET" && url === "/session/sess-timeout-1/diff") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, hookBaseUrl: mock.baseUrl, hookToken: "test-token" });
  const repoRoot = "/tmp/repo-timeout-1";
  mkdirSync(repoRoot, { recursive: true });
  const fakeBinDir = join(harness.stateDir, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(fakeBinDir, "opencode"), '#!/bin/sh\nif [ "$1" = "run" ]; then exit 0; fi\nif [ "$1" = "serve" ]; then exit 0; fi\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
  process.env.PATH = `${fakeBinDir}:${originalPath || ""}`;
  process.on("uncaughtException", swallowSpawnEnoent);

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
    const tool = harness.tools.get('opencode_execute_task');
    assert.ok(tool);
    const result = await tool!.execute('test', {
      taskId: 'task-timeout-1',
      runId: 'run-timeout-1',
      agentId: 'creator',
      originSessionKey: 'session:origin:timeout-1',
      originSessionId: 'origin-timeout-1',
      projectId: 'proj-timeout-1',
      repoRoot,
      objective: 'Timeout classification test',
      pollIntervalMs: 50,
      maxWaitMs: 120,
    });
    parseToolJson(result);
    const runPath = join(harness.stateDir, 'opencode-bridge', 'runs', 'run-timeout-1.json');
    let runStatus: any = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runStatus = JSON.parse(readFileSync(runPath, 'utf8'));
      if (runStatus.watcherCompletedAt || runStatus.state !== 'running') break;
    }
    if (runStatus.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      runStatus = JSON.parse(readFileSync(runPath, 'utf8'));
    }
    assert.equal(runStatus.state, 'verifying');
    assert.equal(runStatus.watcherState, 'completed');
    assert.equal(typeof runStatus.lastSummary, 'string');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    process.off("uncaughtException", swallowSpawnEnoent);
    await mock.close();
    harness.cleanup();
  }
});
