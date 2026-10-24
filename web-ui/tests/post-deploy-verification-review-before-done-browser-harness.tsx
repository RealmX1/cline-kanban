import { useState } from "react";
import { createRoot } from "react-dom/client";

import { PostDeployVerificationReviewBeforeMoveIntoDoneDialog } from "../src/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import { TaskCardBody } from "../src/components/task-card-body";
import { buildTaskCardBusinessProps } from "../src/components/task-card-business-props";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { usePostDeployVerification } from "../src/hooks/use-post-deploy-verification";
import type { BoardColumnId } from "../src/types";
import "../src/styles/globals.css";

function Harness() {
	const columnParameter = new URL(location.href).searchParams.get("column");
	const columnId: BoardColumnId = columnParameter === "review" || columnParameter === "in_progress" ? columnParameter : "validation";
	const [reviewOpen, setReviewOpen] = useState(false);
	const [result, setResult] = useState("");
	const [observedInteractionCount, setObservedInteractionCount] = useState(0);
	const verification = usePostDeployVerification("isolated-pdv-workspace", { pollingEnabled: false });
	const card = { id: "task-1", title: "待结案任务的完整真实 Task Card", prompt: "核对完成后才能结案", baseRef: "main", startInPlanMode: false, createdAt: 1, updatedAt: 1 };
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === columnId)!.cards.push(card);
	const handlers = { onMoveToTrashTask: () => setReviewOpen(true) };
	return <TooltipProvider><main className="min-h-screen bg-surface-0 p-4 text-text-primary">
		<div className="max-w-md"><TaskCardBody {...buildTaskCardBusinessProps({ card, columnId, handlers, sessionSummary: undefined, workspacePath: null, defaultAgentId: null, defaultClineModelId: null, onActivateCard: () => {} })} /></div>
		<div data-verification-anchor="board-column:validation" className="mt-4">
			<button type="button" onClick={() => setObservedInteractionCount((count) => count + 1)}>实际界面操作</button>
			<output aria-label="实际交互次数">{observedInteractionCount}</output>
		</div>
		{columnId === "in_progress" ? <button aria-label="Move task to done" onClick={() => setReviewOpen(true)}>详情底栏：移入 Done</button> : null}
		<output aria-label="结案结果">{result}</output>
		{reviewOpen ? <PostDeployVerificationReviewBeforeMoveIntoDoneDialog
			workspaceId="isolated-pdv-workspace" taskId={card.id} board={board} verification={verification}
			realTaskCardRenderingInputs={{ realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser", currentProjectTaskSessions: {}, currentProjectTaskCardActionHandlers: handlers, currentProjectWorkspacePath: null, onActivateTaskCardOpeningTaskDetail: () => {}, defaultAgentId: null, defaultClineModelId: null }}
			isSubmittingClosure={false} onCancel={() => setReviewOpen(false)}
			onConfirmClosureRequestsBySelectedTaskId={(requests) => { setResult(JSON.stringify(requests)); setReviewOpen(false); }}
		/> : null}
	</main></TooltipProvider>;
}

createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
