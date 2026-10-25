import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RuntimeHookIngestRequest, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveTaskMainSessionHandoverTargetAgentId } from "../core/task-main-session-handover-contract";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadPersistedWorkspaceStateById, mutateWorkspaceState } from "./workspace-state";

// 没有原生身份读取器的 harness 只认当前进程的两段关联证据；前置输入 hook 单独永远不证明接受。
export async function confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks(input: {
	workspacePath: string;
	summary: RuntimeTaskSessionSummary;
	hook: RuntimeHookIngestRequest;
}) {
	const { hook, summary } = input;
	const agentId = summary.agentId;
	if (
		!summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover ||
		(agentId !== "droid" && agentId !== "kiro") ||
		hook.metadata?.source !== agentId ||
		hook.hookEventFiredInsideSubagentContext ||
		!hook.hookRuntimeSessionIncarnationId ||
		hook.hookRuntimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		!hook.hookEventDeliveryIdempotencyKey ||
		hook.hookEventCapturedAtEpochMs === undefined ||
		!summary.workspacePath
	)
		return null;
	const observedAt = hook.hookEventCapturedAtEpochMs;
	if (!Number.isFinite(observedAt) || observedAt > Date.now() + 60_000) return null;
	const hookName = hook.metadata?.hookEventName?.toLowerCase() ?? "";
	const isSubmission = ["userpromptsubmit", "beforeagent"].includes(hookName);
	const isProcessing = [
		"pretooluse",
		"beforetool",
		"posttooluse",
		"aftertool",
		"stop",
		"afteragent",
		"taskcomplete",
	].includes(hookName);
	if (!isSubmission && !isProcessing) return null;
	const state = await loadPersistedWorkspaceStateById(hook.workspaceId);
	const card = state.board.columns
		.flatMap((column) => column.cards)
		.find((entry) => entry.mainTaskConversationSessionId === summary.taskId && entry.taskMainSessionHandover);
	const record = card?.taskMainSessionHandover;
	if (
		!card ||
		!record ||
		!["report_delivery_pending", "awaiting_user_message", "failed"].includes(record.status) ||
		record.automaticRecovery?.classification === "execution_prohibited"
	)
		return null;
	const binding = record.reportNativeIdentityCaptureBinding;
	if (
		!binding ||
		resolveTaskMainSessionHandoverTargetAgentId(record.destination) !== agentId ||
		binding.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		resolve(binding.workingDirectoryPath) !== resolve(summary.workspacePath) ||
		observedAt < binding.preparedAt
	)
		return null;
	const delivery = findTaskMessageInjectionRecord(
		await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath)),
		summary.taskId,
		`${record.handoverId}:report:${record.reportDeliveryAttempt}`,
	);
	const submittedText = hook.submittedPromptText;
	const promptSha256 = submittedText ? createHash("sha256").update(submittedText).digest("hex") : null;
	const outcome = await mutateWorkspaceState(
		input.workspacePath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"runtime_confirm_handover_input_after_correlated_processing_hooks",
			"handover_correlated_native_processing_evidence",
		),
		(latest) => {
			const currentCard = latest.board.columns
				.flatMap((column) => column.cards)
				.find((entry) => entry.id === card.id);
			const current = currentCard?.taskMainSessionHandover;
			if (
				!current ||
				current.handoverId !== record.handoverId ||
				current.reportDeliveryAttempt !== record.reportDeliveryAttempt ||
				currentCard.mainTaskConversationSessionId !== summary.taskId ||
				current.automaticRecovery?.classification === "execution_prohibited" ||
				!["report_delivery_pending", "awaiting_user_message", "failed"].includes(current.status)
			)
				return { board: latest.board, value: null, save: false };
			const pending = current.inputAwaitingCorrelatedProcessingHook;
			let next = current;
			let acceptedPromptSha256: string | null = null;
			if (isSubmission) {
				if (pending && observedAt < pending.submittedAt) return { board: latest.board, value: null, save: false };
				const isReport = submittedText?.includes("KANBAN_MAIN_SESSION_HANDOVER_REPORT:");
				// 新的无效输入也使旧候选失效，避免把下一回合处理事件串给前一条输入。
				if (
					!promptSha256 ||
					submittedText?.trimStart().startsWith("<task-notification>") ||
					(isReport && promptSha256 !== delivery?.prompt_sha256)
				) {
					if (!pending) return { board: latest.board, value: null, save: false };
					next = { ...current, inputAwaitingCorrelatedProcessingHook: undefined };
				} else {
					next = {
						...current,
						inputAwaitingCorrelatedProcessingHook: {
							promptSha256,
							inputKind: isReport ? "handover_report" : "human_followup",
							runtimeSessionIncarnationId: hook.hookRuntimeSessionIncarnationId as string,
							submittedAt: observedAt,
							submittedHookEventId: hook.hookEventDeliveryIdempotencyKey as string,
						},
					};
				}
			} else {
				if (
					!pending ||
					pending.runtimeSessionIncarnationId !== hook.hookRuntimeSessionIncarnationId ||
					observedAt < pending.submittedAt ||
					pending.submittedHookEventId === hook.hookEventDeliveryIdempotencyKey
				)
					return { board: latest.board, value: null, save: false };
				acceptedPromptSha256 = pending.promptSha256;
				next = {
					...current,
					status: pending.inputKind === "handover_report" ? "awaiting_user_message" : "completed",
					inputAwaitingCorrelatedProcessingHook: undefined,
					errorMessage: null,
					automaticRecovery: undefined,
					updatedAt: Date.now(),
					...(pending.inputKind === "handover_report"
						? {
								reportCorrelatedProcessingAcceptanceEvidence: {
									promptSha256: pending.promptSha256,
									runtimeSessionIncarnationId: pending.runtimeSessionIncarnationId,
									submittedHookEventId: pending.submittedHookEventId,
									processingHookEventId: hook.hookEventDeliveryIdempotencyKey as string,
									observedAt,
								},
							}
						: {}),
				};
			}
			return {
				board: {
					...latest.board,
					columns: latest.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((entry) =>
							entry.id === card.id ? { ...entry, taskMainSessionHandover: next } : entry,
						),
					})),
				},
				value: acceptedPromptSha256,
			};
		},
	);
	return {
		acceptedPromptSha256: outcome.value,
		metadata: outcome.state.sessions[summary.taskId]?.taskConversationSessionMetadata,
	};
}
