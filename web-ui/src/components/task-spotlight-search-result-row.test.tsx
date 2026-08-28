import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskSpotlightSearchResultRow } from "@/components/task-spotlight-search-result-row";
import { DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY } from "@/components/task-spotlight-search-result-row-field-visibility";
import type { RuntimeAgentId } from "@/runtime/types";
import { buildTaskBoardSearchDocument, type TaskBoardSearchResult } from "@/search/task-board-search";

function createResult(overrides: {
	taskId?: string;
	title?: string;
	prompt?: string;
	taskCreatedAtEpochMs?: number;
	taskLastModifiedAtEpochMs?: number;
	taskAgentOverrideAgentId?: RuntimeAgentId | null;
	mostRecentlyLaunchedAgentSessionAgentId?: RuntimeAgentId | null;
	matchSources?: TaskBoardSearchResult["matchSources"];
	titleMatchCharacterPositions?: ReadonlySet<number>;
}): TaskBoardSearchResult {
	return {
		document: buildTaskBoardSearchDocument({
			projectId: "proj-a",
			projectName: "Project A",
			taskId: overrides.taskId ?? "a3f21",
			columnId: "backlog",
			title: overrides.title ?? "Alpha rollout",
			prompt: overrides.prompt ?? "Prepare API deployment",
			taskCreatedAtEpochMs: overrides.taskCreatedAtEpochMs ?? 0,
			taskLastModifiedAtEpochMs: overrides.taskLastModifiedAtEpochMs ?? 0,
			taskAgentOverrideAgentId: overrides.taskAgentOverrideAgentId ?? null,
			mostRecentlyLaunchedAgentSessionAgentId: overrides.mostRecentlyLaunchedAgentSessionAgentId ?? null,
		}),
		score: 0,
		matchSources: overrides.matchSources ?? ["title"],
		titleMatchCharacterPositions: overrides.titleMatchCharacterPositions ?? new Set<number>(),
		promptMatchCharacterPositions: new Set<number>(),
	};
}

describe("TaskSpotlightSearchResultRow", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function renderRow(
		result: TaskBoardSearchResult,
		rowOverrides: Partial<React.ComponentProps<typeof TaskSpotlightSearchResultRow>> = {},
	): void {
		act(() => {
			root.render(
				<TaskSpotlightSearchResultRow
					result={result}
					isActive={false}
					isCrossProject={false}
					fieldVisibility={DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY}
					effectiveAgentId={null}
					agentLabel={null}
					sessionActivity={null}
					timePillKind="last_modified"
					agentConversationProgressAtEpochMs={null}
					nowEpochMs={0}
					shouldUseMobileMinimumTouchTarget={false}
					onSelect={() => {}}
					onHover={() => {}}
					{...rowOverrides}
				/>,
			);
		});
	}

	function queryTaskIdBadge(): HTMLElement | undefined {
		return [...container.querySelectorAll("span")].find(
			(element) => element.className.includes("font-mono") && element.textContent === "a3f21",
		);
	}

	it("highlights the task id badge in gold when the row was matched by its id", () => {
		renderRow(createResult({ matchSources: ["taskId"] }));

		// 靠 id 命中的那条通常在 title / prompt 上没有任何高亮，不上金色就看不出它凭什么被顶到最前。
		expect(queryTaskIdBadge()?.style.color).toBe("var(--color-status-gold)");
	});

	it("still renders the task id badge on a plain text match, but muted", () => {
		renderRow(createResult({ matchSources: ["title"], titleMatchCharacterPositions: new Set([0]) }));

		const taskIdBadge = queryTaskIdBadge();
		expect(taskIdBadge).toBeTruthy();
		expect(taskIdBadge?.style.color).toBe("");
		expect(taskIdBadge?.className).toContain("text-text-tertiary");
	});

	it("caps the always-on task id badge so a long custom id cannot squeeze out the title", () => {
		// taskId 在创建路径上允许经 explicitTaskId 传入任意长度；徽标所在容器是 shrink-0，不封顶就会
		// 把同一行 flex-1 的主文本压到接近零宽。
		renderRow(createResult({ taskId: "an-extremely-long-custom-task-identifier" }));

		const taskIdBadge = [...container.querySelectorAll("span")].find(
			(element) => element.className.includes("font-mono") && element.textContent?.startsWith("an-extremely"),
		);
		expect(taskIdBadge?.className).toContain("truncate");
		expect(taskIdBadge?.className).toMatch(/max-w-\[\d+px\]/);
	});

	it("drops the task id badge once that field is switched off", () => {
		renderRow(createResult({ matchSources: ["taskId"] }), {
			fieldVisibility: {
				...DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY,
				task_id_badge: false,
			},
		});

		expect(queryTaskIdBadge()).toBeUndefined();
	});

	it("renders the agent icon and the session activity line when both are supplied", () => {
		renderRow(createResult({}), {
			effectiveAgentId: "claude",
			agentLabel: "Claude Code",
			sessionActivity: { dotColor: "var(--color-status-blue)", text: "Thinking..." },
		});

		expect(container.textContent).toContain("Thinking...");
		expect(container.querySelector('[title="Claude Code"]')).toBeTruthy();
	});

	it("hides the time pill when the chosen time has no value for this row", () => {
		// agent 活跃档下跨项目行没有「对话上次推进」时刻——宁可不显示，也不能拿别的时间戳冒充。
		renderRow(createResult({}), {
			timePillKind: "agent_conversation_progress",
			agentConversationProgressAtEpochMs: null,
		});

		expect(container.textContent).not.toContain("now");
	});

	it("renders the plain title without highlight spans when only the task id matched", () => {
		renderRow(createResult({ matchSources: ["taskId"] }));

		expect(container.textContent).toContain("Alpha rollout");
		// 无字符级位置集 → renderFuzzyHighlightedText 直接回吐纯文本，不产生高亮 span。
		const highlightedSpans = [...container.querySelectorAll("span")].filter(
			(element) => element.style.fontWeight === "600",
		);
		expect(highlightedSpans).toHaveLength(0);
	});

	it("falls back to a placeholder when both title and prompt are empty", () => {
		// 既有文本搜索永远匹配不到 title/prompt 皆空的任务，task id 搜索会——不兜底就是一条空行。
		renderRow(createResult({ matchSources: ["taskId"], title: "", prompt: "" }));

		expect(container.textContent).toContain("Untitled task");
	});
});
