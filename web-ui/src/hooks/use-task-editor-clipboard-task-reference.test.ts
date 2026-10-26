import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
	parseTaskEditorClipboardTaskReference,
	useTaskEditorClipboardTaskReference,
} from "@/hooks/use-task-editor-clipboard-task-reference";
import { resolveTaskEditorClipboardTaskCandidates } from "@/runtime/work-unit-relation-modeling-query";

vi.mock("@/runtime/work-unit-relation-modeling-query", () => ({
	resolveTaskEditorClipboardTaskCandidates: vi.fn(),
}));

describe("编辑器剪贴板任务引用", () => {
	it("复用完整短 ID 判据，接受工作树路径，保留仓库名而不假定它是唯一项目身份", () => {
		expect(parseTaskEditorClipboardTaskReference("EE150")).toEqual({ taskId: "ee150", repositoryFolder: null });
		expect(parseTaskEditorClipboardTaskReference("z9x8w")).toEqual({ taskId: "z9x8w", repositoryFolder: null });
		expect(parseTaskEditorClipboardTaskReference("“/Users/bominzhang/.cline/worktrees/ee150/cline-kanban”")).toEqual({
			taskId: "ee150",
			repositoryFolder: "cline-kanban",
		});
		expect(parseTaskEditorClipboardTaskReference("~/.cline/worktrees/ab12c/中文项目名/")).toEqual({
			taskId: "ab12c",
			repositoryFolder: "中文项目名",
		});
	});
	it("不把部分 ID、任意数字长度或普通路径当成任务引用", () => {
		for (const value of [
			"ee15",
			"ee1500",
			"ee!50",
			"任务 ee150",
			"/repo/ee150/cline-kanban",
			"/Users/name/.cline/worktrees/ee150/repo/file.ts",
		])
			expect(parseTaskEditorClipboardTaskReference(value)).toBeNull();
	});
	it("剪贴板已变成普通文本时，不采用之前任务 ID 的迟到查询结果", async () => {
		type Candidates = Awaited<ReturnType<typeof resolveTaskEditorClipboardTaskCandidates>>;
		let resolveCandidates!: (candidates: Candidates) => void;
		vi.mocked(resolveTaskEditorClipboardTaskCandidates).mockReturnValue(
			new Promise((resolve) => {
				resolveCandidates = resolve;
			}),
		);
		const recognized = vi.fn();
		const captured: { current: ReturnType<typeof useTaskEditorClipboardTaskReference> | null } = { current: null };
		function ClipboardRaceHarness() {
			captured.current = useTaskEditorClipboardTaskReference({
				open: true,
				workspaceId: "project",
				taskId: null,
				onRecognized: recognized,
			});
			return null;
		}
		const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(ClipboardRaceHarness)));
			const pending = captured.current!.processPastedText("ee150");
			await captured.current!.processPastedText("随后复制的普通文本");
			await act(async () => {
				resolveCandidates([
					{
						kanbanBoardCard: {
							workUnitType: "kanban_board_card",
							workspaceId: "other-project",
							taskId: "ee150",
							taskIncarnationCreatedAtEpochMs: 1,
						},
						workspaceRepositoryPath: "/repo/other-project",
						currentTitle: "先前复制的任务",
						promptFirstParagraph: null,
						lastKnownBoardColumnId: "backlog",
						movedToTrashColumnAt: null,
						permanentlyRemovedFromBoardAt: null,
						creationActorKind: null,
						kanbanBoardCardFirstObservationRoute: "test",
					},
				]);
				await pending;
			});
			expect(recognized).not.toHaveBeenCalled();
			expect(captured.current!.selectionRequest).toBeNull();
		} finally {
			await act(async () => root.unmount());
			if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
			else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
			vi.resetAllMocks();
		}
	});
});
