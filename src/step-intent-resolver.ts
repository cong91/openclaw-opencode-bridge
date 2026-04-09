import type {
	BridgeConfigFile,
	WorkflowIntentLaneMap,
	WorkflowStepIntent,
} from "./types";
import { WORKFLOW_STEP_INTENTS } from "./types";

export const DEFAULT_INTENT_LANE_MAP: WorkflowIntentLaneMap = {
	clarify: "plan",
	design: "plan",
	plan: "plan",
	explore: "explore",
	implement: "build",
	review: "review",
	verify: "review",
	repair: "build",
	summarize: "plan",
};

export const DEFAULT_EXECUTION_LANES = new Set<string>([
	"build",
	"plan",
	"fullstack",
	"creator",
	"general",
	"review",
	"explore",
	"scout",
	"vision",
	"compaction",
	"painter",
]);

type IntentLaneResolutionStrategy =
	| "workflow_override"
	| "project_mapping"
	| "global_default";

export type IntentLaneResolution = {
	intent: WorkflowStepIntent;
	executionLane: string;
	strategy: IntentLaneResolutionStrategy;
};

function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeIntentLaneMap(input: unknown): WorkflowIntentLaneMap {
	if (!input || typeof input !== "object") return {};
	const raw = input as Record<string, unknown>;
	const normalized: WorkflowIntentLaneMap = {};
	for (const intent of WORKFLOW_STEP_INTENTS) {
		const lane = asTrimmedString(raw[intent]);
		if (lane) normalized[intent] = lane;
	}
	return normalized;
}

function resolveFromMap(
	intent: WorkflowStepIntent,
	mapping?: WorkflowIntentLaneMap,
): string | undefined {
	if (!mapping) return undefined;
	return asTrimmedString(mapping[intent]);
}

function assertAllowedLane(lane: string, validLanes?: Iterable<string>) {
	if (!validLanes) return;
	const laneSet = validLanes instanceof Set ? validLanes : new Set(validLanes);
	if (!laneSet.has(lane)) {
		throw new Error(
			`Workflow policy resolved execution lane '${lane}' but it is not in allowed execution lanes`,
		);
	}
}

export function resolveIntentToLane(input: {
	intent: WorkflowStepIntent;
	workflowOverride?: WorkflowIntentLaneMap;
	projectMapping?: WorkflowIntentLaneMap;
	globalMapping?: WorkflowIntentLaneMap;
	validLanes?: Iterable<string>;
}): IntentLaneResolution {
	const workflowOverride = normalizeIntentLaneMap(input.workflowOverride);
	const projectMapping = normalizeIntentLaneMap(input.projectMapping);
	const globalMapping = {
		...DEFAULT_INTENT_LANE_MAP,
		...normalizeIntentLaneMap(input.globalMapping),
	};

	const byWorkflowOverride = resolveFromMap(input.intent, workflowOverride);
	if (byWorkflowOverride) {
		assertAllowedLane(byWorkflowOverride, input.validLanes);
		return {
			intent: input.intent,
			executionLane: byWorkflowOverride,
			strategy: "workflow_override",
		};
	}

	const byProjectMapping = resolveFromMap(input.intent, projectMapping);
	if (byProjectMapping) {
		assertAllowedLane(byProjectMapping, input.validLanes);
		return {
			intent: input.intent,
			executionLane: byProjectMapping,
			strategy: "project_mapping",
		};
	}

	const byGlobalDefault = resolveFromMap(input.intent, globalMapping);
	if (byGlobalDefault) {
		assertAllowedLane(byGlobalDefault, input.validLanes);
		return {
			intent: input.intent,
			executionLane: byGlobalDefault,
			strategy: "global_default",
		};
	}

	throw new Error(
		`Workflow policy could not resolve execution lane for step intent '${input.intent}'`,
	);
}

export function resolveIntentToLaneFromConfig(input: {
	intent: WorkflowStepIntent;
	workflowOverride?: WorkflowIntentLaneMap;
	workflowPolicy?: BridgeConfigFile["workflowPolicy"];
	projectId?: string;
	validLanes?: Iterable<string>;
}): IntentLaneResolution {
	const policy = input.workflowPolicy;
	const projectMapping = input.projectId
		? normalizeIntentLaneMap(policy?.projectIntentLaneMap?.[input.projectId])
		: {};
	return resolveIntentToLane({
		intent: input.intent,
		workflowOverride: input.workflowOverride,
		projectMapping,
		globalMapping: normalizeIntentLaneMap(policy?.defaultIntentLaneMap),
		validLanes: input.validLanes,
	});
}
