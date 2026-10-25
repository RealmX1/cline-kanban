import { resolve } from "node:path";
import { resolveRecordedCodexConversationHome } from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeAgentNativeConversationSessionIdentity, RuntimeTaskSessionSummary } from "../core/api-contract";
import { doesConversationSessionBelongToTask } from "../core/task-main-conversation-session-binding";
import { isTaskMainSessionHandoverAgentSupported } from "../core/task-main-session-handover-agent-capabilities";
import { resolveTaskMainSessionHandoverTargetAgentId } from "../core/task-main-session-handover-contract";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { mutateWorkspaceState } from "./workspace-state";

// 仅由已通过归属及代际门禁的原生 hook 调用。空白 Codex 的首条输入才建立身份，不能靠 cwd-latest 补选。
export async function captureTaskMainSessionHandoverReportNativeIdentity(input: {
	workspacePath: string;
	summary: RuntimeTaskSessionSummary;
	identity: RuntimeAgentNativeConversationSessionIdentity;
	hookRuntimeSessionIncarnationId: string | undefined;
}): Promise<void> {
	if (
		!isTaskMainSessionHandoverAgentSupported(input.summary.agentId) ||
		input.identity.sourceAgentId !== input.summary.agentId ||
		!input.summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover ||
		!input.hookRuntimeSessionIncarnationId ||
		input.hookRuntimeSessionIncarnationId !== input.summary.runtimeSessionIncarnationId
	)
		return;
	await mutateWorkspaceState(
		input.workspacePath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"runtime_capture_handover_report_native_identity",
			"handover_report_trusted_native_identity_capture",
		),
		(state) => {
			let changed = false;
			const columns = state.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => {
					const record = card.taskMainSessionHandover;
					const binding = record?.reportNativeIdentityCaptureBinding;
					if (
						!record ||
						resolveTaskMainSessionHandoverTargetAgentId(record.destination) !== input.identity.sourceAgentId ||
						!binding ||
						record.reportAcceptanceProbe ||
						!["report_delivery_pending", "failed"].includes(record.status) ||
						record.targetTaskConversationSessionId !== input.summary.taskId ||
						card.mainTaskConversationSessionId !== input.summary.taskId ||
						!doesConversationSessionBelongToTask(input.summary, card.id) ||
						binding.runtimeSessionIncarnationId !== input.hookRuntimeSessionIncarnationId ||
						input.identity.observedAt < binding.preparedAt ||
						!input.summary.workspacePath ||
						resolve(binding.workingDirectoryPath) !== resolve(input.summary.workspacePath)
					)
						return card;
					changed = true;
					return {
						...card,
						taskMainSessionHandover: {
							...record,
							reportAcceptanceProbe: {
								targetAgentId: resolveTaskMainSessionHandoverTargetAgentId(record.destination),
								nativeSessionId: input.identity.nativeSessionId,
								transcriptPath: input.identity.transcriptPath,
								workingDirectoryPath: binding.workingDirectoryPath,
								codexConversationStorageHomeDirectoryPath:
									input.identity.sourceAgentId === "codex"
										? resolveRecordedCodexConversationHome({
												codexConversationStorageHomeDirectoryPath:
													binding.codexConversationStorageHomeDirectoryPath,
												transcriptPath: input.identity.transcriptPath,
											})
										: undefined,
								nativeHistoryCursor: null,
								transcriptHistoryCursor: null,
								seenNativeHistoryCursors: [],
								historicalAcceptanceEvidence: null,
							},
						},
					};
				}),
			}));
			return { board: changed ? { ...state.board, columns } : state.board, value: null, save: changed };
		},
	);
}
