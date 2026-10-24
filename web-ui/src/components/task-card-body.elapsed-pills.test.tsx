import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskConversationSessionActivityObservation, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";

// 卡片头部时长药丸的字段 → 渲染字符串端到端契约。这条链路此前**零测试**，而它正是这个 bug 反复
// 复发四次的地方：一颗药丸冒充了三个不同的量。现在拆成两颗，各读各的真相源，故这里逐条钉死
// 「哪个字段驱动哪颗药丸、无值时隐藏、低置信时降级」。
//
// 断言走 data-* 锚点而非文本包含：卡片头部同时渲染 Clock（自创建至今），三段读数混在一起做
// textContent 断言极易互相掩盖（"2h" 也是 "12h" 的子串）。

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
	useTaskWorkspaceInfoValue: () => null,
}));

const NOW = Date.now();
const TWO_HOURS_MS = 2 * 60 * 60_000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60_000;

function createCard(overrides: Partial<BoardCardModel> = {}) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		// 创建至今固定 1 分钟 ⇒ Clock 段恒为 "1m"，不会与下面两颗的读数撞车。
		createdAt: NOW - 60_000,
		updatedAt: NOW,
		...overrides,
	};
}

function createSummary(overrides?: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 7,
		startedAt: NOW - THREE_DAYS_MS,
		updatedAt: NOW,
		// 这两个「此刻在不在吐东西」的量刻意都设成「刚刚」：任何一颗药丸读了它们，
		// 下面的 "now" 断言就会立刻暴露出来。
		lastOutputAt: NOW,
		lastSubstantiveOutputAt: NOW,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: NOW,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function renderCard(
	sessionSummary?: RuntimeTaskSessionSummary,
	taskConversationSessionActivityObservations?: RuntimeTaskConversationSessionActivityObservation[],
): HTMLDivElement {
	act(() =>
		root.render(
			<BoardCard
				card={createCard()}
				index={0}
				columnId="review"
				sessionSummary={sessionSummary}
				taskConversationSessionActivityObservations={taskConversationSessionActivityObservations}
			/>,
		),
	);
	return container;
}

function stoppedPill(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>("[data-agent-response-generation-stopped-pill]");
}

function progressPill(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>("[data-last-conversation-progress-pill]");
}

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("卡片创建时间药丸", () => {
	const createdAt = NOW - THREE_DAYS_MS;
	const creationTimeTooltip = `创建于 · ${new Date(createdAt).toLocaleString()}`;

	function renderCreationTimeCard(columnId: BoardColumnId, sessionSummary?: RuntimeTaskSessionSummary) {
		act(() =>
			root.render(
				<BoardCard
					card={createCard({ createdAt, updatedAt: NOW, taskDescriptionLastUpdatedAt: NOW - TWO_HOURS_MS })}
					index={0}
					columnId={columnId}
					sessionSummary={sessionSummary}
				/>,
			),
		);
		return container.querySelector<HTMLElement>("[data-task-created-at-pill]");
	}

	it.each<BoardColumnId>(["backlog", "in_progress", "review", "validation", "trash"])(
		"%s 列无会话时仍显示原始创建时间，与任务及 Description 更新时间区分",
		(columnId) => {
			const creationTimePill = renderCreationTimeCard(columnId);
			expect(creationTimePill?.textContent).toBe("3d");
			expect(creationTimePill?.title).toBe(creationTimeTooltip);
			expect(creationTimePill?.querySelector(".lucide-clock")).not.toBeNull();
		},
	);

	it("切换任务状态和重启会话不会把创建时间刷新为会话时间", () => {
		const summaries = [
			undefined,
			createSummary({
				state: "running",
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				startedAt: NOW,
			}),
			createSummary({ startedAt: NOW, lastConversationProgressObservation: null }),
		];
		for (const summary of summaries) {
			const creationTimePill = renderCreationTimeCard(
				summary?.turnOwner === "agent" ? "in_progress" : "review",
				summary,
			);
			expect(creationTimePill?.textContent).toBe("3d");
			expect(creationTimePill?.title).toBe(creationTimeTooltip);
		}
	});
});

describe("卡片头部时长药丸", () => {
	it("主活动未知时仍可聚焦查看 peer、By the way 和前主的独立来源", () => {
		const activity = {
			observedAtMs: NOW - TWO_HOURS_MS,
			evidenceKind: "persisted_agent_transcript",
			activityKind: "tool_activity",
		} as const;
		const host = renderCard(createSummary({ lastConversationProgressObservation: null }), [
			{
				sessionId: "main",
				role: "main",
				agentId: "claude",
				lastEffectiveAgentConversationActivityObservation: null,
			},
			{
				sessionId: "peer",
				role: "task_collaborator",
				agentId: "codex",
				lastEffectiveAgentConversationActivityObservation: activity,
			},
			{
				sessionId: "side",
				role: "by_the_way",
				agentId: "claude",
				lastEffectiveAgentConversationActivityObservation: null,
			},
			{
				sessionId: "previous",
				role: "former_main",
				agentId: "claude",
				lastEffectiveAgentConversationActivityObservation: activity,
			},
		]);
		const trigger = host.querySelector<HTMLElement>("[data-task-conversation-session-activity-details]");
		expect(trigger?.tabIndex).toBe(0);
		expect(trigger?.textContent).toContain("活动未知");
		expect(trigger?.title).toContain("协作会话（peer）");
		expect(trigger?.title).toContain("侧问会话（By the way）");
		expect(trigger?.title).toContain("前主对话");
		expect(trigger?.title).toContain("工具活动 · 证据：persisted_agent_transcript");
		expect(progressPill(host)).toBeNull();
	});

	it("提交尚未获得原生接受证明时明确显示待确认", () => {
		const host = renderCard(
			createSummary({
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs: NOW,
					runtimeSessionIncarnationId: "current-process",
				},
			}),
		);
		expect(host.querySelector('[role="status"]')?.textContent).toContain("提交待确认");
	});

	it("恢复后药丸读取历史交棒与统一活动，进程待命起点不能刷新它们", () => {
		const host = renderCard(
			createSummary({
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					signalConfidence: "harness_turn_complete",
					turnSequence: 1,
				},
				lastEffectiveAgentConversationActivityObservation: {
					observedAtMs: NOW - THREE_DAYS_MS,
					evidenceKind: "persisted_agent_transcript",
					activityKind: "agent_output",
				},
				agentResponseGenerationStopped: {
					stoppedAt: NOW,
					signalConfidence: "harness_turn_complete",
					turnSequence: 2,
				},
				lastConversationProgressObservation: null,
			}),
		);
		expect(stoppedPill(host)?.textContent).toBe("2h");
		expect(progressPill(host)?.textContent).toBe("3d");
		expect(host.querySelector("[data-task-created-at-pill]")?.textContent).toBe("1m");
	});

	it("两颗药丸各读各的字段：Stopped 读停止事件、Progress 读推进观测", () => {
		const host = renderCard(
			createSummary({
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					signalConfidence: "harness_turn_complete",
					turnSequence: 1,
				},
				lastConversationProgressObservation: {
					observedAtMs: NOW - THREE_DAYS_MS,
					evidenceKind: "persisted_agent_transcript",
				},
			}),
		);

		expect(stoppedPill(host)?.textContent).toContain("2h");
		expect(progressPill(host)?.textContent).toContain("3d");
	});

	// 根因回归，也是整套改动要守的那一条：会话被重开时 lastSubstantiveOutputAt 会被重播刷成「刚刚」，
	// 但两颗药丸都不读它。上面的 createSummary 已经把它和 lastOutputAt 都设成 NOW——若哪天有人把
	// 药丸改回去读实质戳，这两条断言会立刻红。
	it("实质戳被刷成「刚刚」也绝不影响两颗药丸（它们不读那个量）", () => {
		const host = renderCard(
			createSummary({
				lastOutputAt: NOW,
				lastSubstantiveOutputAt: NOW,
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					signalConfidence: "harness_turn_complete",
					turnSequence: 1,
				},
				lastConversationProgressObservation: {
					observedAtMs: NOW - THREE_DAYS_MS,
					evidenceKind: "persisted_agent_transcript",
				},
			}),
		);

		expect(stoppedPill(host)?.textContent).not.toContain("now");
		expect(progressPill(host)?.textContent).not.toContain("now");
	});

	it("TUI 刮取分类器不再构成可信活动，保留可访问的未知入口", () => {
		const host = renderCard(
			createSummary({
				lastConversationProgressObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					evidenceKind: "terminal_output_heuristic_classification",
				},
			}),
		);

		expect(progressPill(host)).toBeNull();
		expect(host.querySelector("[data-task-conversation-session-activity-details]")?.textContent).toContain(
			"活动未知",
		);
	});

	it.each([
		["persisted_agent_transcript"],
		["agent_lifecycle_hook_event"],
		["structured_agent_session_event"],
	] as const)("高置信来源 %s 不加 `~`", (evidenceKind) => {
		const host = renderCard(
			createSummary({
				lastConversationProgressObservation: { observedAtMs: NOW - TWO_HOURS_MS, evidenceKind },
			}),
		);

		expect(progressPill(host)?.textContent).toContain("2h");
		expect(progressPill(host)?.textContent).not.toContain("~");
	});

	// agent 回合 / park 期间「本轮停了多久」为 null：此刻由 computing 脉动 / parked 徽标表达状态，
	// 再显示一个时长只会让人误读成会话闲置。
	it("停止事件为 null ⇒ Stopped 药丸隐藏（agent 回合 / park 期间）", () => {
		const host = renderCard(
			createSummary({
				state: "running",
				reviewReason: null,
				lastAgentConversationUserHandoffObservation: null,
				lastConversationProgressObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					evidenceKind: "persisted_agent_transcript",
				},
			}),
		);

		expect(stoppedPill(host)).toBeNull();
		expect(progressPill(host)).not.toBeNull();
	});

	it("推进观测为 null ⇒ Progress 药丸隐藏，且绝不回退去读实质戳", () => {
		const host = renderCard(
			createSummary({
				lastSubstantiveOutputAt: NOW - TWO_HOURS_MS,
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					signalConfidence: "harness_turn_complete",
					turnSequence: 1,
				},
				lastConversationProgressObservation: null,
			}),
		);

		expect(progressPill(host)).toBeNull();
		expect(stoppedPill(host)).not.toBeNull();
	});

	it("两个字段都缺（旧盘数据 / 无会话）⇒ 两颗药丸都隐藏，卡片照常渲染", () => {
		const host = renderCard(undefined);

		expect(stoppedPill(host)).toBeNull();
		expect(progressPill(host)).toBeNull();
		expect(host.textContent).toContain("Review API changes");
	});
});

describe("Backlog 卡片的 Description 最后更新药丸", () => {
	function descriptionLastUpdatedPill(host: HTMLElement): HTMLElement | null {
		return host.querySelector<HTMLElement>("[data-backlog-task-description-last-updated-pill]");
	}

	function renderBacklogCard(
		cardOverrides: Partial<ReturnType<typeof createCard>> & {
			taskDescriptionLastUpdatedAt?: number;
		},
	): HTMLDivElement {
		act(() => root.render(<BoardCard card={{ ...createCard(), ...cardOverrides }} index={0} columnId="backlog" />));
		return container;
	}

	it("backlog 卡读 taskDescriptionLastUpdatedAt，而非创建时间或 updatedAt", () => {
		const host = renderBacklogCard({
			createdAt: NOW - THREE_DAYS_MS,
			updatedAt: NOW,
			taskDescriptionLastUpdatedAt: NOW - TWO_HOURS_MS,
		});
		expect(descriptionLastUpdatedPill(host)?.textContent).toContain("2h");
	});

	it("老卡片缺该字段 ⇒ 回落到 updatedAt", () => {
		const host = renderBacklogCard({ createdAt: NOW - THREE_DAYS_MS, updatedAt: NOW - TWO_HOURS_MS });
		expect(descriptionLastUpdatedPill(host)?.textContent).toContain("2h");
	});

	it("非 backlog 列不渲染该药丸", () => {
		const host = renderCard();
		expect(descriptionLastUpdatedPill(host)).toBeNull();
	});
});
