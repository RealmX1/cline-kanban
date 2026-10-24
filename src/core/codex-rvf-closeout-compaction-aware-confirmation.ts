import { z } from "zod";

export const CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS = 15_000;
export const CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS = 300_000;
export const CODEX_RVF_CLOSEOUT_CONFIRMATION_SWEEP_MARGIN_MS = 5_000;

export const codexRvfCloseoutConfirmationBindingSchema = z.object({
	workspaceId: z.string().min(1),
	taskId: z.string().min(1),
	conversationSessionId: z.string().min(1),
	decisionToken: z.string().min(1),
	runId: z.string().min(1),
	handoffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	idempotencyKey: z.string().min(1),
	promptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	nativeSessionId: z.string().min(1),
	runtimeSessionIncarnationId: z.string().min(1),
	controlHostSocketPath: z.string().min(1),
	terminalSessionSpawnedAtEpochMs: z.number().int().nonnegative(),
});
export type CodexRvfCloseoutConfirmationBinding = z.infer<typeof codexRvfCloseoutConfirmationBindingSchema>;

export const codexRvfCloseoutCompactionAwareConfirmationSchema = z
	.object({
		schemaVersion: z.literal(1),
		binding: codexRvfCloseoutConfirmationBindingSchema,
		revision: z.number().int().nonnegative(),
		submissionTransport: z.enum(["codex_native_request", "pty_submission"]),
		clientUserMessageId: z.string().nullable(),
		predecessorNativeTurnId: z.string().nullable(),
		nativeTurnId: z.string().nullable(),
		// 阶段 hook 的 turn 只用于计时；只有提交响应给出的 turn 才能单独证明接受归属。
		nativeTurnIdReturnedBySubmissionRequest: z.string().min(1).optional(),
		firstSubmissionAtEpochMs: z.number().int().nonnegative(),
		lastHumanInputAtSubmission: z.number().nullable(),
		absoluteConfirmationDeadlineAtEpochMs: z.number().int().nonnegative(),
		phase: z.enum(["waiting_for_native_prompt_acceptance", "waiting_for_automatic_context_compaction"]),
		phaseStartedAtEpochMs: z.number().int().nonnegative(),
		ordinaryConfirmationBudgetRemainingMs: z.number().min(0).max(CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS),
		accumulatedCompactionWaitMs: z.number().min(0).max(CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS),
		lastPhaseObservationCapturedAtEpochMs: z.number().int().nonnegative(),
		appliedCompactionHookDeliveryIds: z.array(z.string()).max(128),
		verifiedRuntimeAdoptionCount: z.number().int().positive().optional(),
		lastVerifiedRuntimeAdoptionAtEpochMs: z.number().int().nonnegative().optional(),
	})
	.refine(
		(state) =>
			state.absoluteConfirmationDeadlineAtEpochMs ===
				state.firstSubmissionAtEpochMs +
					CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS +
					CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS &&
			state.phaseStartedAtEpochMs >= state.firstSubmissionAtEpochMs &&
			state.phaseStartedAtEpochMs <= state.absoluteConfirmationDeadlineAtEpochMs,
		"确认快照的固定截止或阶段时间无效",
	)
	.refine(
		(state) =>
			state.nativeTurnIdReturnedBySubmissionRequest === undefined ||
			(state.submissionTransport === "codex_native_request" &&
				state.nativeTurnIdReturnedBySubmissionRequest === state.nativeTurnId &&
				state.nativeTurnIdReturnedBySubmissionRequest !== state.predecessorNativeTurnId),
		"提交响应回合必须属于同一原生请求，且不能是提交前驱",
	);
export type CodexRvfCloseoutCompactionAwareConfirmation = z.infer<
	typeof codexRvfCloseoutCompactionAwareConfirmationSchema
>;

export function createCodexRvfCloseoutCompactionAwareConfirmation(input: {
	binding: CodexRvfCloseoutConfirmationBinding;
	firstSubmissionAtEpochMs: number;
	submissionTransport: CodexRvfCloseoutCompactionAwareConfirmation["submissionTransport"];
	clientUserMessageId: string | null;
	predecessorNativeTurnId: string | null;
	lastHumanInputAtSubmission: number | null;
}): CodexRvfCloseoutCompactionAwareConfirmation {
	return codexRvfCloseoutCompactionAwareConfirmationSchema.parse({
		...input,
		schemaVersion: 1,
		revision: 0,
		nativeTurnId: null,
		absoluteConfirmationDeadlineAtEpochMs:
			input.firstSubmissionAtEpochMs +
			CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS +
			CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS,
		phase: "waiting_for_native_prompt_acceptance",
		phaseStartedAtEpochMs: input.firstSubmissionAtEpochMs,
		ordinaryConfirmationBudgetRemainingMs: CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS,
		accumulatedCompactionWaitMs: 0,
		lastPhaseObservationCapturedAtEpochMs: input.firstSubmissionAtEpochMs,
		appliedCompactionHookDeliveryIds: [],
	});
}

export function resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(
	state: CodexRvfCloseoutCompactionAwareConfirmation,
): number {
	const remainingPhaseBudget =
		state.phase === "waiting_for_automatic_context_compaction"
			? CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS - state.accumulatedCompactionWaitMs
			: state.ordinaryConfirmationBudgetRemainingMs;
	return Math.min(state.absoluteConfirmationDeadlineAtEpochMs, state.phaseStartedAtEpochMs + remainingPhaseBudget);
}

// 这里只判计时；调用方必须先证明运行代际、原生 session/turn 与当前投递仍绑定。
// 压缩不是正文接受证明；这个状态机没有“成功”转换。
export function applyCodexAutomaticCompactionPhaseObservation(
	state: CodexRvfCloseoutCompactionAwareConfirmation,
	observation: {
		phase: "started" | "completed";
		nativeTurnId: string;
		capturedAtEpochMs: number;
		receivedAtEpochMs: number;
		hookDeliveryId: string;
	},
): CodexRvfCloseoutCompactionAwareConfirmation {
	if (
		observation.nativeTurnId === state.predecessorNativeTurnId ||
		(state.nativeTurnId !== null && state.nativeTurnId !== observation.nativeTurnId) ||
		observation.capturedAtEpochMs < state.lastPhaseObservationCapturedAtEpochMs ||
		observation.capturedAtEpochMs > observation.receivedAtEpochMs ||
		observation.receivedAtEpochMs >= resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(state) ||
		state.appliedCompactionHookDeliveryIds.includes(observation.hookDeliveryId)
	)
		return state;
	const starts = observation.phase === "started";
	if (starts === (state.phase === "waiting_for_automatic_context_compaction")) return state;
	// 到达时计时，不追溯使用捕获时间发放已经过期的预算；停机期间自然计入当前阶段。
	const elapsedMs = observation.receivedAtEpochMs - state.phaseStartedAtEpochMs;
	return codexRvfCloseoutCompactionAwareConfirmationSchema.parse({
		...state,
		revision: state.revision + 1,
		nativeTurnId: observation.nativeTurnId,
		phase: starts ? "waiting_for_automatic_context_compaction" : "waiting_for_native_prompt_acceptance",
		phaseStartedAtEpochMs: observation.receivedAtEpochMs,
		ordinaryConfirmationBudgetRemainingMs: starts
			? state.ordinaryConfirmationBudgetRemainingMs - elapsedMs
			: state.ordinaryConfirmationBudgetRemainingMs,
		accumulatedCompactionWaitMs: starts
			? state.accumulatedCompactionWaitMs
			: state.accumulatedCompactionWaitMs + elapsedMs,
		lastPhaseObservationCapturedAtEpochMs: observation.capturedAtEpochMs,
		appliedCompactionHookDeliveryIds: [...state.appliedCompactionHookDeliveryIds, observation.hookDeliveryId].slice(
			-128,
		),
	});
}
