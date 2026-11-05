import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone } from "@/hooks/use-post-deploy-verification-done-entry-closure-dialog-for-board-moves-into-done";
import type { BoardData } from "@/types";

it("A 的迟到核对请求在背景已切到 B 后仍绑定 A 的看板和一世任务", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const board = (createdAt: number): BoardData => ({
		columns: [
			{
				id: "validation",
				title: "待验证",
				cards: [
					{
						id: "same-task",
						title: "原任务",
						prompt: "需求",
						createdAt,
						updatedAt: createdAt,
						baseRef: "main",
						startInPlanMode: false,
					},
				],
			},
		],
	});
	const boardA = board(100);
	const boardB = board(200);
	let current: ReturnType<typeof usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone>;
	function Harness({ workspaceId, sourceBoard }: { workspaceId: string; sourceBoard: BoardData }) {
		current = usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone({
			workspaceId,
			board: sourceBoard,
			postDeployVerificationActiveDeploymentGroup: null,
		});
		return null;
	}
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await act(async () => root.render(<Harness workspaceId="project-a" sourceBoard={boardA} />));
		const openRequestFromA = current!.openClosureDialogForBoardMoveIntoDone;
		await act(async () => root.render(<Harness workspaceId="project-b" sourceBoard={boardB} />));
		await act(async () =>
			openRequestFromA({
				taskId: "same-task",
				insertAtIndexWithinDoneBoardColumn: undefined,
				runtimeRejectedMoveIntoDoneForMissingClosureReasons: false,
			}),
		);
		expect(current!.closureDialogForBoardMoveIntoDone?.dialogRequest.workspaceIdAtOpening).toBe("project-a");
		expect(current!.closureDialogForBoardMoveIntoDone?.dialogRequest.boardSnapshotAtOpening).toBe(boardA);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
