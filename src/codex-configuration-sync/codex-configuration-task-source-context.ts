import { readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { listWorkspaceIndexEntries, loadPersistedWorkspaceStateById } from "../state/workspace-state";
import {
	type CodexConfigurationTaskSourceContext,
	codexConfigurationTaskSourceIdentityKey,
} from "./codex-configuration-change-presentation";
import { readCodexConfigurationSyncStore } from "./codex-configuration-sync-store";

export async function readCodexConfigurationTaskSourceContext(
	workspaces: Array<{ workspaceId: string; workspacePath: string | null }>,
): Promise<CodexConfigurationTaskSourceContext> {
	const context: CodexConfigurationTaskSourceContext = { writerTasks: {}, taskLinks: {} };
	const store = await readCodexConfigurationSyncStore().catch(() => undefined);
	const indexedWorkspaces = await listWorkspaceIndexEntries().catch(() => []);
	const workspaceById = new Map(
		indexedWorkspaces.map((entry) => [
			entry.workspaceId,
			{ workspaceId: entry.workspaceId, workspacePath: entry.repoPath },
		]),
	);
	for (const workspace of workspaces)
		if (workspace.workspacePath)
			workspaceById.set(workspace.workspaceId, { ...workspace, workspacePath: workspace.workspacePath });
	const results = await Promise.allSettled(
		[...workspaceById.values()].map(async (workspace) => {
			if (!workspace.workspacePath) throw new Error("项目路径暂不可用");
			return {
				...workspace,
				workspacePath: workspace.workspacePath,
				state: await loadPersistedWorkspaceStateById(workspace.workspaceId),
			};
		}),
	);
	for (const result of results) {
		if (result.status !== "fulfilled") continue;
		const { workspaceId, workspacePath, state } = result.value;
		const cards = state.board.columns.flatMap((column) => column.cards);
		for (const card of cards) {
			const reference = { workspaceId, taskId: card.id, taskIncarnationCreatedAtEpochMs: card.createdAt };
			context.taskLinks[codexConfigurationTaskSourceIdentityKey(reference)] = reference;
		}
		for (const summary of Object.values(state.sessions)) {
			const binding = summary.codexConfigurationWriterBinding;
			if (
				!binding ||
				binding.workspaceId !== workspaceId ||
				binding.conversationSessionId !== summary.taskId ||
				binding.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
			)
				continue;
			const taskId = summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId;
			const card = cards.find((entry) => entry.id === taskId);
			if (!store || !card || card.createdAt > binding.createdAt) continue;
			const sessionWriters = Object.values(store.writers).filter(
				(writer) =>
					writer.binding.workspaceId === workspaceId && writer.binding.conversationSessionId === summary.taskId,
			);
			const persistedTask =
				sessionWriters.find((writer) => writer.binding.writerId === binding.writerId)?.sourceTaskSnapshot ??
				sessionWriters.find((writer) => writer.sourceTaskSnapshot?.taskId === taskId)?.sourceTaskSnapshot;
			const isRecoveredWriter = sessionWriters.some((writer) => writer.binding.writerId !== binding.writerId);
			if (
				(isRecoveredWriter && !persistedTask) ||
				(persistedTask &&
					(persistedTask.taskId !== taskId || persistedTask.taskIncarnationCreatedAtEpochMs !== card.createdAt))
			)
				continue;
			context.writerTasks[binding.writerId] = {
				workspaceId,
				projectPath: workspacePath,
				taskId,
				taskTitle: card.title,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				conversationSessionId: summary.taskId,
				runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			};
		}
	}
	// 迁移别名来自身份账本，且必须再与当前 board 的 incarnation 对齐。
	try {
		await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) => {
			for (const projection of reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.values()) {
				if (projection.permanentlyRemovedFromBoardAt !== null) continue;
				const card = projection.kanbanBoardCard;
				const current =
					context.taskLinks[
						codexConfigurationTaskSourceIdentityKey({
							...card,
							workspaceId: projection.currentWorkspaceId ?? card.workspaceId,
						})
					];
				if (!current) continue;
				for (const workspaceId of projection.workspaceIdsUsedByCard ?? [card.workspaceId])
					context.taskLinks[codexConfigurationTaskSourceIdentityKey({ ...card, workspaceId })] = current;
			}
		});
	} catch {
		// 账本暂不可用只隐藏无法证明的迁移链接；下次读取和定时扫描会自动补证。
	}
	return context;
}
