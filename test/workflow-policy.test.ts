import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPromptForWorkflowIntent,
	classifyWorkflowOutcomeFromEvent,
	resolveWorkflowPolicyTransition,
} from "../src/workflow-policy";

test("classifyWorkflowOutcomeFromEvent maps callback terminal events", () => {
	assert.equal(classifyWorkflowOutcomeFromEvent("task.completed"), "success");
	assert.equal(classifyWorkflowOutcomeFromEvent("session.idle"), "success");
	assert.equal(classifyWorkflowOutcomeFromEvent("task.failed"), "failure");
	assert.equal(classifyWorkflowOutcomeFromEvent("session.error"), "failure");
	assert.equal(classifyWorkflowOutcomeFromEvent("task.stalled"), "stalled");
	assert.equal(classifyWorkflowOutcomeFromEvent("task.progress"), "unknown");
});

test("resolveWorkflowPolicyTransition maps small-fix implement success to review launch", () => {
	const decision = resolveWorkflowPolicyTransition({
		workflowType: "small-fix",
		currentIntent: "implement",
		eventType: "task.completed",
		transitionCount: 0,
		maxTransitions: 6,
	});

	assert.equal(decision.action, "launch_run");
	assert.equal(decision.nextIntent, "review");
	assert.equal(decision.outcome, "success");
	assert.match(decision.reason, /implement:success->review/);
});

test("resolveWorkflowPolicyTransition maps small-fix review success to notify", () => {
	const decision = resolveWorkflowPolicyTransition({
		workflowType: "small-fix",
		currentIntent: "review",
		eventType: "session.idle",
		transitionCount: 1,
		maxTransitions: 6,
	});

	assert.equal(decision.action, "notify");
	assert.equal(decision.nextIntent, "notify");
	assert.equal(decision.outcome, "success");
});

test("resolveWorkflowPolicyTransition fails fast on unknown workflow type", () => {
	assert.throws(
		() =>
			resolveWorkflowPolicyTransition({
				workflowType: "unknown-flow",
				currentIntent: "implement",
				eventType: "task.completed",
			}),
		/does not define workflowType/i,
	);
});

test("resolveWorkflowPolicyTransition fails fast on invalid transition edge", () => {
	assert.throws(
		() =>
			resolveWorkflowPolicyTransition({
				workflowType: "review-only",
				currentIntent: "implement",
				eventType: "task.completed",
			}),
		/no transition rules for intent/i,
	);
});

test("resolveWorkflowPolicyTransition escalates when max transition limit is reached", () => {
	const decision = resolveWorkflowPolicyTransition({
		workflowType: "feature-delivery",
		currentIntent: "repair",
		eventType: "task.completed",
		transitionCount: 10,
		maxTransitions: 10,
	});

	assert.equal(decision.action, "escalate");
	assert.equal(decision.nextIntent, "escalate");
	assert.equal(decision.reason, "max_transition_limit_reached");
});

test("buildPromptForWorkflowIntent returns objective and prompt packet", () => {
	const packet = buildPromptForWorkflowIntent({
		intent: "verify",
		workflowObjective: "Ship workflow policy layer",
		previousIntent: "review",
		previousOutcome: "success",
	});

	assert.match(packet.objective, /verify/i);
	assert.match(packet.objective, /review/);
	assert.match(packet.prompt, /verification/i);
});
