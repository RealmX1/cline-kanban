import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { StoredPromptLibraryEntry, TerminalInputBoxStashFidelity } from "@/runtime/types";

// 孤儿回收区的条目不复用 `PromptRow`，所以「来源可辨识」与「保真度常驻告警」这两项呈现契约在这个
// 入口最容易被静默绕过——而它恰恰是最需要这两项的入口：抢占来源的条目本就是用户不在场时被运行时
// 写进来的，落进回收区后仍然可以一键 Fill 进 agent。
//
// 这里把 `use-prompt-library` 整体换成假控制器：本文件断言的是**面板怎么呈现一条孤儿条目**，
// 与库怎么判定谁是孤儿无关。
const orphanedPromptsExposedByFakePromptLibraryController: StoredPromptLibraryEntry[] = [];

vi.mock("@/hooks/use-prompt-library", () => ({
	usePromptLibrary: () => ({
		prompts: [],
		orphanedPrompts: orphanedPromptsExposedByFakePromptLibraryController,
		addPrompt: () => "prompt-created-by-fake-controller",
		updatePromptText: () => {},
		removePrompt: () => {},
		setPromptScope: () => {},
		claimOrphanedPrompt: () => {},
	}),
}));

const { PromptLibraryPanel } = await import("@/components/detail-panels/prompt-library-panel");

function buildTerminalInputBoxStashFidelity(
	overrides: Partial<TerminalInputBoxStashFidelity>,
): TerminalInputBoxStashFidelity {
	return {
		softWrapJoinCount: 0,
		foldedPastePlaceholderCount: 0,
		backfilledPlaceholderCount: 0,
		placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
		placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
		placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
		unrecoverablePasteCount: 0,
		...overrides,
	};
}

function renderPanel(root: Root, panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

function expandOrphanedSection(container: HTMLElement): void {
	const toggle = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes("from deleted tasks"),
	);
	expect(toggle).toBeInstanceOf(HTMLButtonElement);
	if (!(toggle instanceof HTMLButtonElement)) {
		throw new Error("Expected the orphaned prompts section toggle.");
	}
	toggle.click();
}

describe("PromptLibraryPanel orphaned prompts section", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		orphanedPromptsExposedByFakePromptLibraryController.length = 0;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
		container.remove();
		orphanedPromptsExposedByFakePromptLibraryController.length = 0;
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("marks an auto-stashed orphaned entry with its origin and its unrecovered paste count", async () => {
		orphanedPromptsExposedByFakePromptLibraryController.push({
			id: "orphaned-prompt-1",
			text: "review the failing spec",
			scope: "task",
			origin: "terminal_stash_preempted_by_programmatic_delivery",
			terminalInputBoxStashFidelity: buildTerminalInputBoxStashFidelity({
				foldedPastePlaceholderCount: 3,
				backfilledPlaceholderCount: 1,
				placeholdersLeftUnbackfilledBecausePayloadWasDropped: 1,
				placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 1,
				// 输入侧账本的这一项与上面三项会重叠，加进去就是虚报——告警必须仍然只报 2 处。
				unrecoverablePasteCount: 5,
			}),
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
		});

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});
		await act(async () => {
			expandOrphanedSection(container);
		});

		expect(container.textContent).toContain("Auto-stashed");
		expect(container.textContent).toContain("2 pasted sections could not be restored");
		expect(container.textContent).not.toContain("7 pasted sections");
		// 回收区仍然提供 Fill：警告存在的意义就是让用户在按下它之前知道这份正文缺了什么。
		expect(container.querySelector('button[aria-label="Fill orphaned prompt into input"]')).toBeInstanceOf(
			HTMLButtonElement,
		);
	});

	it("leaves a hand-written orphaned entry free of both the origin badge and the fidelity warning", async () => {
		orphanedPromptsExposedByFakePromptLibraryController.push({
			id: "orphaned-prompt-2",
			text: "my own template",
			scope: "task",
			origin: "manual",
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
		});

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});
		await act(async () => {
			expandOrphanedSection(container);
		});

		expect(container.textContent).toContain("my own template");
		expect(container.textContent).not.toContain("Auto-stashed");
		expect(container.textContent).not.toContain("Stashed");
		expect(container.textContent).not.toContain("could not be restored");
	});
});
