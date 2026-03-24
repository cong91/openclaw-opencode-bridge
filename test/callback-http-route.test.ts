import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerOpenCodeBridgeTools } from "../src/registrar";

type RegisteredRoute = {
  path: string;
  auth: "gateway" | "plugin";
  handler: (req: any, res: any) => Promise<boolean>;
};

function createMockReq(
  body: string,
  token: string,
  authMode: "bearer" | "legacy" = "bearer",
) {
  const req = new EventEmitter() as any;
  req.method = "POST";
  req.url = "/plugin/opencode-bridge/callback";
  req.headers = authMode === "legacy"
    ? { "x-openclaw-token": token }
    : { authorization: `Bearer ${token}` };
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
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
  } as any;
}

test("callback http route enqueues callback message into target session and wakes heartbeat", async () => {
  const routes: RegisteredRoute[] = [];
  const systemEvents: Array<{ text: string; opts: any }> = [];
  const heartbeats: any[] = [];

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
            heartbeats.push(opts);
          },
        },
      },
    },
    {
      hookToken: "test-token",
    },
  );

  const route = routes.find((x) => x.path === "/plugin/opencode-bridge/callback");
  assert.ok(route, "callback route should be registered");
  assert.equal(route?.auth, "plugin");

  const payload = {
    name: "OpenCode",
    agentId: "creator",
    sessionKey: "agent:creator:telegram:direct:5165741309",
    sessionId: "sess-origin-1",
    wakeMode: "now",
    deliver: false,
    message: JSON.stringify({
      kind: "opencode.callback",
      eventType: "session.idle",
      runId: "run-1",
      taskId: "task-1",
      callbackTargetSessionKey: "agent:creator:telegram:direct:5165741309",
      callbackTargetSessionId: "sess-origin-1",
    }),
  };

  const req = createMockReq(JSON.stringify(payload), "test-token");
  const res = createMockRes();
  const handled = await route!.handler(req, res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(systemEvents.length, 1);
  assert.equal(systemEvents[0]?.text, payload.message);
  assert.equal(systemEvents[0]?.opts?.sessionKey, payload.sessionKey);
  assert.equal(systemEvents[0]?.opts?.sessionId, payload.sessionId);
  assert.equal(systemEvents[0]?.opts?.contextKey, "opencode:run-1:session.idle");
  assert.equal(heartbeats.length, 1);
});
