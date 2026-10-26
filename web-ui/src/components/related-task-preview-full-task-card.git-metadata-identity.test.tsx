import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelatedTaskPreviewFullTaskCard } from "@/components/related-task-preview-full-task-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeCrossProjectTaskWorktreeGitMetadata } from "@/runtime/types";
import {
	applyCrossProjectTaskWorktreeGitMetadataPollResults,
	getCrossProjectTaskWorktreeGitMetadataPollObservation,
	resetCrossProjectTaskWorktreeGitMetadataStore,
} from "@/stores/cross-project-task-worktree-git-metadata-store";

const readGitMetadata = vi.hoisted(() => vi.fn());
const documentVisibility = vi.hoisted(() => vi.fn());
const cardSnapshotError = vi.hoisted(() => ({
	message: null as string | null,
	columnId: "review" as "review" | "backlog",
}));
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: readGitMetadata,
}));
vi.mock("@/hooks/use-document-visibility", () => ({ useDocumentVisibility: documentVisibility }));
vi.mock("@/hooks/use-qualified-task-card-snapshot-for-related-preview", () => ({
	useQualifiedTaskCardSnapshotForRelatedPreview: (task: KanbanBoardCardWorkUnitQualifiedReference) => ({
		snapshot: {
			taskCard: {
				id: task.taskId,
				title: `关联任务 ${task.taskIncarnationCreatedAtEpochMs}`,
				prompt: "预览内容",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: task.taskIncarnationCreatedAtEpochMs,
				updatedAt: task.taskIncarnationCreatedAtEpochMs,
			},
			boardColumnIdContainingTaskCard: cardSnapshotError.columnId,
		},
		isLoading: false,
		error: cardSnapshotError.message,
		retry: vi.fn(),
	}),
}));

function gitMetadata(createdAt?: number, ahead = 97): RuntimeCrossProjectTaskWorktreeGitMetadata {
	return {
		workspaceId: "project-a",
		taskId: "same-id",
		...(createdAt === undefined ? {} : { taskIncarnationCreatedAtEpochMs: createdAt }),
		availability: "available",
		taskWorkspaceMetadata: {
			taskId: "same-id",
			path: `/isolated/task-${createdAt ?? "unknown"}`,
			exists: true,
			baseRef: "main",
			baseCommit: null,
			commitsAheadOfBaseRef: ahead,
			commitsBehindBaseRef: 0,
			workspaceGitStatus: {
				baseRef: "main",
				commitsAheadOfBaseRef: ahead,
				commitsBehindBaseRef: 0,
				taskCommitsIntegratedIntoBaseRef: 0,
				taskCommitIntegrationTrackingStatus: "complete",
				observationSource: "live_worktree",
				observedAt: 5_000,
			},
			branch: null,
			isDetached: true,
			headCommit: "abc",
			changedFiles: 3,
			additions: 4,
			deletions: 2,
			stateVersion: 1,
		},
	};
}

let root: Root;
let container: HTMLDivElement;
async function renderPreview(createdAt = 1_000) {
	await act(async () => {
		root.render(
			<TooltipProvider>
				<RelatedTaskPreviewFullTaskCard
					task={{
						workUnitType: "kanban_board_card",
						workspaceId: "project-a",
						taskId: "same-id",
						taskIncarnationCreatedAtEpochMs: createdAt,
					}}
					workspaceRepositoryPath="/isolated/repository"
					onOpen={() => {}}
				/>
			</TooltipProvider>,
		);
	});
}
function aheadCountText() {
	return container.querySelector("[data-task-card-base-branch-relation-group]")?.textContent ?? "";
}

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	readGitMetadata.mockReset().mockResolvedValue({ tasks: [] });
	documentVisibility.mockReset().mockReturnValue(true);
	cardSnapshotError.message = null;
	cardSnapshotError.columnId = "review";
	resetCrossProjectTaskWorktreeGitMetadataStore();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	resetCrossProjectTaskWorktreeGitMetadataStore();
	vi.useRealTimers();
});

describe("完整关联卡片的 Git 元数据身份隔离", () => {
	it("同项目同 ID 重建的响应与共享快照不能进入旧一世预览", async () => {
		applyCrossProjectTaskWorktreeGitMetadataPollResults([gitMetadata(2_000)]);
		readGitMetadata.mockResolvedValue({ tasks: [gitMetadata(2_000)] });
		await renderPreview();
		expect(aheadCountText()).not.toContain("97");
		expect(container.querySelector("[data-task-card-line-change-statistics-group]")).toBeNull();
	});

	it("仅显示绑定当前完整身份的结果，并且不写入切换器共享快照", async () => {
		readGitMetadata.mockResolvedValue({ tasks: [gitMetadata(1_000)] });
		await renderPreview();
		expect(aheadCountText()).toContain("97");
		expect(getCrossProjectTaskWorktreeGitMetadataPollObservation("project-a", "same-id")).toBeNull();
		expect(readGitMetadata).toHaveBeenCalledWith(null, {
			tasks: [{ workspaceId: "project-a", taskId: "same-id" }],
		});
	});

	it("旧运行时缺少身份字段时保留未知，不回退到共享状态", async () => {
		applyCrossProjectTaskWorktreeGitMetadataPollResults([gitMetadata(1_000)]);
		readGitMetadata.mockResolvedValue({ tasks: [gitMetadata()] });
		await renderPreview();
		expect(aheadCountText()).not.toContain("97");
	});

	it("同 ID 快速切换到另一世后忽略旧一世的迟到响应", async () => {
		let finishOldRead: (value: { tasks: RuntimeCrossProjectTaskWorktreeGitMetadata[] }) => void = () => {};
		readGitMetadata
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldRead = resolve;
					}),
			)
			.mockResolvedValue({ tasks: [gitMetadata(2_000, 23)] });
		await renderPreview();
		await renderPreview(2_000);
		expect(aheadCountText()).toContain("23");
		await act(async () => finishOldRead({ tasks: [gitMetadata(1_000)] }));
		expect(aheadCountText()).toContain("23");
		expect(aheadCountText()).not.toContain("97");
		expect(getCrossProjectTaskWorktreeGitMetadataPollObservation("project-a", "same-id")).toBeNull();
	});

	it("当前查询失败后清空 Git 展示，下一轮成功自动恢复", async () => {
		readGitMetadata.mockResolvedValue({ tasks: [gitMetadata(1_000)] });
		await renderPreview();
		expect(aheadCountText()).toContain("97");
		readGitMetadata.mockRejectedValueOnce(new Error("读取失败"));
		await act(async () => vi.advanceTimersByTime(5_000));
		expect(aheadCountText()).not.toContain("97");
		await act(async () => vi.advanceTimersByTime(5_000));
		expect(aheadCountText()).toContain("97");
	});

	it("卡片身份读取失败时隐藏已有 Git 展示并暂停查询", async () => {
		readGitMetadata.mockResolvedValue({ tasks: [gitMetadata(1_000)] });
		await renderPreview();
		cardSnapshotError.message = "无法确认卡片身份";
		await renderPreview();
		expect(aheadCountText()).not.toContain("97");
		await act(async () => vi.advanceTimersByTime(10_000));
		expect(readGitMetadata).toHaveBeenCalledTimes(1);
	});

	it("隐藏页面与 Backlog 不查询；慢请求不重叠，卸载后响应不污染共享状态", async () => {
		documentVisibility.mockReturnValue(false);
		await renderPreview();
		expect(readGitMetadata).not.toHaveBeenCalled();
		documentVisibility.mockReturnValue(true);
		cardSnapshotError.columnId = "backlog";
		await renderPreview();
		expect(readGitMetadata).not.toHaveBeenCalled();
		let finishRead: (value: { tasks: RuntimeCrossProjectTaskWorktreeGitMetadata[] }) => void = () => {};
		readGitMetadata.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRead = resolve;
				}),
		);
		cardSnapshotError.columnId = "review";
		await renderPreview();
		await act(async () => vi.advanceTimersByTime(15_000));
		expect(readGitMetadata).toHaveBeenCalledTimes(1);
		await act(async () => root.render(null));
		await act(async () => finishRead({ tasks: [gitMetadata(1_000)] }));
		expect(getCrossProjectTaskWorktreeGitMetadataPollObservation("project-a", "same-id")).toBeNull();
	});
});
