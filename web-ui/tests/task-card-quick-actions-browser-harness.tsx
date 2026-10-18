import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PostDeployVerificationPanel } from "../src/components/post-deploy-verification/post-deploy-verification-panel";
import { createPostDeployVerificationTaskReadModelTestFixture } from "../src/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import { createInitialBoardData } from "../src/data/board-data";
import type { RuntimePostDeployVerificationDeploymentGroup } from "../src/runtime/types";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCommentBeforeMoveIntoDoneDialog } from "../src/components/task-comment-before-move-into-done-dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useTaskCommentBeforeMoveIntoDone } from "../src/hooks/use-task-comment-before-move-into-done";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const card: BoardCard = { id: "quick-actions-card", title: "核对任务卡快捷操作", prompt: "原始 Prompt\n  保留缩进与标点 $() `code`\n", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };

const postDeployVerificationBoard = createInitialBoardData();
postDeployVerificationBoard.columns.find((column) => column.id === "validation")!.cards = [card];
const postDeployVerificationGroup: RuntimePostDeployVerificationDeploymentGroup = {
	deploymentId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "isolated-browser-fixture",
	deployedSourceCommit: "1111111",
	previousDeployedSourceCommit: null,
	deployedAtIso: "2026-10-18T00:00:00.000Z",
	foldedAtIso: null,
	tasks: [createPostDeployVerificationTaskReadModelTestFixture({
		taskId: card.id,
		columnIdAtMatch: "validation",
		taskDeploymentAttribution: {
			taskDeploymentAttributionZone: "task_commits_included_in_this_deployment_delta",
			matchedDeployedCommitsInThisDeploymentDelta: [],
			taskDeploymentUnattributableReason: null,
			attributionComputedAtIso: "2026-10-18T00:00:00.000Z",
		},
	})],
};

function Harness() {
	const [directMoveCount, setDirectMoveCount] = useState(0);
	const [submittedComment, setSubmittedComment] = useState("");
	const controller = useTaskCommentBeforeMoveIntoDone();
	const query = new URLSearchParams(location.search);
	const mobile = query.has("touch");
	const showPostDeployVerificationPanel = query.has("post-deploy-verification");
	const moveToDone = (_taskId: string, options?: { requestTaskCommentBeforeMovingIntoDone?: boolean }) => {
		if (options?.requestTaskCommentBeforeMovingIntoDone) controller.open("isolated-browser-fixture", card);
		else setDirectMoveCount((count) => count + 1);
	};
	return <TooltipProvider><main className="mx-auto mt-60 max-w-xl px-4">
		{showPostDeployVerificationPanel ? <PostDeployVerificationPanel
			activeGroup={postDeployVerificationGroup}
			historyGroups={[]}
			hasLoadedOnce
			loadError={null}
			board={postDeployVerificationBoard}
			realTaskCardRenderingInputs={{
				realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser",
				currentProjectTaskSessions: {},
				currentProjectTaskCardActionHandlers: { onMoveToTrashTask: moveToDone },
				currentProjectWorkspacePath: null,
				onActivateTaskCardOpeningTaskDetail: () => {},
				defaultAgentId: null,
				defaultClineModelId: null,
			}}
			postDeployVerificationWorkspaceProjectNameShownInPanelHeader={null}
			stayInFront
			collapsed={false}
			loweredForDialog={controller.request !== null}
			isBatchClosureWithReasonsInFlight={false}
			completingTaskId={null}
			onToggleStayInFront={() => {}}
			onToggleCollapsed={() => {}}
			onRequestBatchClosureWithReasonsOfZoneTasks={() => {}}
			onToggleChecklistItem={() => {}}
			onAddCustomChecklistItem={() => {}}
			onRemoveCustomChecklistItem={() => {}}
			onRunVerificationItem={() => {}}
			onRequestComplete={() => moveToDone(card.id)}
			onSelectTask={() => {}}
			onNavigateToBoard={() => {}}
		/> : <TaskCardBody card={card} columnId="validation" renderRole={mobile ? "focused_task_card_copy_in_mobile_detail_header" : "canonical_card_in_its_stage_list"}
			onMoveToTrash={moveToDone} />}
		<output aria-label="直接移动次数">{directMoveCount}</output>
		<output aria-label="已提交评论">{submittedComment}</output>
		<TaskCommentBeforeMoveIntoDoneDialog controller={controller} onSubmit={(text) => {
			const comment = controller.prepareSubmission(text);
			if (comment) { setSubmittedComment(comment.commentText); controller.complete(card.id, comment.taskCommentEntryId); }
		}} />
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
