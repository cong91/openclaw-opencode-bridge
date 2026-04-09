import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_INTENT_LANE_MAP,
	resolveIntentToLane,
	resolveIntentToLaneFromConfig,
} from "../src/step-intent-resolver";

test("resolveIntentToLane applies workflow override before project/global mappings", () => {
	const resolved = resolveIntentToLane({
		intent: "implement",
		workflowOverride: { implement: "fullstack" },
		projectMapping: { implement: "build" },
		globalMapping: { implement: "general" },
		validLanes: ["build", "fullstack", "general"],
	});

	assert.equal(resolved.executionLane, "fullstack");
	assert.equal(resolved.strategy, "workflow_override");
});

test("resolveIntentToLane applies project mapping when no workflow override exists", () => {
	const resolved = resolveIntentToLane({
		intent: "review",
		projectMapping: { review: "review" },
		globalMapping: { review: "plan" },
		validLanes: ["review", "plan"],
	});

	assert.equal(resolved.executionLane, "review");
	assert.equal(resolved.strategy, "project_mapping");
});

test("resolveIntentToLane falls back to global default map", () => {
	const resolved = resolveIntentToLane({
		intent: "verify",
		validLanes: ["review"],
	});

	assert.equal(DEFAULT_INTENT_LANE_MAP.verify, "review");
	assert.equal(resolved.executionLane, "review");
	assert.equal(resolved.strategy, "global_default");
});

test("resolveIntentToLane fails fast when lane is unresolved", () => {
	assert.throws(
		() =>
			resolveIntentToLane({
				intent: "notify",
				workflowOverride: {},
				projectMapping: {},
				globalMapping: {},
				validLanes: ["build", "review"],
			}),
		/could not resolve execution lane/i,
	);
});

test("resolveIntentToLane fails fast when resolved lane is not allowed", () => {
	assert.throws(
		() =>
			resolveIntentToLane({
				intent: "implement",
				workflowOverride: { implement: "dangerous-lane" },
				validLanes: ["build", "review"],
			}),
		/not in allowed execution lanes/i,
	);
});

test("resolveIntentToLaneFromConfig reads project-specific mapping from workflowPolicy config", () => {
	const resolved = resolveIntentToLaneFromConfig({
		intent: "implement",
		workflowPolicy: {
			defaultIntentLaneMap: { implement: "build" },
			projectIntentLaneMap: {
				"proj-1": { implement: "fullstack" },
			},
		},
		projectId: "proj-1",
		validLanes: ["build", "fullstack"],
	});

	assert.equal(resolved.executionLane, "fullstack");
	assert.equal(resolved.strategy, "project_mapping");
});
