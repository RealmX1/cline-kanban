import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCardBody } from "@/components/task-card-body";
import {
	type TaskCardBodyVisualDensity,
	TaskCardBodyVisualDensityProvider,
} from "@/components/task-card-body-visual-density-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId } from "@/types";

// 两种视觉密度只改排版、不改内容：Focus View 左栏的紧凑行必须与主看板卡片显示同一组信息项。

const workspaceSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: workspaceSnapshotMock,
	useTaskWorkspaceInfoValue: () => null,
}));

const NOW = Date.now();

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Fix cache anchor for restored sessions",
		prompt: "Fix cache anchor",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: NOW - 3 * 24 * 60 * 60_000,
		updatedAt: NOW,
		agentId: "claude",
		pinnedToTaskPinboardAt: NOW - 60_000,
		autoReviewEnabled: true,
		autoReviewMode: "commit",
		...overrides,
	};
}

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/isolated/task-1",
		pid: 1,
		startedAt: NOW - 60 * 60_000,
		updatedAt: NOW,
		lastOutputAt: NOW - 12 * 60_000,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: NOW - 12 * 60_000,
		latestHookActivity: null,
		lastAgentConversationUserHandoffObservation: {
			observedAtMs: NOW - 12 * 60_000,
			signalConfidence: "harness_turn_complete",
			turnSequence: 3,
		},
		lastConversationProgressObservation: {
			observedAtMs: NOW - 12 * 60_000,
			evidenceKind: "agent_lifecycle_hook_event",
		},
		awaitingDispatchedBackgroundWork: null,
	};
}

let container: HTMLDivElement;
let root: Root;

function renderWithDensity(
	visualDensity: TaskCardBodyVisualDensity,
	columnId: BoardColumnId = "review",
): HTMLDivElement {
	act(() =>
		root.render(
			<TaskCardBodyVisualDensityProvider value={visualDensity}>
				<TaskCardBody
					card={createCard()}
					columnId={columnId}
					sessionSummary={createSummary()}
					onCancelAutomaticAction={() => {}}
					onUnpinFromTaskPinboard={() => {}}
				/>
			</TaskCardBodyVisualDensityProvider>,
		),
	);
	return container;
}

// 两种密度都必须出现的信息项（按 data 属性 / 可见文本识别）。
function collectInformationItemsShown(host: HTMLElement): string[] {
	const shown: string[] = [];
	if (host.querySelector("[data-agent-badge]")) shown.push("agent");
	if (host.querySelector("[data-task-created-at-pill]")) shown.push("created-at-pill");
	if (host.querySelector("[data-agent-response-generation-stopped-pill]")) shown.push("stopped-pill");
	if (host.querySelector("[data-last-conversation-progress-pill]")) shown.push("progress-pill");
	if (host.querySelector("[data-task-pinboard-pinned-marker]")) shown.push("pinned-marker");
	if (host.querySelector("[data-task-directory]")) shown.push("directory");
	if (host.textContent?.includes("Fix cache anchor for restored sessions")) shown.push("title");
	if (host.textContent?.includes("Cancel")) shown.push("cancel-automatic-action");
	return shown.sort();
}

beforeEach(() => {
	workspaceSnapshotMock.mockReturnValue({ path: "/isolated/task-1", changedFiles: 3, additions: 12, deletions: 4 });
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	} as Root;
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("TaskCardBody 的视觉密度", () => {
	it.each(["standard_bordered_task_card", "compact_row_in_focus_view_left_column"] as const)(
		"%s：元信息在标题之前，接受提示独立于时间药丸",
		(visualDensity) => {
			act(() =>
				root.render(
					<TaskCardBodyVisualDensityProvider value={visualDensity}>
						<TaskCardBody
							card={createCard()}
							columnId="review"
							sessionSummary={{
								...createSummary(),
								agentConversationPromptSubmissionAcceptance: {
									status: "pending",
									attemptedAtMs: NOW,
									submissionId: "pending-input",
									runtimeSessionIncarnationId: "test-generation",
								},
							}}
						/>
					</TaskCardBodyVisualDensityProvider>,
				),
			);
			const metadata = container.querySelector("[data-task-card-secondary-metadata-row]")!;
			const title = container.querySelector("[data-task-card-title]")!;
			const notices = container.querySelector("[data-task-card-status-notices]")!;
			expect(metadata).not.toBeNull();
			expect(metadata.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(metadata.querySelector('[role="status"]')).toBeNull();
			expect(notices?.querySelector('[role="status"]')).not.toBeNull();
		},
	);
	it.each(["standard_bordered_task_card", "compact_row_in_focus_view_left_column"] as const)(
		"%s：Kimi 活体中断显示可继续输入，保持实心存活状态点",
		(visualDensity) => {
			const summary: RuntimeTaskSessionSummary = {
				...createSummary(),
				agentId: "kimi",
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "interrupted",
				reviewReason: "interrupted",
				latestHookActivity: {
					activityText: "Resumed after user input",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "UserPromptSubmit",
					notificationType: null,
					source: "kimi",
				},
			};
			act(() => {
				root.render(
					<TaskCardBodyVisualDensityProvider value={visualDensity}>
						<TaskCardBody card={createCard({ agentId: "kimi" })} columnId="review" sessionSummary={summary} />
					</TaskCardBodyVisualDensityProvider>,
				);
			});

			expect(container.textContent).toContain("已中断，可继续输入");
			expect(container.textContent).not.toContain("Agent 回合进行中");
			expect(container.textContent).not.toContain("Waiting for review");
			const dot = container.querySelector<HTMLSpanElement>("span.inline-block.shrink-0.rounded-full");
			expect(dot).not.toBeNull();
			expect(dot?.style.backgroundColor).not.toBe("transparent");
			expect(dot?.style.border).toBe("");
			expect(dot?.getAttribute("title")).toBeNull();
		},
	);

	it.each([
		{ dirty: false, committed: false },
		{ dirty: true, committed: false },
		{ dirty: false, committed: true },
		{ dirty: true, committed: true },
	])("dirty=$dirty、已提交=$committed：在固定摘要单元格内分别隐藏零值", ({ dirty, committed }) => {
		workspaceSnapshotMock.mockReturnValue({
			path: "/isolated/task-1",
			changedFiles: dirty ? 3 : 0,
			additions: dirty ? 12 : 0,
			deletions: dirty ? 4 : 0,
			taskRetainedCommittedLineChangeSummary: {
				status: "complete",
				commitCount: 2,
				additions: committed ? 10 : 0,
				deletions: committed ? 10 : 0,
				historyVersion: "retained",
				unavailableReason: null,
			},
		});
		for (const density of ["standard_bordered_task_card", "compact_row_in_focus_view_left_column"] as const) {
			const host = renderWithDensity(density);
			const dirtyCell = host.querySelector('[data-task-card-summary-cell="dirty"]');
			const committedCell = host.querySelector('[data-task-card-summary-cell="committed_diff"]');
			expect(host.querySelectorAll("[data-task-card-summary-cell]")).toHaveLength(6);
			expect(dirtyCell?.textContent).toBe(dirty ? "(3 files +12 -4)" : "");
			expect(committedCell?.textContent).toBe(committed ? "已提交 +10 −10" : "");
		}
	});

	it("未知已提交统计继续显示为不可用，不当作零值隐藏", () => {
		workspaceSnapshotMock.mockReturnValue({ path: "/isolated/task-1", changedFiles: 0, additions: 0, deletions: 0 });
		const host = renderWithDensity("compact_row_in_focus_view_left_column");
		expect(host.querySelector('[data-task-card-summary-cell="committed_diff"]')?.textContent).toBe("已提交 —");
	});

	it("干净工作区和 Done 卡保留历史累计，dirty 零值仍隐藏", () => {
		workspaceSnapshotMock.mockReturnValue({
			path: "/isolated/task-1",
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			taskRetainedCommittedLineChangeSummary: {
				status: "complete",
				commitCount: 2,
				additions: 123,
				deletions: 45,
				historyVersion: "retained",
				unavailableReason: null,
			},
		});
		for (const density of ["standard_bordered_task_card", "compact_row_in_focus_view_left_column"] as const) {
			const host = renderWithDensity(density, "trash");
			expect(host.querySelector("[data-task-directory]")?.textContent).toContain("已提交 +123 −45");
			expect(host.querySelector("[data-task-directory]")?.textContent).not.toContain("0 files");
		}
	});
	it("紧凑行与标准卡片显示同一组信息项（只改排版不改内容）", () => {
		const standardItems = collectInformationItemsShown(renderWithDensity("standard_bordered_task_card"));
		const compactItems = collectInformationItemsShown(renderWithDensity("compact_row_in_focus_view_left_column"));
		expect(standardItems).toEqual([
			"agent",
			"cancel-automatic-action",
			"created-at-pill",
			"directory",
			"pinned-marker",
			"progress-pill",
			"stopped-pill",
			"title",
		]);
		expect(compactItems).toEqual(standardItems);
	});

	it("紧凑卡片共享摘要，取消自动动作在详情下方", () => {
		const host = renderWithDensity("compact_row_in_focus_view_left_column");
		expect(host.querySelector(".-left-2")).toBeNull();
		expect(host.querySelector(".kb-board-card-surface")?.className).not.toContain("border-border-bright");
		const metadataRow = host.querySelector("[data-task-card-compact-metadata-row]");
		expect(metadataRow?.querySelector("[data-task-created-at-pill]")?.textContent).toBe("3d");
		expect(metadataRow?.querySelector("[data-agent-response-generation-stopped-pill]")).not.toBeNull();
		expect(metadataRow?.querySelector("[data-task-pinboard-pinned-marker]")).not.toBeNull();
		expect(metadataRow?.hasAttribute("data-task-directory")).toBe(true);
		const cancelButton = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Cancel"),
		);
		expect(cancelButton?.className).toContain("text-accent");
	});

	it("标准卡片复用同一摘要，Agent 图标与标题同排", () => {
		const host = renderWithDensity("standard_bordered_task_card");
		const metadata = host.querySelector("[data-task-card-secondary-metadata-row]")!;
		expect(metadata.querySelector("[data-agent-badge]")).toBeNull();
		expect(metadata.querySelector("[data-task-created-at-pill]")).not.toBeNull();
		expect(
			host
				.querySelector("[data-task-card-title]")
				?.parentElement?.parentElement?.querySelector("[data-agent-badge]"),
		).not.toBeNull();
	});
});
