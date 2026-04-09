import type {
	OpenCodeRunContinuation,
	WorkflowIntentLaneMap,
	WorkflowPolicyOutcome,
	WorkflowPolicyState,
	WorkflowStatusSnapshot,
	WorkflowStepIntent,
	WorkflowStepState,
	WorkflowTransitionAction,
} from "./types";
import { WORKFLOW_STEP_INTENTS } from "./types";
import {
	DEFAULT_WORKFLOW_TYPE,
	WORKFLOW_POLICY_VERSION,
} from "./workflow-policy";

function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isWorkflowStepIntent(
	value: unknown,
): value is WorkflowStepIntent {
	return (
		typeof value === "string" &&
		WORKFLOW_STEP_INTENTS.includes(value as WorkflowStepIntent)
	);
}

export function asWorkflowStepIntent(
	value: unknown,
	fallback?: WorkflowStepIntent,
): WorkflowStepIntent | undefined {
	if (isWorkflowStepIntent(value)) return value;
	return fallback;
}

export function normalizeWorkflowIntentLaneOverrides(
	input: unknown,
): WorkflowIntentLaneMap {
	if (!input || typeof input !== "object") return {};
	const raw = input as Record<string, unknown>;
	const normalized: WorkflowIntentLaneMap = {};
	for (const intent of WORKFLOW_STEP_INTENTS) {
		const lane = asTrimmedString(raw[intent]);
		if (lane) normalized[intent] = lane;
	}
	return normalized;
}

export function buildInitialWorkflowState(input: {
	workflowId: string;
	workflowType?: string;
	policyVersion?: string;
	objective?: string;
	artifacts?: {
		spec?: string;
		plan?: string;
	};
	stepId: string;
	stepIntent: WorkflowStepIntent;
	executionLane?: string;
	intentLaneOverrides?: WorkflowIntentLaneMap;
	maxTransitions?: number;
}): WorkflowPolicyState {
	const currentStep: WorkflowStepState = {
		stepId: input.stepId,
		intent: input.stepIntent,
		...(asTrimmedString(input.executionLane)
			? { executionLane: asTrimmedString(input.executionLane) }
			: {}),
		status: "running",
		taskId: input.stepId,
	};
	return {
		workflowId: input.workflowId,
		workflowType: asTrimmedString(input.workflowType) || DEFAULT_WORKFLOW_TYPE,
		policyVersion:
			asTrimmedString(input.policyVersion) || WORKFLOW_POLICY_VERSION,
		...(asTrimmedString(input.objective)
			? { objective: asTrimmedString(input.objective) }
			: {}),
		...(input.artifacts ? { artifacts: input.artifacts } : {}),
		currentStep,
		previousOutcome: undefined,
		transitionCount: 0,
		...(Number.isFinite(Number(input.maxTransitions))
			? { maxTransitions: Number(input.maxTransitions) }
			: {}),
		intentLaneOverrides: normalizeWorkflowIntentLaneOverrides(
			input.intentLaneOverrides,
		),
	};
}

export function buildWorkflowStatusSnapshot(
	continuation?: OpenCodeRunContinuation,
): WorkflowStatusSnapshot | undefined {
	if (!continuation) return undefined;
	const workflow = continuation.workflow;
	if (!workflow && !continuation.workflowId) return undefined;

	const currentStep = workflow?.currentStep;
	const nextStep = workflow?.nextTransition?.nextStep;

	return {
		workflowId: workflow?.workflowId || continuation.workflowId,
		workflowType: workflow?.workflowType || continuation.workflowType,
		policyVersion: workflow?.policyVersion || continuation.policyVersion,
		currentStepId: currentStep?.stepId || continuation.stepId,
		currentStepIntent: currentStep?.intent || continuation.currentIntent,
		currentExecutionLane:
			currentStep?.executionLane || continuation.currentExecutionLane,
		previousOutcome: workflow?.previousOutcome,
		nextAction: workflow?.nextTransition?.action || continuation.nextAction,
		nextStepId: nextStep?.stepId,
		nextStepIntent: nextStep?.intent,
		nextExecutionLane: nextStep?.executionLane,
		transitionReason: workflow?.nextTransition?.reason,
		continuationLaunched: workflow?.nextTransition?.launched,
		transitionCount: workflow?.transitionCount,
	};
}

export function applyWorkflowTransitionToContinuation(input: {
	continuation: OpenCodeRunContinuation;
	outcome: WorkflowPolicyOutcome;
	action: WorkflowTransitionAction;
	reason: string;
	nextStep?: WorkflowStepState;
	dedupeKey?: string;
	launched?: boolean;
}): OpenCodeRunContinuation {
	const current = input.continuation;
	const workflow = current.workflow;
	if (!workflow) {
		return {
			...current,
			nextAction: input.action,
		};
	}

	const transitionCount = Math.max(0, Number(workflow.transitionCount || 0));
	return {
		...current,
		nextAction: input.action,
		workflowType: workflow.workflowType,
		policyVersion: workflow.policyVersion,
		currentIntent: workflow.currentStep?.intent,
		currentExecutionLane: workflow.currentStep?.executionLane,
		workflow: {
			...workflow,
			previousOutcome: input.outcome,
			transitionCount: transitionCount + (input.action === "none" ? 0 : 1),
			nextTransition: {
				action: input.action,
				reason: input.reason,
				previousOutcome: input.outcome,
				...(input.nextStep ? { nextStep: input.nextStep } : {}),
				...(asTrimmedString(input.dedupeKey)
					? { dedupeKey: asTrimmedString(input.dedupeKey) }
					: {}),
				...(input.launched !== undefined ? { launched: input.launched } : {}),
				...(input.launched ? { launchedAt: new Date().toISOString() } : {}),
			},
		},
	};
}
