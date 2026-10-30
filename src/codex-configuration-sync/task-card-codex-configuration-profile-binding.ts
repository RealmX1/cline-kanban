import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { mutateWorkspaceState } from "../state/workspace-state";

export async function persistCodexConfigurationProfileBindingForMainTaskSession(input: {
	workspaceId: string;
	workspacePath: string;
	conversationSessionId: string;
	profileId: string;
	permissionSelectionSource?: "profile" | "task_local";
	onlyUpdatePermissionSelectionSource?: boolean;
	broadcastWorkspaceUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}) {
	const mutation = await mutateWorkspaceState(
		input.workspacePath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"codex_configuration_profile_binding",
			"persist_main_task_profile_binding",
		),
		(state) => {
			let changed = false;
			let conflictingProfileBinding = false;
			const board = {
				...state.board,
				columns: state.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => {
						if (resolveMainTaskConversationSessionId(card) !== input.conversationSessionId) return card;
						if (
							input.onlyUpdatePermissionSelectionSource &&
							card.codexConfigurationProfileId &&
							card.codexConfigurationProfileId !== input.profileId
						) {
							conflictingProfileBinding = true;
							return card;
						}
						if (
							card.codexConfigurationProfileId === input.profileId &&
							(input.permissionSelectionSource === undefined ||
								card.codexConfigurationPermissionSelectionSource === input.permissionSelectionSource)
						)
							return card;
						changed = true;
						return {
							...card,
							codexConfigurationProfileId: input.profileId,
							...(input.permissionSelectionSource
								? { codexConfigurationPermissionSelectionSource: input.permissionSelectionSource }
								: {}),
						};
					}),
				})),
			};
			return { board, value: !conflictingProfileBinding, save: changed };
		},
	);
	if (mutation.saved) await input.broadcastWorkspaceUpdated?.(input.workspaceId, input.workspacePath);
	return mutation.value;
}
