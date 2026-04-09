import { asString, patchRunStatus, readRunStatus } from "./runtime";
import type {
	BridgeRunStatus,
	OpenCodeContinuationCallbackMetadata,
	OpenCodeRunContinuation,
	WorkflowStepState,
	WorkflowTransitionAction,
} from "./types";
import {
	buildContinuationTransitionDedupeKey,
	launchWorkflowContinuationStep,
	type WorkflowContinuationDecision,
} from "./workflow-continuation";
import { applyWorkflowTransitionToContinuation } from "./workflow-state";

type CallbackTarget = {
	sessionKey: string;
	sessionId?: string;
};

type LegacyDispatchResult =
	| {
			ok: true;
			status: number;
			body?: string;
			url?: string;
	  }
	| {
			ok: false;
			status?: number;
			body?: string;
			error?: string;
			url?: string;
	  };

function asErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return fallback;
}

export function patchWorkflowContinuationStateByOutcome(input: {
	runId?: string;
	decision?: WorkflowContinuationDecision;
	step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>;
	action: WorkflowTransitionAction;
	reasonFallback: string;
	nextStep?: WorkflowStepState;
	dedupeKey?: string;
	launched?: boolean;
}) {
	if (input.decision?.source !== "workflow_policy" || !input.runId) return;

	patchRunStatus(input.runId, (current) => ({
		...current,
		continuation: current.continuation
			? applyWorkflowTransitionToContinuation({
					continuation: current.continuation,
					outcome: input.decision?.policy?.outcome || "unknown",
					action: input.action,
					reason:
						input.decision?.policy?.reason ||
						input.step.reason ||
						input.reasonFallback,
					nextStep: input.nextStep,
					dedupeKey: input.dedupeKey,
					launched: input.launched,
				})
			: current.continuation,
	}));
}

export async function handleWorkflowCallbackTransition(input: {
	cfg: any;
	runStatus: BridgeRunStatus;
	metadata: OpenCodeContinuationCallbackMetadata | null;
	decision?: WorkflowContinuationDecision;
	step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>;
	dedupeKey?: string;
	callbackTarget: CallbackTarget;
	appendCallbackDebugAudit: (record: Record<string, unknown>) => void;
	enqueueSystemEvent: (
		message: string,
		options: { sessionKey: string; sessionId?: string; contextKey?: string },
	) => void;
	buildContinuationCommandPayload: (
		step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>,
	) => Record<string, unknown>;
	dispatchContinuationToCustomHook: (
		step: NonNullable<OpenCodeRunContinuation["nextOnSuccess"]>,
	) => Promise<LegacyDispatchResult>;
}): Promise<{ ok: true } | { ok: false; statusCode: number; error: string }> {
	const step = input.step;

	if (step.action === "launch_run") {
		if (input.decision?.source === "workflow_policy") {
			const transitionDedupeKey = buildContinuationTransitionDedupeKey({
				runId: input.runStatus.runId,
				eventType: input.metadata?.eventType,
				step,
			});
			const latestRunStatus = input.metadata?.runId
				? readRunStatus(input.metadata.runId) || input.runStatus
				: input.runStatus;
			const alreadyLaunched =
				latestRunStatus.continuation?.workflow?.nextTransition?.dedupeKey ===
					transitionDedupeKey &&
				latestRunStatus.continuation?.workflow?.nextTransition?.launched ===
					true;

			if (alreadyLaunched) {
				input.appendCallbackDebugAudit({
					phase: "continuation_launch_deduped",
					runId: latestRunStatus.runId,
					eventType: input.metadata?.eventType || null,
					transitionDedupeKey,
					selectedStep: step,
				});
				return { ok: true };
			}

			const nextStepState: WorkflowStepState | undefined = step.stepIntent
				? {
						stepId:
							asString(step.stepId) ||
							asString(step.taskId) ||
							`${latestRunStatus.taskId}:next`,
						intent: step.stepIntent,
						executionLane: asString(step.executionLane),
						status: "pending",
						taskId: asString(step.taskId),
						objective: asString(step.objective),
						prompt: asString(step.prompt),
					}
				: undefined;

			patchWorkflowContinuationStateByOutcome({
				runId: input.metadata?.runId,
				decision: input.decision,
				step,
				action: "launch_run",
				reasonFallback: "continuation_launch_requested",
				nextStep: nextStepState,
				dedupeKey: transitionDedupeKey,
				launched: false,
			});

			try {
				const childRun = await launchWorkflowContinuationStep({
					cfg: input.cfg,
					parentRunStatus: latestRunStatus,
					step,
					policy: input.decision?.policy,
					transitionDedupeKey,
				});

				patchWorkflowContinuationStateByOutcome({
					runId: input.metadata?.runId,
					decision: input.decision,
					step,
					action: "launch_run",
					reasonFallback: "continuation_launch_dispatched",
					nextStep: nextStepState,
					dedupeKey: transitionDedupeKey,
					launched: true,
				});

				input.appendCallbackDebugAudit({
					phase: "continuation_run_started",
					runId: latestRunStatus.runId,
					eventType: input.metadata?.eventType || null,
					transitionDedupeKey,
					selectedStep: step,
					childRunId: childRun.runId,
					childTaskId: childRun.taskId,
					childExecutionLane: childRun.envelope.resolved_agent_id,
				});
				return { ok: true };
			} catch (error) {
				const message = asErrorMessage(
					error,
					"continuation_launch_failed_fast",
				);
				input.appendCallbackDebugAudit({
					phase: "continuation_run_failed",
					runId: latestRunStatus.runId,
					eventType: input.metadata?.eventType || null,
					transitionDedupeKey,
					error: message,
				});
				return {
					ok: false,
					statusCode: 500,
					error: message,
				};
			}
		}

		const commandPayload = input.buildContinuationCommandPayload(step);
		const hookDispatch = await input.dispatchContinuationToCustomHook(step);
		input.appendCallbackDebugAudit({
			phase: hookDispatch.ok
				? "continuation_hook_dispatched"
				: "continuation_hook_failed",
			sessionKey: input.callbackTarget.sessionKey,
			dedupeKey: input.dedupeKey,
			runId: input.metadata?.runId || null,
			commandPayload,
			hookDispatch,
		});
		return { ok: true };
	}

	if (step.action === "notify") {
		patchWorkflowContinuationStateByOutcome({
			runId: input.metadata?.runId,
			decision: input.decision,
			step,
			action: "notify",
			reasonFallback: "workflow_notify",
			launched: false,
		});

		const notifyMessage =
			step.objective || step.prompt || "Next step requires operator notice.";
		input.enqueueSystemEvent(notifyMessage, {
			...input.callbackTarget,
			...(input.dedupeKey
				? { contextKey: `${input.dedupeKey}:continuation-notify` }
				: {}),
		});
		input.appendCallbackDebugAudit({
			phase: "continuation_notify_enqueued",
			sessionKey: input.callbackTarget.sessionKey,
			dedupeKey: input.dedupeKey,
			runId: input.metadata?.runId || null,
			notifyMessage,
			reason: "registrar_authority",
		});
		return { ok: true };
	}

	if (step.action === "stop" || step.action === "escalate") {
		patchWorkflowContinuationStateByOutcome({
			runId: input.metadata?.runId,
			decision: input.decision,
			step,
			action: step.action,
			reasonFallback: `workflow_${step.action}`,
			launched: false,
		});

		const controlMessage =
			step.objective ||
			step.prompt ||
			`Workflow requested action=${step.action}.`;
		input.enqueueSystemEvent(controlMessage, {
			...input.callbackTarget,
			...(input.dedupeKey
				? { contextKey: `${input.dedupeKey}:continuation-${step.action}` }
				: {}),
		});
		input.appendCallbackDebugAudit({
			phase: `continuation_${step.action}_enqueued`,
			sessionKey: input.callbackTarget.sessionKey,
			dedupeKey: input.dedupeKey,
			runId: input.metadata?.runId || null,
			controlMessage,
		});
	}

	return { ok: true };
}
