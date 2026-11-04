import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type CodexNativeDirectInputReadinessObservation,
	canReconcileCodexNeedsInputWithNativeDirectInputReadiness,
	isUnchangedCodexNeedsInputReconciliationCandidate,
} from "../core/codex-native-direct-input-readiness";
import { mergeSummaryWithFacets } from "../core/session-activity";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceContextById, mutateWorkspaceState } from "./workspace-state";

// 预算在查询前落盘，校正在应用前落盘；两者都不经输入接受或交棒事件入口。
export async function persistCodexNativeDirectInputReadinessReconciliation(input: {
	workspaceId: string;
	summaryBeforeRead: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
	change:
		| { progress: NonNullable<RuntimeTaskSessionSummary["codexNativeDirectInputReadinessReconciliation"]> }
		| { observation: CodexNativeDirectInputReadinessObservation };
}): Promise<boolean> {
	const beforeLock = input.getCurrentSummary();
	if (!beforeLock || !isUnchangedCodexNeedsInputReconciliationCandidate(input.summaryBeforeRead, beforeLock))
		return false;
	const workspace = await loadWorkspaceContextById(input.workspaceId);
	if (!workspace) throw new Error("补证所属工作区暂不可读，保留当前状态等待恢复。");
	const result = await mutateWorkspaceState(
		workspace.repoPath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"runtime_codex_native_readiness_reconciliation",
			"native_agent_conversation_activity_observer",
		),
		(state) => {
			const current = input.getCurrentSummary();
			if (
				!current ||
				!isUnchangedCodexNeedsInputReconciliationCandidate(input.summaryBeforeRead, current) ||
				("observation" in input.change &&
					!canReconcileCodexNeedsInputWithNativeDirectInputReadiness(
						input.summaryBeforeRead,
						current,
						input.change.observation,
					))
			)
				return { board: state.board, value: false, save: false };
			const summary =
				"progress" in input.change
					? { ...current, codexNativeDirectInputReadinessReconciliation: input.change.progress }
					: mergeSummaryWithFacets(current, {
							turnOwner: "user",
							liveness: "live",
							userTurnKind: "review",
							reviewReason: "hook",
							codexNativeDirectInputReadinessReconciliation: null,
						});
			return { board: state.board, sessions: { ...state.sessions, [current.taskId]: summary }, value: true };
		},
	);
	return result.value;
}
