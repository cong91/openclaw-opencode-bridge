import type {
	BridgeLifecycleState,
	OpenCodeContinuationCallbackMetadata,
	OpenCodeRunContinuationStep,
} from "./types";
import { asString } from "./runtime";

export type HookContinuationIntent = {
	kind: "launch_run" | "notify" | "done" | "blocked";
	taskId?: string;
	objective?: string;
	prompt?: string;
	notify?: string;
	reason?: string;
	state?: BridgeLifecycleState | null;
};

export function mapCallbackEventToContinuationIntent(input: {
	metadata: OpenCodeContinuationCallbackMetadata | null;
	next?: OpenCodeRunContinuationStep;
}): HookContinuationIntent {
	const eventType = asString(input.metadata?.eventType) || "unknown-event";
	const next = input.next;

	if (eventType === "task.failed" || eventType === "session.error") {
		return {
			kind: "launch_run",
			taskId: asString(next?.taskId) || asString(input.metadata?.taskId),
			objective:
				asString(next?.objective) ||
				"Analyze the failure and continue the work with a corrective step.",
			prompt:
				asString(next?.prompt) ||
				"The previous step failed. Inspect the failure, identify the likely root cause, then continue the task with the smallest corrective next step.",
			reason: eventType,
			state: "failed",
		};
	}

	if (eventType === "task.stalled") {
		return {
			kind: "launch_run",
			taskId: asString(next?.taskId) || asString(input.metadata?.taskId),
			objective:
				asString(next?.objective) ||
				"Recover from the stalled state and continue the work.",
			prompt:
				asString(next?.prompt) ||
				"The previous step stalled. Diagnose what is blocking progress, then continue with the smallest useful next step.",
			reason: eventType,
			state: "stalled",
		};
	}

	if (eventType === "task.completed" || eventType === "session.idle") {
		if (next?.action === "launch_run") {
			return {
				kind: "launch_run",
				taskId: asString(next.taskId) || asString(input.metadata?.taskId),
				objective:
					asString(next.objective) ||
					"Verify the previous result and continue with the next planned step.",
				prompt:
					asString(next.prompt) ||
					"Verify the previous result. If verification fails, explain why and continue with the corrective next step. If verification passes and more work remains, continue with the next task. If everything is done, conclude clearly.",
				reason: eventType,
				state: "completed",
			};
		}
		if (next?.action === "notify") {
			return {
				kind: "notify",
				notify:
					asString(next.objective) ||
					asString(next.prompt) ||
					"OpenCode step completed. Prepare a concise operator-facing update.",
				reason: eventType,
				state: "completed",
			};
		}
		return {
			kind: "done",
			notify: "The callback indicates the work completed and there is no further next step configured.",
			reason: eventType,
			state: "completed",
		};
	}

	if (next?.action === "launch_run") {
		return {
			kind: "launch_run",
			taskId: asString(next.taskId) || asString(input.metadata?.taskId),
			objective:
				asString(next.objective) || "Continue the workflow.",
			prompt:
				asString(next.prompt) ||
				"Continue the workflow from the latest callback state.",
			reason: eventType,
			state: null,
		};
	}

	if (next?.action === "notify") {
		return {
			kind: "notify",
			notify:
				asString(next.objective) ||
				asString(next.prompt) ||
				"A callback was received. Prepare a concise status update.",
			reason: eventType,
			state: null,
		};
	}

	return {
		kind: "blocked",
		notify:
			"A callback was received but no actionable continuation could be derived. Manual triage is required.",
		reason: eventType,
		state: null,
	};
}
