import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskSpotlightSearchResultRow } from "@/components/task-spotlight-search-result-row";
import { buildTaskBoardSearchDocument, type TaskBoardSearchResult } from "@/search/task-board-search";

function createResult(overrides: {
	taskId?: string;
	title?: string;
	prompt?: string;
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

	function renderRow(result: TaskBoardSearchResult): void {
		act(() => {
			root.render(
				<TaskSpotlightSearchResultRow
					result={result}
					isActive={false}
					isCrossProject={false}
					shouldUseMobileMinimumTouchTarget={false}
					onSelect={() => {}}
					onHover={() => {}}
				/>,
			);
		});
	}

	it("renders a monospaced task id badge on a task-id matched row", () => {
		renderRow(createResult({ matchSources: ["taskId"] }));

		const taskIdBadge = [...container.querySelectorAll("span")].find(
			(element) => element.className.includes("font-mono") && element.textContent === "a3f21",
		);
		expect(taskIdBadge).toBeTruthy();
	});

	it("does not render the task id badge on a plain text match (row layout unchanged)", () => {
		renderRow(createResult({ matchSources: ["title"], titleMatchCharacterPositions: new Set([0]) }));

		expect(container.textContent).not.toContain("a3f21");
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
