import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
  path: string;
  auth: "gateway" | "plugin";
  handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(body: string, token: string) {
  const req = new EventEmitter() as any;
  req.method = "POST";
  req.url = "/plugin/opencode-bridge/callback";
  req.headers = { authorization: `Bearer ${token}` };
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
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(chunk?: string) { if (chunk) this.body += chunk; },
  } as any;
}

test("terminal callback marks callbackCleaned on artifact after attach-run pid cleanup", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-wave2-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(join(bridgeDir, "runs"), { recursive: true });
  const runId = "wave2-run-1";
  const runPath = join(bridgeDir, "runs", `${runId}.json`);
  writeFileSync(runPath, JSON.stringify({
    taskId: "wave2-task-1",
    runId,
    state: "running",
    updatedAt: new Date().toISOString(),
    attachRun: { pid: process.pid, started: true },
    envelope: {
      task_id: "wave2-task-1",
      run_id: runId,
      agent_id: "build",
      requested_agent_id: "creator",
      resolved_agent_id: "build",
      session_key: "hook:opencode:build:wave2-task-1",
      origin_session_key: "session:origin:wave2",
      callback_target_session_key: "session:origin:wave2",
      callback_target_session_id: "sess-wave2",
      project_id: "proj-wave2",
      repo_root: "/tmp/proj-wave2",
      opencode_server_url: "http://127.0.0.1:60000"
    }
  }, null, 2), "utf8");

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const routes: RegisteredRoute[] = [];
  registerOpenCodeBridgeTools({
    registerTool() {},
    registerHttpRoute(route: RegisteredRoute) { routes.push(route); },
    runtime: { system: { enqueueSystemEvent() { return true; }, requestHeartbeatNow() {} } }
  }, { hookToken: "test-token" });

  try {
    const route = routes.find((x) => x.path === "/plugin/opencode-bridge/callback");
    assert.ok(route);
    const payload = {
      name: "OpenCode",
      agentId: "creator",
      sessionKey: "session:origin:wave2",
      sessionId: "sess-wave2",
      wakeMode: "now",
      deliver: false,
      message: JSON.stringify({ kind: "opencode.callback", eventType: "message.updated", runId, taskId: "wave2-task-1" })
    };
    const handled = await route!.handler(createMockReq(JSON.stringify(payload), "test-token"), createMockRes());
    assert.equal(handled, true);
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.equal(persisted.callbackCleaned, true);
    assert.equal(persisted.attachRun.killSignal, "SIGTERM");
  } finally {
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
