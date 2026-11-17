import { type ComponentProps, useEffect, useRef, useState } from "react";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { useNonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";
import { TaskEditorDialogForm } from "@/components/task-editor-dialog";
import { useTaskEditor } from "@/hooks/use-task-editor";
import type { BoardData } from "@/types";

type TaskEditorDialogProps = ComponentProps<typeof TaskEditorDialogForm>;

/** 每个窗口拥有原有编辑 controller；背景 App 的选中任务与 setBoard 不进入该实例。 */
function TaskEditorHostedSession(props: TaskEditorDialogProps) {
	const editing = props.taskEditorMode === "edit";
	const sourceWorkspaceId = props.editorSessionWorkspaceId ?? props.workspaceId;
	const [board, setBoard] = useState<BoardData>(() => ({
		columns: [
			{ id: "backlog", title: "Backlog", cards: props.editingTaskSnapshot ? [props.editingTaskSnapshot] : [] },
		],
	}));
	const controller = useTaskEditor({
		board,
		setBoard,
		currentProjectId: sourceWorkspaceId,
		createTaskBranchOptions: props.branchOptions,
		editTaskBranchOptions: props.branchOptions,
		defaultTaskBranchRef: props.branchRef,
		defaultCreateTaskBranchRef: props.branchRef,
		selectedAgentId: props.defaultAgentId ?? null,
		newTaskStartInPlanModeByDefault: props.startInPlanMode,
		isNewTaskStartInPlanModeDefaultLoaded: true,
		ompAgentSessionTransportForNewTasks: props.ompAgentSessionTransportForNewTasks ?? "pty_terminal",
		newTaskAgentPermissionModeByDefault: props.taskAgentPermissionMode,
		openTaskInOtherProjectAfterStart: props.onOpenCreatedTaskWithRelations,
	});
	const initialized = useRef(false);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		if (editing && props.editingTaskSnapshot && sourceWorkspaceId)
			controller.handleOpenEditTaskCardInOtherProject(sourceWorkspaceId, props.editingTaskSnapshot);
		else controller.handleOpenCreateTask();
		if (props.workspaceId)
			(editing ? controller.handleSelectEditTaskTargetProject : controller.handleSelectTaskCreationTargetProject)(
				props.workspaceId,
			);
		(editing ? controller.setEditTaskPrompt : controller.setNewTaskPrompt)?.(props.prompt);
		(editing ? controller.setEditTaskImages : controller.setNewTaskImages)?.(props.images);
		(editing ? controller.setEditTaskStartInPlanMode : controller.setNewTaskStartInPlanMode)?.(props.startInPlanMode);
		(editing ? controller.setEditTaskAgentPermissionMode : controller.setNewTaskAgentPermissionMode)?.(
			props.taskAgentPermissionMode,
		);
		(editing
			? controller.setEditTaskCodexConfigurationProfileId
			: controller.setNewTaskCodexConfigurationProfileId)?.(props.codexConfigurationProfileId);
		(editing
			? controller.setEditTaskCodexReasoningEffortOverride
			: controller.setNewTaskCodexReasoningEffortOverride)?.(props.codexReasoningEffortOverride);
		(editing
			? controller.setEditTaskCodexConfigurationPermissionSelectionSource
			: controller.setNewTaskCodexConfigurationPermissionSelectionSource)?.(
			props.codexConfigurationPermissionSelectionSource,
		);
		(editing ? controller.setEditTaskConversationMode : controller.setNewTaskConversationMode)?.(
			props.taskConversationMode,
		);
		(editing ? controller.setEditTaskAutoReviewEnabled : controller.setNewTaskAutoReviewEnabled)?.(
			props.autoReviewEnabled,
		);
		(editing ? controller.setEditTaskAutoReviewMode : controller.setNewTaskAutoReviewMode)?.(props.autoReviewMode);
		(editing ? controller.setEditTaskBranchRef : controller.setNewTaskBranchRef)?.(props.branchRef);
		(editing ? controller.setEditTaskWorktreeMode : controller.setNewTaskWorktreeMode)?.(props.worktreeMode);
		(editing ? controller.setEditTaskAgentId : controller.setNewTaskAgentId)?.(props.agentId);
		(editing
			? controller.setEditTaskTerminalAgentModelOverrideSettings
			: controller.setNewTaskTerminalAgentModelOverrideSettings)?.(props.terminalAgentModelOverrideSettings);
		(editing ? controller.setEditTaskAgentSessionInitialization : controller.setNewTaskAgentSessionInitialization)?.(
			props.taskAgentSessionInitialization,
		);
		controller.setNewTaskName(props.creatingTaskName ?? "");
		controller.setEditTaskName(props.editingTaskName ?? "");
		setReady(true);
	}, [controller, editing, props, sourceWorkspaceId]);
	if (!ready) return null;
	const projectField = props.taskCreationTargetProjectField;
	const targetWorkspaceId = editing ? controller.editTaskTargetWorkspaceId : controller.taskCreationTargetWorkspaceId;
	return (
		<TaskEditorDialogForm
			{...props}
			codexReasoningEffortOverride={
				editing ? controller.editTaskCodexReasoningEffortOverride : controller.newTaskCodexReasoningEffortOverride
			}
			onCodexReasoningEffortOverrideChange={
				editing
					? controller.setEditTaskCodexReasoningEffortOverride
					: controller.setNewTaskCodexReasoningEffortOverride
			}
			open
			onOpenChange={(open) => {
				if (!open) {
					if (editing) controller.handleCancelEditTask();
					else controller.handleCancelCreateTask();
					props.onOpenChange(false);
				}
			}}
			suspendedTaskEditorTitle={null}
			workspaceId={targetWorkspaceId}
			creatingTaskName={controller.newTaskName}
			onCreatingTaskNameChange={controller.setNewTaskName}
			editingTaskName={controller.editTaskName}
			onEditingTaskNameChange={controller.setEditTaskName}
			branchOptions={
				editing
					? controller.editTaskBranchOptionsForEditTarget
					: controller.createTaskBranchOptionsForCreationTarget
			}
			taskCreationTargetProjectField={
				projectField?.taskCreationTargetProjectFieldPresentation === "target_project_selectable_in_board_scope"
					? {
							...projectField,
							selectedTargetWorkspaceId: targetWorkspaceId,
							onSelectTargetWorkspaceId: editing
								? controller.handleSelectEditTaskTargetProject
								: controller.handleSelectTaskCreationTargetProject,
						}
					: projectField
			}
			onCreate={editing ? controller.handleSaveEditedTask : controller.handleCreateTask}
			onCreateMultiple={controller.handleCreateTasks}
			onRevertEditTaskFormToSavedTaskContent={controller.handleRevertEditTaskFormToSavedTaskContent}
			onAdoptPromotedTaskEditDraft={controller.handleAdoptPromotedTaskEditDraft}
			prompt={editing ? controller.editTaskPrompt : controller.newTaskPrompt}
			onPromptChange={editing ? controller.setEditTaskPrompt : controller.setNewTaskPrompt}
			taskDescription={editing ? controller.editTaskDescription : controller.newTaskDescription}
			onTaskDescriptionChange={editing ? controller.setEditTaskDescription : controller.setNewTaskDescription}
			images={editing ? controller.editTaskImages : controller.newTaskImages}
			onImagesChange={editing ? controller.setEditTaskImages : controller.setNewTaskImages}
			startInPlanMode={editing ? controller.editTaskStartInPlanMode : controller.newTaskStartInPlanMode}
			onStartInPlanModeChange={
				editing ? controller.setEditTaskStartInPlanMode : controller.setNewTaskStartInPlanMode
			}
			taskAgentPermissionMode={
				editing ? controller.editTaskAgentPermissionMode : controller.newTaskAgentPermissionMode
			}
			onTaskAgentPermissionModeChange={
				editing ? controller.setEditTaskAgentPermissionMode : controller.setNewTaskAgentPermissionMode
			}
			codexConfigurationProfileId={
				editing ? controller.editTaskCodexConfigurationProfileId : controller.newTaskCodexConfigurationProfileId
			}
			onCodexConfigurationProfileIdChange={
				editing
					? controller.setEditTaskCodexConfigurationProfileId
					: controller.setNewTaskCodexConfigurationProfileId
			}
			codexConfigurationPermissionSelectionSource={
				editing
					? controller.editTaskCodexConfigurationPermissionSelectionSource
					: controller.newTaskCodexConfigurationPermissionSelectionSource
			}
			onCodexConfigurationPermissionSelectionSourceChange={
				editing
					? controller.setEditTaskCodexConfigurationPermissionSelectionSource
					: controller.setNewTaskCodexConfigurationPermissionSelectionSource
			}
			taskConversationMode={editing ? controller.editTaskConversationMode : controller.newTaskConversationMode}
			onTaskConversationModeChange={
				editing ? controller.setEditTaskConversationMode : controller.setNewTaskConversationMode
			}
			autoReviewEnabled={editing ? controller.editTaskAutoReviewEnabled : controller.newTaskAutoReviewEnabled}
			onAutoReviewEnabledChange={
				editing ? controller.setEditTaskAutoReviewEnabled : controller.setNewTaskAutoReviewEnabled
			}
			autoReviewMode={editing ? controller.editTaskAutoReviewMode : controller.newTaskAutoReviewMode}
			onAutoReviewModeChange={editing ? controller.setEditTaskAutoReviewMode : controller.setNewTaskAutoReviewMode}
			branchRef={editing ? controller.editTaskBranchRef : controller.newTaskBranchRef}
			onBranchRefChange={editing ? controller.setEditTaskBranchRef : controller.setNewTaskBranchRef}
			worktreeMode={editing ? controller.editTaskWorktreeMode : controller.newTaskWorktreeMode}
			onWorktreeModeChange={editing ? controller.setEditTaskWorktreeMode : controller.setNewTaskWorktreeMode}
			agentId={editing ? controller.editTaskAgentId : controller.newTaskAgentId}
			onAgentIdChange={editing ? controller.setEditTaskAgentId : controller.setNewTaskAgentId}
			terminalAgentModelOverrideSettings={
				editing
					? controller.editTaskTerminalAgentModelOverrideSettings
					: controller.newTaskTerminalAgentModelOverrideSettings
			}
			onTerminalAgentModelOverrideSettingsChange={
				editing
					? controller.setEditTaskTerminalAgentModelOverrideSettings
					: controller.setNewTaskTerminalAgentModelOverrideSettings
			}
			taskAgentSessionInitialization={
				editing ? controller.editTaskAgentSessionInitialization : controller.newTaskAgentSessionInitialization
			}
			onTaskAgentSessionInitializationChange={
				editing ? controller.setEditTaskAgentSessionInitialization : controller.setNewTaskAgentSessionInitialization
			}
		/>
	);
}

const HostedTaskEditorEntry = hostNonModalFloatingForm(TaskEditorHostedSession, {
	formKind: "task-editor",
	openingRequestIdentity: (props) => props.openingRequestIdentity,
	isOpen: (props) => props.open,
	instanceIdentity: (props) =>
		props.taskEditorMode === "edit"
			? JSON.stringify([
					props.editorSessionWorkspaceId ?? props.workspaceId,
					props.editingTaskId,
					props.editingTaskSnapshot?.createdAt,
				])
			: "single-task-creation-session",
	ownership: (props) => ({
		workspaceId: props.editorSessionWorkspaceId ?? props.workspaceId,
		taskId: props.editingTaskId,
		taskIncarnationCreatedAtEpochMs: props.editingTaskSnapshot?.createdAt,
		taskTitleSnapshot: props.editingTaskSnapshot?.title,
	}),
	withClose: (props, close) => ({
		...props,
		onOpenChange: (open) => {
			if (!open) close();
		},
	}),
	onClosed: (props) => props.onOpenChange(false),
});

export function TaskEditorDialog(props: TaskEditorDialogProps) {
	const host = useNonModalFloatingFormWindowHost();
	return host ? <HostedTaskEditorEntry {...props} /> : <TaskEditorDialogForm {...props} />;
}
