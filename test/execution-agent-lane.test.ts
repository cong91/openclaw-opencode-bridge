import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerOpenCodeBridgeTools } from "../src/registrar";

test("opencode_execute_task passes explicit executionAgentId into attach-run --agent", async () => {
  const tools = new Map<string, any>();
  const tempRoot = mkdtempSync(join(tmpdir(), "opb-agent-lane-"));
  mkdirSync(join(tempRoot, "repo"), { recursive: true });

  registerOpenCodeBridgeTools(
    {
      registerTool(def: any) {
        tools.set(def.name, def.execute);
      },
      registerHttpRoute() {},
      runtime: {
        system: {
          enqueueSystemEvent() {
            return true;
          },
          requestHeartbeatNow() {},
        },
      },
    },
    { hookToken: "test-token" },
  );

  const execTool = tools.get("opencode_execute_task");
  assert.ok(execTool, "opencode_execute_task should be registered");

  try {
    const result = await execTool("tool-1", {
      taskId: "task-agent-lane-1",
      runId: "run-agent-lane-1",
      agentId: "creator",
      executionAgentId: "plan",
      originSessionKey: "agent:creator:telegram:direct:5165741309",
      originSessionId: "04577833-156b-4989-80ab-13067a0949f3",
      projectId: "proj-agent-lane-1",
      repoRoot: join(tempRoot, "repo"),
      prompt: "Create implementation plan only.",
      objective: "Plan the work, do not code.",
      message: "plan lane test",
      constraints: [],
      acceptanceCriteria: [],
      channel: "telegram",
      to: "5165741309",
      deliver: false,
      priority: "high",
      model: "proxy/gpt-5.4",
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.envelope.resolved_agent_id, "plan");
    assert.equal(payload.execution.ok, true);
    assert.equal(payload.execution.attachRun.command, "opencode");
    assert.ok(payload.execution.attachRun.args.includes("--agent"));
    assert.ok(payload.execution.attachRun.args.includes("plan"));
    assert.ok(payload.execution.attachRun.args.includes("--variant"));
    assert.ok(payload.execution.attachRun.args.includes("high"));
    assert.ok(payload.execution.attachRun.args.includes("--thinking"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
