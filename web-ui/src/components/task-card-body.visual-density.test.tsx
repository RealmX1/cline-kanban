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
import type { BoardCard } from "@/types";

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
		agentResponseGenerationStopped: {
			stoppedAt: NOW - 12 * 60_000,
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

function renderWithDensity(visualDensity: TaskCardBodyVisualDensity): HTMLDivElement {
	act(() =>
		root.render(
			<TaskCardBodyVisualDensityProvider value={visualDensity}>
				<TaskCardBody
					card={createCard()}
					columnId="review"
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
	it("紧凑行与标准卡片显示同一组信息项（只改排版不改内容）", () => {
		const standardItems = collectInformationItemsShown(renderWithDensity("standard_card_with_floating_capsule"));
		const compactItems = collectInformationItemsShown(renderWithDensity("compact_row_in_focus_view_left_column"));
		expect(standardItems).toEqual([
			"agent",
			"cancel-automatic-action",
			"directory",
			"pinned-marker",
			"progress-pill",
			"stopped-pill",
			"title",
		]);
		expect(compactItems).toEqual(standardItems);
	});

	it("紧凑行不画浮动胶囊与卡片边框；时长药丸、置顶标记、目录并入元信息行，取消自动动作变成行内文字按钮", () => {
		const host = renderWithDensity("compact_row_in_focus_view_left_column");
		expect(host.querySelector(".-left-2")).toBeNull();
		expect(host.querySelector(".border-border-bright.bg-surface-2")).toBeNull();
		const metadataRow = host.querySelector("[data-task-card-compact-metadata-row]");
		expect(metadataRow?.querySelector("[data-agent-response-generation-stopped-pill]")).not.toBeNull();
		expect(metadataRow?.querySelector("[data-task-pinboard-pinned-marker]")).not.toBeNull();
		expect(metadataRow?.querySelector("[data-task-directory]")).not.toBeNull();
		const cancelButton = [...(metadataRow?.querySelectorAll("button") ?? [])].find((button) =>
			button.textContent?.includes("Cancel"),
		);
		expect(cancelButton?.className).toContain("text-accent");
	});

	it("标准卡片保持原样：左上角浮动胶囊、没有紧凑元信息行", () => {
		const host = renderWithDensity("standard_card_with_floating_capsule");
		expect(host.querySelector(".-left-2 [data-agent-badge]")).not.toBeNull();
		expect(host.querySelector("[data-task-card-compact-metadata-row]")).toBeNull();
	});
});
