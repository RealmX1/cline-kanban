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
		createdAt: 0,
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
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

// task 行按钮的文本已含时间元药丸（Clock/Activity），不再等于纯标题，故按稳定 testid 定位。
function taskRow(host: HTMLElement, taskId: string): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>(`[data-testid="overview-task-${taskId}"]`);
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
		expect(taskRow(host, "alpha-active")).toBeTruthy();
		// >5min 的 agent task 与 awaiting_review 的 user task 归 Stale（默认折叠 → 不在 DOM）
		expect(taskRow(host, "alpha-stale-old")).toBeFalsy();
		expect(taskRow(host, "beta-awaiting")).toBeFalsy();
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

	it("Review/Validation/Done 的 per-repo 分计数默认可见（无需展开）", () => {
		const host = render(<CrossRepositoryStageFirstOverview projects={PROJECTS} onOpenTask={vi.fn()} />);
		// 不点击展开，per-repo 行即在 DOM：Review 的 alpha=2 / beta=1（行按钮文本 = repo 名 + 分计数）。
		expect(buttonWithText(host, "alpha2")).toBeTruthy();
		expect(buttonWithText(host, "beta1")).toBeTruthy();
		// Validation 只有 alpha=1（beta=0 被过滤，不出行）。
		expect(buttonWithText(host, "alpha1")).toBeTruthy();
	});

	it("stage 从 0→N（概览挂载后计数实时到达）时 per-repo 行自动展开（受控 open，非仅 mount 生效）", () => {
		// 初始 Review 为空 → 该 stage 折叠，per-repo 行不在 DOM（Radix Collapsible 关闭时不挂载 Content）。
		const emptyReview = [project({ id: "solo", rawColumnTaskCounts: counts({ review: 0 }) })];
		const host = render(<CrossRepositoryStageFirstOverview projects={emptyReview} onOpenTask={vi.fn()} />);
		expect(buttonWithText(host, "solo3")).toBeFalsy();
		// 概览已挂载，projects 更新为 Review=3（同一 root 重渲染 → CountStageSection 组件实例保留）。
		const populatedReview = [project({ id: "solo", rawColumnTaskCounts: counts({ review: 3 }) })];
		act(() => root?.render(<CrossRepositoryStageFirstOverview projects={populatedReview} onOpenTask={vi.fn()} />));
		// hasTasks 由 false→true → useEffect setOpen(true) → per-repo 行（solo=3）自动可见，无需手动展开。
		expect(buttonWithText(host, "solo3")).toBeTruthy();
	});

	it("task 行显示时间元数据：自创建至今 + agent 上次实质响应至今", () => {
		const projects = [
			project({
				id: "solo",
				rawColumnTaskCounts: counts({ in_progress: 1 }),
				inProgressTaskDetails: [
					// createdAt 3min 前 → Clock "3m"；lastSubstantiveOutputAt 1s 前 → Activity "now"。
					detail({
						taskId: "t1",
						turnOwner: "agent",
						liveness: "live",
						createdAt: now - 3 * 60_000,
						lastOutputAt: now - FRESH,
						lastSubstantiveOutputAt: now - FRESH,
					}),
				],
			}),
		];
		const host = render(<CrossRepositoryStageFirstOverview projects={projects} onOpenTask={vi.fn()} />);
		const row = taskRow(host, "t1");
		expect(row).toBeTruthy();
		expect(row?.textContent).toContain("3m");
		expect(row?.textContent).toContain("now");
	});

	it("Activity 药丸读 lastSubstantiveOutputAt 而非 lastOutputAt（spinner 噪声不显示虚假『刚响应』）", () => {
		const projects = [
			project({
				id: "solo",
				rawColumnTaskCounts: counts({ in_progress: 1 }),
				inProgressTaskDetails: [
					// lastOutputAt 刚刷新（spinner 重绘）但无实质产出 → Active（分类读 lastOutputAt）、但 Activity 段隐藏。
					detail({
						taskId: "t-spinner",
						turnOwner: "agent",
						liveness: "live",
						createdAt: now - 3 * 60_000,
						lastOutputAt: now - FRESH,
						lastSubstantiveOutputAt: null,
					}),
				],
			}),
		];
		const host = render(<CrossRepositoryStageFirstOverview projects={projects} onOpenTask={vi.fn()} />);
		const row = taskRow(host, "t-spinner");
		expect(row).toBeTruthy();
		// Clock 恒显（createdAt 3min → "3m"）；lastSubstantiveOutputAt=null → 无 Activity 段 → 不出现 "now"。
		expect(row?.textContent).toContain("3m");
		expect(row?.textContent).not.toContain("now");
	});

	it("点击 in-progress task 冒泡 (repoId, taskId)", () => {
		const onOpenTask = vi.fn();
		const host = render(<CrossRepositoryStageFirstOverview projects={PROJECTS} onOpenTask={onOpenTask} />);
		const row = taskRow(host, "alpha-active");
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
