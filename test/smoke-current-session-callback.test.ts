import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenClawBridgeCallbackPlugin from "../opencode-plugin/openclaw-bridge-callback";
import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
  path: string;
  auth: "gateway" | "plugin";
  handler: (req: any, res: any) => Promise<boolean>;
};

type SystemEvent = { text: string; opts: any };

function createMockReq(body: string, token: string) {
  const chunks = [Buffer.from(body, "utf8")];
  let dataHandler: ((chunk: Buffer) => void) | undefined;
  let endHandler: (() => void) | undefined;
  return {
    method: "POST",
    url: "/plugin/opencode-bridge/callback",
    headers: { authorization: `Bearer ${token}` },
    on(event: string, handler: any) {
      if (event === "data") dataHandler = handler;
      if (event === "end") endHandler = handler;
      if (dataHandler && endHandler) {
        process.nextTick(() => {
          for (const chunk of chunks) dataHandler?.(chunk);
          endHandler?.();
        });
      }
      return this;
    },
  } as any;
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

test("smoke: terminal plugin callback wakes current session and enqueues continuation notify", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-smoke-"));
  const stateDir = join(tempRoot, "state");
  const bridgeDir = join(stateDir, "opencode-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, "config.json"),
    JSON.stringify({ hookToken: "smoke-token" }, null, 2),
    "utf8",
  );

  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const routes: RegisteredRoute[] = [];
  const systemEvents: SystemEvent[] = [];
  const heartbeatCalls: any[] = [];
  const callbackPosts: any[] = [];
  const oldFetch = globalThis.fetch;
  const oldHookBase = process.env.OPENCLAW_HOOK_BASE_URL;
  const oldHookToken = process.env.OPENCLAW_HOOK_TOKEN;

  process.env.OPENCLAW_HOOK_BASE_URL = "http://openclaw.local";
  process.env.OPENCLAW_HOOK_TOKEN = "smoke-token";

  registerOpenCodeBridgeTools(
    {
      registerTool() {},
      registerHttpRoute(route: RegisteredRoute) {
        routes.push(route);
      },
      runtime: {
        system: {
          enqueueSystemEvent(text: string, opts: any) {
            systemEvents.push({ text, opts });
            return true;
          },
          requestHeartbeatNow(opts: any) {
            heartbeatCalls.push(opts);
          },
        },
      },
    },
    {
      hookToken: "smoke-token",
    },
  );

  const route = routes.find((x) => x.path === "/plugin/opencode-bridge/callback");
  assert.ok(route, "callback route should be registered");

  mkdirSync(join(bridgeDir, "runs"), { recursive: true });

  writeFileSync(
    join(bridgeDir, "runs", "run-smoke-1.json"),
    JSON.stringify(
      {
        taskId: "task-smoke-1",
        runId: "run-smoke-1",
        state: "running",
        updatedAt: new Date().toISOString(),
        envelope: {
          task_id: "task-smoke-1",
          run_id: "run-smoke-1",
          agent_id: "builder",
          requested_agent_id: "creator",
          resolved_agent_id: "builder",
          session_key: "hook:opencode:builder:task-smoke-1",
          origin_session_key: "session:origin:smoke-1",
          origin_session_id: "sess-origin-smoke-1",
          callback_target_session_key: "session:origin:smoke-1",
          callback_target_session_id: "sess-origin-smoke-1",
          project_id: "proj-smoke-1",
          repo_root: "/tmp/repo-smoke-1",
          opencode_server_url: "http://opencode.local",
        },
        continuation: {
          callbackEventKind: "opencode.callback",
          workflowId: "wf-smoke-1",
          stepId: "step-smoke-1",
          nextOnSuccess: {
            action: "notify",
            taskId: "task-followup-1",
            objective: "Verify current session resumed after callback",
          },
          nextOnFailure: {
            action: "none",
            taskId: "task-failure-1",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  globalThis.fetch = async (_input: any, init?: any) => {
    callbackPosts.push({
      headers: init?.headers || {},
      body: JSON.parse(String(init?.body || "{}")),
    });
    const req = createMockReq(String(init?.body || "{}"), "smoke-token");
    const res = createMockRes();
    await route!.handler(req, res);
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      text: async () => res.body || JSON.stringify({ ok: true }),
    } as any;
  };

  try {
    const plugin = await OpenClawBridgeCallbackPlugin({
      client: { app: { log: async () => {} } },
      directory: tempRoot,
    } as any);

    await plugin.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "sess-opencode-smoke-1",
            title:
              "task-smoke-1 runId=run-smoke-1 taskId=task-smoke-1 requested=creator resolved=builder callbackSession=session:origin:smoke-1 callbackSessionId=sess-origin-smoke-1 workflowId=wf-smoke-1 stepId=step-smoke-1",
          },
        },
      },
    });

    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID: "sess-opencode-smoke-1",
            finish: "stop",
          },
        },
      },
    });

    assert.equal(callbackPosts.length, 1);
    assert.equal(callbackPosts[0]?.headers?.Authorization, "Bearer smoke-token");
    assert.equal(callbackPosts[0]?.body?.sessionKey, "session:origin:smoke-1");
    assert.equal(callbackPosts[0]?.body?.sessionId, "sess-origin-smoke-1");

    assert.equal(heartbeatCalls.length, 1);
    assert.equal(systemEvents.length, 2);
    assert.equal(systemEvents[0]?.opts?.sessionKey, "session:origin:smoke-1");
    assert.match(systemEvents[0]?.text, /"kind":"opencode.callback"/);
    assert.equal(systemEvents[1]?.opts?.sessionKey, "session:origin:smoke-1");
    assert.match(systemEvents[1]?.text, /Verify current session resumed after callback/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHookBase === undefined) delete process.env.OPENCLAW_HOOK_BASE_URL;
    else process.env.OPENCLAW_HOOK_BASE_URL = oldHookBase;
    if (oldHookToken === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
    else process.env.OPENCLAW_HOOK_TOKEN = oldHookToken;
    if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prevStateDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
