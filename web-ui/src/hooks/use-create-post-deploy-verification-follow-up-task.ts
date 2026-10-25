import { useCallback, useRef } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	buildPostDeployVerificationFollowUpTaskCreationDraftSeed,
	type PostDeployVerificationFollowUpTaskCreationDraftSeed,
} from "@/components/post-deploy-verification/post-deploy-verification-follow-up-task-creation-draft";
import { readPostDeployVerificationFollowUpSourceTaskIdentity } from "@/runtime/post-deploy-verification-entry-navigation-query";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimeProjectSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";

export function useCreatePostDeployVerificationFollowUpTask(input: {
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	historyGroups: readonly RuntimePostDeployVerificationDeploymentGroup[];
	board: BoardData | null;
	projects: readonly RuntimeProjectSummary[];
	isTaskEditorOpen: boolean;
	canOpenTaskEditor: boolean;
	openTaskEditor: (workspaceId: string) => void;
	initializeFollowUpDraft: (seed: PostDeployVerificationFollowUpTaskCreationDraftSeed) => void;
}) {
	const latest = useRef(input);
	latest.current = input;
	const inFlight = useRef(false);
	return useCallback(async (deploymentId: string, taskId: string, selectedChecklistItemIds: string[]) => {
		if (inFlight.current) return;
		const initial = latest.current;
		if (initial.isTaskEditorOpen) {
			showAppToast({ intent: "warning", message: "请先完成或关闭当前任务编辑，再创建关联续接任务。" });
			return;
		}
		inFlight.current = true;
		try {
			const group = [initial.activeGroup, ...initial.historyGroups].find(
				(group) => group?.deploymentId === deploymentId,
			);
			const task = group?.tasks.find((task) => task.taskId === taskId);
			const project = initial.projects.find((project) => project.id === group?.workspaceId);
			if (!group || !task || project?.availability.status !== "available" || !initial.canOpenTaskEditor)
				throw new Error("来源项目或部署状态已变化，请刷新后重试。");
			const card = initial.board ? findCardSelection(initial.board, taskId)?.card : null;
			const source = card
				? { title: card.title, createdAt: card.createdAt }
				: await readPostDeployVerificationFollowUpSourceTaskIdentity({ workspaceId: group.workspaceId, taskId });
			const current = latest.current;
			const currentGroup = [current.activeGroup, ...current.historyGroups].find(
				(candidate) => candidate?.workspaceId === group.workspaceId && candidate.deploymentId === deploymentId,
			);
			const currentTask = currentGroup?.tasks.find((candidate) => candidate.taskId === taskId);
			if (
				current.isTaskEditorOpen ||
				!currentTask ||
				current.projects.find((project) => project.id === group.workspaceId)?.availability.status !== "available"
			)
				throw new Error("来源状态或任务编辑已变化，请重新发起续接。");
			const seed = buildPostDeployVerificationFollowUpTaskCreationDraftSeed({
				workspaceId: group.workspaceId,
				projectName: project.name,
				sourceTaskTitle: source.title,
				sourceTaskCreatedAt: source.createdAt,
				deploymentId,
				deployedSourceCommit: group.deployedSourceCommit,
				deployedAtIso: group.deployedAtIso,
				task: currentTask,
				selectedChecklistItemIds,
			});
			current.openTaskEditor(group.workspaceId);
			current.initializeFollowUpDraft(seed);
		} catch (error) {
			showAppToast({ intent: "warning", message: error instanceof Error ? error.message : String(error) });
		} finally {
			inFlight.current = false;
		}
	}, []);
}
