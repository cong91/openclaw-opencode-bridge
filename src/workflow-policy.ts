import type {
	WorkflowPolicyOutcome,
	WorkflowStepIntent,
	WorkflowTransitionAction,
} from "./types";

export const WORKFLOW_POLICY_VERSION = "2026-04-09-v1";
export const DEFAULT_WORKFLOW_TYPE = "small-fix";
export const DEFAULT_WORKFLOW_MAX_TRANSITIONS = 12;

type WorkflowProfileRules = Partial<
	Record<
		WorkflowStepIntent,
		Partial<Record<WorkflowPolicyOutcome, WorkflowStepIntent>>
	>
>;

const WORKFLOW_PROFILE_RULES: Record<string, WorkflowProfileRules> = {
	"feature-delivery": {
		design: { success: "plan", failure: "escalate", stalled: "escalate" },
		plan: { success: "implement", failure: "escalate", stalled: "escalate" },
		implement: { success: "review", failure: "repair", stalled: "repair" },
		review: { success: "verify", failure: "repair", stalled: "repair" },
		verify: { success: "notify", failure: "repair", stalled: "escalate" },
		repair: { success: "review", failure: "escalate", stalled: "escalate" },
	},
	"small-fix": {
		implement: { success: "review", failure: "repair", stalled: "repair" },
		review: { success: "notify", failure: "repair", stalled: "repair" },
		repair: { success: "review", failure: "escalate", stalled: "escalate" },
	},
	"forensic-fix": {
		explore: { success: "design", failure: "escalate", stalled: "explore" },
		design: { success: "implement", failure: "escalate", stalled: "escalate" },
		implement: { success: "verify", failure: "repair", stalled: "repair" },
		verify: { success: "notify", failure: "repair", stalled: "escalate" },
		repair: { success: "verify", failure: "escalate", stalled: "escalate" },
	},
	"provider-integration": {
		design: { success: "plan", failure: "escalate", stalled: "escalate" },
		plan: { success: "implement", failure: "escalate", stalled: "escalate" },
		implement: { success: "review", failure: "repair", stalled: "repair" },
		review: { success: "verify", failure: "repair", stalled: "repair" },
		verify: { success: "notify", failure: "repair", stalled: "escalate" },
		repair: { success: "review", failure: "escalate", stalled: "escalate" },
	},
	"review-only": {
		review: { success: "notify", failure: "escalate", stalled: "escalate" },
	},
	"research-then-build": {
		explore: { success: "plan", failure: "escalate", stalled: "explore" },
		plan: { success: "implement", failure: "escalate", stalled: "escalate" },
		implement: { success: "review", failure: "repair", stalled: "repair" },
		review: { success: "notify", failure: "repair", stalled: "repair" },
		repair: { success: "review", failure: "escalate", stalled: "escalate" },
	},
};

const TERMINAL_ACTION_BY_INTENT: Partial<
	Record<WorkflowStepIntent, WorkflowTransitionAction>
> = {
	notify: "notify",
	stop: "stop",
	escalate: "escalate",
};

export type WorkflowPolicyDecision = {
	action: WorkflowTransitionAction;
	reason: string;
	outcome: WorkflowPolicyOutcome;
	nextIntent?: WorkflowStepIntent;
};

function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function classifyWorkflowOutcomeFromEvent(
	eventType?: string,
): WorkflowPolicyOutcome {
	const type = asTrimmedString(eventType);
	if (!type) return "unknown";
	if (type === "task.completed" || type === "session.idle") return "success";
	if (type === "task.failed" || type === "session.error") return "failure";
	if (type === "task.stalled") return "stalled";
	return "unknown";
}

function resolveTerminalActionFromIntent(
	intent: WorkflowStepIntent,
): WorkflowTransitionAction | undefined {
	return TERMINAL_ACTION_BY_INTENT[intent];
}

function resolveRulesForWorkflowType(
	workflowType?: string,
): WorkflowProfileRules {
	const normalized = asTrimmedString(workflowType) || DEFAULT_WORKFLOW_TYPE;
	const rules = WORKFLOW_PROFILE_RULES[normalized];
	if (!rules) {
		throw new Error(
			`Workflow policy does not define workflowType='${normalized}'`,
		);
	}
	return rules;
}

export function resolveWorkflowPolicyTransition(input: {
	workflowType?: string;
	currentIntent?: WorkflowStepIntent;
	eventType?: string;
	transitionCount?: number;
	maxTransitions?: number;
}): WorkflowPolicyDecision {
	const outcome = classifyWorkflowOutcomeFromEvent(input.eventType);
	const currentIntent = input.currentIntent;
	if (!currentIntent) {
		throw new Error("Workflow policy requires current step intent");
	}

	const transitionCount = Number(input.transitionCount || 0);
	const maxTransitions = Math.max(
		1,
		Number(input.maxTransitions || DEFAULT_WORKFLOW_MAX_TRANSITIONS),
	);
	if (transitionCount >= maxTransitions) {
		return {
			action: "escalate",
			reason: "max_transition_limit_reached",
			outcome,
			nextIntent: "escalate",
		};
	}

	const terminalAction = resolveTerminalActionFromIntent(currentIntent);
	if (terminalAction) {
		return {
			action: terminalAction,
			reason: "already_terminal_intent",
			outcome,
			nextIntent: currentIntent,
		};
	}

	if (outcome === "unknown") {
		return {
			action: "none",
			reason: "event_not_terminal_for_transition",
			outcome,
		};
	}

	const rules = resolveRulesForWorkflowType(input.workflowType);
	const intentRules = rules[currentIntent];
	if (!intentRules) {
		throw new Error(
			`Workflow policy has no transition rules for intent='${currentIntent}' in workflowType='${asTrimmedString(input.workflowType) || DEFAULT_WORKFLOW_TYPE}'`,
		);
	}

	const nextIntent = intentRules[outcome];
	if (!nextIntent) {
		throw new Error(
			`Workflow policy transition is invalid for workflowType='${asTrimmedString(input.workflowType) || DEFAULT_WORKFLOW_TYPE}', intent='${currentIntent}', outcome='${outcome}'`,
		);
	}

	const nextAction =
		resolveTerminalActionFromIntent(nextIntent) || "launch_run";
	return {
		action: nextAction,
		reason: `policy_transition:${currentIntent}:${outcome}->${nextIntent}`,
		outcome,
		nextIntent,
	};
}

export function buildPromptForWorkflowIntent(input: {
	intent: WorkflowStepIntent;
	workflowObjective?: string;
	previousIntent?: WorkflowStepIntent;
	previousOutcome?: WorkflowPolicyOutcome;
}): { objective: string; prompt: string } {
	const objectiveFallback =
		asTrimmedString(input.workflowObjective) ||
		"Continue the workflow with the requested step intent.";
	const prior =
		input.previousIntent && input.previousOutcome
			? `Previous step '${input.previousIntent}' ended with outcome '${input.previousOutcome}'.`
			: "";
	const map: Record<WorkflowStepIntent, { objective: string; prompt: string }> =
		{
			clarify: {
				objective: `Clarify unresolved requirements. ${objectiveFallback}`,
				prompt:
					"Clarify missing requirements and constraints before implementation. Produce concise assumptions and open questions.",
			},
			design: {
				objective: `Design the next implementation slice. ${objectiveFallback}`,
				prompt:
					"Produce a minimal, implementation-ready design for the current objective. Avoid speculative over-engineering.",
			},
			plan: {
				objective: `Create an execution plan. ${objectiveFallback}`,
				prompt:
					"Produce an actionable implementation plan with scoped tasks, constraints, and verification steps.",
			},
			explore: {
				objective: `Explore codebase context needed for execution. ${objectiveFallback}`,
				prompt:
					"Collect only the code evidence needed to proceed, then stop exploration and hand off execution details.",
			},
			implement: {
				objective: `Implement the approved scope. ${objectiveFallback}`,
				prompt:
					"Implement the scoped change directly, verify, and report exact files changed plus evidence.",
			},
			review: {
				objective: `Review the previous implementation step. ${objectiveFallback}`,
				prompt:
					"Review recent changes for correctness, regressions, and scope adherence. Provide actionable findings and fixes if needed.",
			},
			verify: {
				objective: `Verify the workflow outcome. ${objectiveFallback}`,
				prompt:
					"Run verification commands required by scope. Report pass/fail with exact evidence.",
			},
			repair: {
				objective: `Repair issues discovered in prior step. ${objectiveFallback}`,
				prompt:
					"Fix defects identified in the previous step with minimal scoped edits, then re-verify.",
			},
			summarize: {
				objective: `Summarize workflow progress. ${objectiveFallback}`,
				prompt:
					"Summarize what changed, what was verified, and remaining risks.",
			},
			notify: {
				objective: `Notify operator with final workflow state. ${objectiveFallback}`,
				prompt:
					"Prepare a concise operator-facing summary of results, verification evidence, and next action.",
			},
			stop: {
				objective: "Stop the workflow safely.",
				prompt: "Stop and report why execution is intentionally halted.",
			},
			escalate: {
				objective: "Escalate workflow for manual intervention.",
				prompt:
					"Escalate with a concise blocker summary, evidence, and exact decision needed.",
			},
		};
	const base = map[input.intent];
	return {
		objective: [base.objective, prior].filter(Boolean).join(" "),
		prompt: [base.prompt, prior].filter(Boolean).join(" "),
	};
}
