import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

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
}));

const NOW = Date.now();
const TWO_HOURS_MS = 2 * 60 * 60_000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60_000;

function createCard() {
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

function renderCard(sessionSummary?: RuntimeTaskSessionSummary): HTMLDivElement {
	act(() =>
		root.render(<BoardCard card={createCard()} index={0} columnId="review" sessionSummary={sessionSummary} />),
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

describe("卡片头部时长药丸", () => {
	it("两颗药丸各读各的字段：Stopped 读停止事件、Progress 读推进观测", () => {
		const host = renderCard(
			createSummary({
				agentResponseGenerationStopped: {
					stoppedAt: NOW - TWO_HOURS_MS,
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
				agentResponseGenerationStopped: {
					stoppedAt: NOW - TWO_HOURS_MS,
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

	it("低置信来源（TUI 刮取分类器）以 `~` 前缀降级展示", () => {
		const host = renderCard(
			createSummary({
				lastConversationProgressObservation: {
					observedAtMs: NOW - TWO_HOURS_MS,
					evidenceKind: "terminal_output_heuristic_classification",
				},
			}),
		);

		expect(progressPill(host)?.textContent).toContain("~2h");
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
				agentResponseGenerationStopped: null,
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
				agentResponseGenerationStopped: {
					stoppedAt: NOW - TWO_HOURS_MS,
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
