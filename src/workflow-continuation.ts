import {
	asString,
	buildEnvelope,
	findRegistryEntry,
	getRuntimeConfig,
	resolveServerUrl,
	startExecutionRun,
} from "./runtime";
import {
	DEFAULT_EXECUTION_LANES,
	normalizeIntentLaneMap,
	resolveIntentToLaneFromConfig,
} from "./step-intent-resolver";
import type { BridgeRunStatus, OpenCodeRunContinuation } from "./types";
import {
	buildPromptForWorkflowIntent,
	DEFAULT_WORKFLOW_MAX_TRANSITIONS,
	resolveWorkflowPolicyTransition,
	type WorkflowPolicyDecision,
} from "./workflow-policy";
import { asWorkflowStepIntent } from "./workflow-state";

function resolveLegacyContinuationStep(input: {
	runStatus: BridgeRunStatus | null;
	eventType?: string;
}): OpenCodeRunContinuation["nextOnSuccess"] | undefined {
	if (!input.runStatus?.continuation) return undefined;
	return input.eventType === "task.failed" ||
		input.eventType === "task.stalled" ||
		input.eventType === "session.error"
		? input.runStatus.continuation.nextOnFailure
		: input.runStatus.continuation.nextOnSuccess;
}

export type WorkflowContinuationDecision = {
	step?: OpenCodeRunContinuation["nextOnSuccess"];
	source: "none" | "legacy" | "workflow_policy";
	policy?: WorkflowPolicyDecision;
};

export function buildContinuationTransitionDedupeKey(input: {
	runId: string;
	eventType?: string;
	step?: OpenCodeRunContinuation["nextOnSuccess"];
}) {
	const eventType = asString(input.eventType) || "unknown-event";
	const stablePolicyReason = asString(input.step?.reason);
	if (stablePolicyReason?.startsWith("policy_transition:")) {
		return `${input.runId}:${eventType}:${stablePolicyReason}:${input.step?.action || "none"}`;
	}
	const stepId =
		asString(input.step?.stepId) ||
		asString(input.step?.taskId) ||
		asString(input.step?.stepIntent) ||
		asString(input.step?.executionLane) ||
		"unknown-step";
	return `${input.runId}:${eventType}:${stepId}:${input.step?.action || "none"}`;
}

export function resolveContinuationStep(input: {
	cfg: any;
	runStatus: BridgeRunStatus | null;
	eventType?: string;
}): WorkflowContinuationDecision {
	const continuation = input.runStatus?.continuation;
	if (!continuation) return { source: "none" };

	const workflow = continuation.workflow;
	const currentIntent =
		workflow?.currentStep?.intent || continuation.currentIntent;
	if (!workflow || !currentIntent) {
		return {
			step: resolveLegacyContinuationStep(input),
			source: "legacy",
		};
	}

	const runtimeCfg = getRuntimeConfig(input.cfg);
	const policy = resolveWorkflowPolicyTransition({
		workflowType: workflow.workflowType || continuation.workflowType,
		currentIntent,
		eventType: input.eventType,
		transitionCount: workflow.transitionCount,
		maxTransitions:
			workflow.maxTransitions ||
			runtimeCfg.workflowPolicy?.maxTransitions ||
			DEFAULT_WORKFLOW_MAX_TRANSITIONS,
	});

	if (policy.action !== "launch_run") {
		return {
			step: {
				action: policy.action,
				reason: policy.reason,
				stepIntent: policy.nextIntent,
				stepId: workflow.currentStep?.stepId,
				taskId: workflow.currentStep?.taskId,
			},
			source: "workflow_policy",
			policy,
		};
	}

	if (!policy.nextIntent) {
		throw new Error(
			`Workflow policy returned launch_run without next intent for runId=${input.runStatus?.runId || "unknown"}`,
		);
	}

	const laneResolution = resolveIntentToLaneFromConfig({
		intent: policy.nextIntent,
		workflowOverride: normalizeIntentLaneMap(
			workflow.intentLaneOverrides || continuation.intentLaneOverrides,
		),
		workflowPolicy: runtimeCfg.workflowPolicy,
		projectId: input.runStatus?.envelope.project_id,
		validLanes: DEFAULT_EXECUTION_LANES,
	});
	const stepOrdinal = Math.max(1, Number(workflow.transitionCount || 0) + 1);
	const nextStepId = `${workflow.workflowId || input.runStatus?.runId || "wf"}:${policy.nextIntent}:${stepOrdinal}`;
	const promptPacket = buildPromptForWorkflowIntent({
		intent: policy.nextIntent,
		workflowObjective: workflow.objective,
		previousIntent: currentIntent,
		previousOutcome: policy.outcome,
	});

	return {
		step: {
			action: "launch_run",
			stepId: nextStepId,
			taskId: nextStepId,
			stepIntent: policy.nextIntent,
			executionLane: laneResolution.executionLane,
			objective: promptPacket.objective,
			prompt: promptPacket.prompt,
			reason: policy.reason,
		},
		source: "workflow_policy",
		policy,
	};
}

export async function launchWorkflowContinuationStep(input: {
	cfg: any;
	parentRunStatus: BridgeRunStatus;
	step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>;
	policy?: WorkflowPolicyDecision;
	transitionDedupeKey: string;
}) {
	const taskId =
		asString(input.step.taskId) ||
		asString(input.step.stepId) ||
		`${input.parentRunStatus.taskId}-continue`;
	const runId = `${taskId}-${Date.now()}`;
	const requestedAgentId =
		input.parentRunStatus.envelope.requested_agent_id || "creator";
	const resolvedAgentId =
		asString(input.step.executionLane) ||
		input.parentRunStatus.envelope.resolved_agent_id ||
		requestedAgentId;
	if (!DEFAULT_EXECUTION_LANES.has(resolvedAgentId)) {
		throw new Error(
			`Workflow continuation resolved unsupported execution lane '${resolvedAgentId}'`,
		);
	}

	const repoRoot = input.parentRunStatus.envelope.repo_root;
	const projectId = input.parentRunStatus.envelope.project_id;
	const serverUrl =
		findRegistryEntry(input.cfg, projectId, repoRoot)?.serverUrl ||
		input.parentRunStatus.envelope.opencode_server_url ||
		resolveServerUrl(input.cfg);

	const envelope = buildEnvelope({
		taskId,
		runId,
		requestedAgentId,
		resolvedAgentId,
		executionAgentExplicit: true,
		originSessionKey: input.parentRunStatus.envelope.origin_session_key,
		originSessionId: input.parentRunStatus.envelope.origin_session_id,
		projectId,
		repoRoot,
		agentWorkspaceDir:
			input.parentRunStatus.envelope.agent_workspace_dir || repoRoot,
		serverUrl,
		deliver: true,
		channel: input.parentRunStatus.envelope.channel,
		to: input.parentRunStatus.envelope.to,
		priority: input.parentRunStatus.envelope.priority,
	});

	const parentContinuation = input.parentRunStatus.continuation;
	const parentWorkflow = parentContinuation?.workflow;
	const stepIntent = asWorkflowStepIntent(input.step.stepIntent);
	const childWorkflow =
		parentWorkflow && stepIntent
			? {
					...parentWorkflow,
					currentStep: {
						stepId: asString(input.step.stepId) || taskId,
						intent: stepIntent,
						executionLane: resolvedAgentId,
						status: "running" as const,
						taskId,
						objective: asString(input.step.objective),
						prompt: asString(input.step.prompt),
					},
					transitionCount: Math.max(
						1,
						Number(parentWorkflow.transitionCount || 0) + 1,
					),
					nextTransition: {
						action: "launch_run" as const,
						reason: input.policy?.reason || input.step.reason,
						previousOutcome: input.policy?.outcome,
						nextStep: {
							stepId: asString(input.step.stepId) || taskId,
							intent: stepIntent,
							executionLane: resolvedAgentId,
							status: "running" as const,
							taskId,
						},
						dedupeKey: input.transitionDedupeKey,
						launched: true,
						launchedAt: new Date().toISOString(),
					},
				}
			: undefined;

	const continuation: OpenCodeRunContinuation | undefined = parentContinuation
		? {
				...parentContinuation,
				workflowId:
					childWorkflow?.workflowId ||
					parentContinuation.workflowId ||
					parentWorkflow?.workflowId,
				workflowType:
					childWorkflow?.workflowType ||
					parentContinuation.workflowType ||
					parentWorkflow?.workflowType,
				policyVersion:
					childWorkflow?.policyVersion ||
					parentContinuation.policyVersion ||
					parentWorkflow?.policyVersion,
				stepId: asString(input.step.stepId) || taskId,
				currentIntent: stepIntent || parentContinuation.currentIntent,
				currentExecutionLane: resolvedAgentId,
				nextAction: undefined,
				workflow: childWorkflow,
				nextOnSuccess: parentContinuation.nextOnSuccess,
				nextOnFailure: parentContinuation.nextOnFailure,
				callbackEventKind: "opencode.callback",
			}
		: undefined;

	const execution = await startExecutionRun({
		cfg: input.cfg,
		envelope,
		prompt:
			asString(input.step.prompt) ||
			asString(input.step.objective) ||
			"Continue workflow step.",
		continuation,
	});

	return {
		runId,
		taskId,
		execution,
		envelope,
	};
}
