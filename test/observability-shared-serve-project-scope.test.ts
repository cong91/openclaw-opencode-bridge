import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredTool = {
  name: string;
  execute: (_id: string, params: any) => Promise<any>;
};

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
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function setupHarness(configFile: any) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-shared-serve-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify(configFile, null, 2), "utf8");

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };
  registerOpenCodeBridgeTools(api, {});

  return {
    stateDir,
    tools,
    cleanup() {
      if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevStateDir;
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test("observability resolves session within the correct project on a shared serve", async () => {
  const projectA = "/tmp/project-a";
  const projectB = "/tmp/project-b";

  const mock = await withMockServer((req, res) => {
    const url = req.url || "/";
    if (url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (url === "/session") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "sess-project-b", time: { updated: 999 }, directory: projectB, metadata: { projectID: "proj-b", run_id: "run-shared-1" } },
          { id: "sess-project-a", time: { updated: 100 }, directory: projectA, metadata: { projectID: "proj-a", session_key: "session:origin:shared-a" } },
        ])
      );
      return;
    }
    if (url === "/session/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/event") {
      res.setHeader("content-type", "text/event-stream");
      res.end(["event: message", "data: {\"type\":\"task.progress\",\"run_id\":\"run-shared-1\"}", ""].join("\n"));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const harness = setupHarness({ opencodeServerUrl: mock.baseUrl, projectRegistry: [] });
  try {
    const runDir = join(harness.stateDir, "opencode-bridge", "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-shared-1.json"),
      JSON.stringify(
        {
          taskId: "task-shared-1",
          runId: "run-shared-1",
          state: "running",
          updatedAt: new Date().toISOString(),
          envelope: {
            task_id: "task-shared-1",
            run_id: "run-shared-1",
            agent_id: "build",
            requested_agent_id: "creator",
            resolved_agent_id: "build",
            session_key: "hook:opencode:build:task-shared-1",
            origin_session_key: "session:origin:shared-a",
            callback_target_session_key: "session:origin:shared-a",
            project_id: "proj-a",
            repo_root: projectA,
            opencode_server_url: mock.baseUrl,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const tool = harness.tools.get("opencode_run_status");
    assert.ok(tool, "opencode_run_status should be registered");
    const result = await tool!.execute("test", { runId: "run-shared-1", opencodeServerUrl: mock.baseUrl });
    const payload = parseToolJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, "sess-project-a");
  } finally {
    await mock.close();
    harness.cleanup();
  }
});
