import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrossRepositoryStageFirstOverview } from "@/components/cross-repository-stage-first-overview";
import type { RuntimeInProgressTaskDetail, RuntimeProjectSummary, RuntimeProjectTaskCounts } from "@/runtime/types";

// Stage-First Overview 的渲染 + 交互契约（见 CONTEXT.md / ADR-0001）：In-Progress 内按活跃度二分
// Active/Stale；Review/Validation/Done 显示跨-repo 总计数（rawColumnTaskCounts）；点击 task 冒泡
// (repoId, taskId)。用 react-dom/client 直挂（同 project-navigation-panel.test 风格）。

const FRESH = 1_000; // 1s 前 → 在 5min 活跃窗口内
const OLD = 10 * 60_000; // 10min 前 → 窗口外

function detail(overrides: Partial<RuntimeInProgressTaskDetail> & { taskId: string }): RuntimeInProgressTaskDetail {
	return {
		title: overrides.taskId,
		agentId: null,
		lastOutputAt: null,
		turnOwner: null,
		liveness: "none",
		...overrides,
	};
}

function counts(overrides: Partial<RuntimeProjectTaskCounts> = {}): RuntimeProjectTaskCounts {
	return { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0, ...overrides };
}

function project(overrides: Partial<RuntimeProjectSummary> & { id: string }): RuntimeProjectSummary {
	return {
		name: overrides.id,
		path: `/tmp/${overrides.id}`,
		taskCounts: counts(),
		inProgressTaskDetails: [],
		...overrides,
	};
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(ui: React.ReactElement): HTMLElement {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root?.render(ui));
	return container;
}

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
});

function buttonWithText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
	return Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text) as
		| HTMLButtonElement
		| undefined;
}

describe("CrossRepositoryStageFirstOverview", () => {
	const now = Date.now();
	const PROJECTS: RuntimeProjectSummary[] = [
		project({
			id: "alpha",
			rawColumnTaskCounts: counts({ in_progress: 2, review: 2, validation: 1, trash: 3 }),
			inProgressTaskDetails: [
				detail({ taskId: "alpha-active", turnOwner: "agent", liveness: "live", lastOutputAt: now - FRESH }),
				detail({ taskId: "alpha-stale-old", turnOwner: "agent", liveness: "live", lastOutputAt: now - OLD }),
			],
		}),
		project({
			id: "beta",
			rawColumnTaskCounts: counts({ in_progress: 1, review: 1, validation: 0, trash: 5 }),
			inProgressTaskDetails: [
				// agent 已交棒等审 → turnOwner=user → 归 Stale（即便刚有输出），ADR-0001 口径。
				detail({ taskId: "beta-awaiting", turnOwner: "user", liveness: "live", lastOutputAt: now - FRESH }),
			],
		}),
	];

	it("Active 只收 agent 回合 + 近期输出；其余归 Stale", () => {
		const host = render(<CrossRepositoryStageFirstOverview projects={PROJECTS} onOpenTask={vi.fn()} />);
		// Active 组渲染活跃 task（恒展开）
		expect(buttonWithText(host, "alpha-active")).toBeTruthy();
		// >5min 的 agent task 与 awaiting_review 的 user task 归 Stale（默认折叠 → 不在 DOM）
		expect(buttonWithText(host, "alpha-stale-old")).toBeFalsy();
		expect(buttonWithText(host, "beta-awaiting")).toBeFalsy();
		// Active/Stale 计数徽标
		expect(host.textContent).toContain("Active");
		expect(host.textContent).toContain("Stale");
	});

	it("Review/Validation/Done 显示跨-repo 总计数（rawColumnTaskCounts）", () => {
		const host = render(<CrossRepositoryStageFirstOverview projects={PROJECTS} onOpenTask={vi.fn()} />);
		// Review 总计 = 2 + 1 = 3
		expect(buttonWithText(host, "Review3")).toBeTruthy();
		// Validation 总计 = 1 + 0 = 1
		expect(buttonWithText(host, "Validation1")).toBeTruthy();
		// Done(=trash) 总计 = 3 + 5 = 8
		expect(buttonWithText(host, "Done8")).toBeTruthy();
	});

	it("点击 in-progress task 冒泡 (repoId, taskId)", () => {
		const onOpenTask = vi.fn();
		const host = render(<CrossRepositoryStageFirstOverview projects={PROJECTS} onOpenTask={onOpenTask} />);
		const row = buttonWithText(host, "alpha-active");
		act(() => {
			row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onOpenTask).toHaveBeenCalledWith("alpha", "alpha-active");
	});

	it("无活跃 task 时 Active 区显示空态", () => {
		const idleProjects = [project({ id: "solo", rawColumnTaskCounts: counts({ review: 4 }) })];
		const host = render(<CrossRepositoryStageFirstOverview projects={idleProjects} onOpenTask={vi.fn()} />);
		expect(host.textContent).toContain("No agents are actively working right now.");
		expect(buttonWithText(host, "Review4")).toBeTruthy();
	});
});
