import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = { name: string; execute: (_id: string, params: any) => Promise<any> };
function parseToolJson(result: any) { return JSON.parse(result.content[0].text); }
async function withMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: async () => await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}
function setupHarness(configFile: any) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-wave3-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const tools = new Map<string, RegisteredTool>();
  registerOpenCodeBridgeTools({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } }, {});
  return { stateDir, tools, cleanup() { if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prevStateDir; rmSync(tempRoot, { recursive: true, force: true }); } };
}

test("opencode_run_events returns project context and progression summary", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/session") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: "sess-wave3-1", directory: "/tmp/wave3", title: "runId=run-wave3-1 repoRoot=/tmp/wave3", time: { updated: Date.now() } }])); return; }
    if (url === "/event") {
      res.setHeader("content-type", "text/event-stream");
      res.end([
        "event: message",
        "data: {\"type\":\"task.progress\",\"run_id\":\"run-wave3-1\",\"message\":\"spawn @explore\"}",
        "",
        "event: message",
        "data: {\"type\":\"task.completed\",\"run_id\":\"run-wave3-1\"}",
        ""
      ].join("\n"));
      return;
    }
    res.statusCode = 404; res.end("not found");
  });
  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-wave3-1.json"), JSON.stringify({
      taskId: "task-wave3-1",
      runId: "run-wave3-1",
      state: "running",
      updatedAt: new Date().toISOString(),
      callbackOk: true,
      envelope: { task_id: "task-wave3-1", run_id: "run-wave3-1", agent_id: "build", requested_agent_id: "creator", resolved_agent_id: "build", session_key: "hook:opencode:build:task-wave3-1", origin_session_key: "session:origin:wave3", callback_target_session_key: "session:origin:wave3", project_id: "proj-wave3", repo_root: "/tmp/wave3", opencode_server_url: mock.baseUrl }
    }, null, 2), "utf8");
    const tool = harness.tools.get("opencode_run_events");
    assert.ok(tool);
    const payload = parseToolJson(await tool!.execute("test", { runId: "run-wave3-1", opencodeServerUrl: mock.baseUrl, scope: "session" }));
    assert.equal(payload.projectId, "proj-wave3");
    assert.equal(payload.repoRoot, "/tmp/wave3");
    assert.equal(payload.progressionSummary.hasStarted, true);
    assert.equal(payload.progressionSummary.hasSubagentActivity, true);
    assert.equal(payload.progressionSummary.hasTerminalEvent, true);
  } finally {
    await mock.close();
    harness.cleanup();
  }
});

test("opencode_session_tail returns project context and resolvedFrom semantics", async () => {
  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/session") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: "sess-wave3-tail", directory: "/tmp/wave3-tail", title: "runId=run-wave3-tail repoRoot=/tmp/wave3-tail", time: { updated: Date.now() } }])); return; }
    if (url === "/session/sess-wave3-tail/message") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: "msg-1", role: "assistant", text: "done" }])); return; }
    if (url === "/session/sess-wave3-tail/diff") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([])); return; }
    res.statusCode = 404; res.end("not found");
  });
  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-wave3-tail.json"), JSON.stringify({
      taskId: "task-wave3-tail",
      runId: "run-wave3-tail",
      state: "running",
      updatedAt: new Date().toISOString(),
      sessionId: "sess-wave3-tail",
      envelope: { task_id: "task-wave3-tail", run_id: "run-wave3-tail", agent_id: "build", requested_agent_id: "creator", resolved_agent_id: "build", session_key: "hook:opencode:build:task-wave3-tail", origin_session_key: "session:origin:wave3-tail", callback_target_session_key: "session:origin:wave3-tail", project_id: "proj-wave3-tail", repo_root: "/tmp/wave3-tail", opencode_server_url: mock.baseUrl }
    }, null, 2), "utf8");
    const tool = harness.tools.get("opencode_session_tail");
    assert.ok(tool);
    const payload = parseToolJson(await tool!.execute("test", { runId: "run-wave3-tail", opencodeServerUrl: mock.baseUrl }));
    assert.equal(payload.projectId, "proj-wave3-tail");
    assert.equal(payload.repoRoot, "/tmp/wave3-tail");
    assert.equal(payload.resolvedFrom, "artifact_session_id");
    assert.equal(payload.sessionId, "sess-wave3-tail");
  } finally {
    await mock.close();
    harness.cleanup();
  }
});
