import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpenCodeEvent } from "../src/observability";

test("session permission metadata alone does not become permission.requested", () => {
  const raw = {
    type: "session.updated",
    properties: {
      info: {
        id: "ses_test_1",
        permission: [
          { permission: "question", pattern: "*", action: "deny" },
          { permission: "plan_enter", pattern: "*", action: "deny" },
          { permission: "plan_exit", pattern: "*", action: "deny" },
        ],
      },
    },
  };

  const event = normalizeOpenCodeEvent(raw);
  assert.equal(event.kind, null);
  assert.notEqual(event.lifecycleState, "awaiting_permission");
  assert.deepEqual(event.blockers, []);
});

test("explicit question.asked still becomes permission.requested", () => {
  const raw = {
    type: "question.asked",
    properties: {
      requestID: "req_123",
      questions: [
        {
          question: "Proceed?",
          options: ["yes", "no"],
        },
      ],
    },
  };

  const event = normalizeOpenCodeEvent(raw);
  assert.equal(event.kind, "permission.requested");
  assert.equal(event.lifecycleState, "awaiting_permission");
  assert.deepEqual(event.blockers, ["awaiting_permission"]);
});
