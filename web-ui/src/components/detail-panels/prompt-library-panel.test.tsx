import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	StoredPromptLibraryEntry,
	WorkspacePromptLibraryMutation,
	WorkspacePromptLibrarySnapshot,
} from "@/runtime/types";

// Prompt Library 的真相源在服务端，面板经 tRPC 读它。这里放一个假服务端：既让「长条目折叠」这类
// 渲染断言拿到数据，也避免 jsdom 里真发请求。
const EMPTY_SNAPSHOT: WorkspacePromptLibrarySnapshot = {
	globalScopedPrompts: [],
	repoScopedPrompts: [],
	taskScopedPromptsByTaskId: {},
};
const promptsHeldByFakeServerByTaskId: Record<string, StoredPromptLibraryEntry[]> = {};

vi.mock("@/runtime/prompt-library-query", () => ({
	EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT: EMPTY_SNAPSHOT,
	fetchWorkspacePromptLibrary: async () => ({
		...EMPTY_SNAPSHOT,
		taskScopedPromptsByTaskId: { ...promptsHeldByFakeServerByTaskId },
	}),
	// 假服务端要真的把意图应用上去：ack 回一份「没有刚新增那条」的快照会把乐观插入抹掉，
	// 于是「新增后自动聚焦」看起来像坏了——那是假服务端在撒谎，不是面板有问题。
	mutateWorkspacePromptLibrary: async (_workspaceId: string, mutation: WorkspacePromptLibraryMutation) => {
		if (mutation.kind === "upsert_prompt" && mutation.taskId) {
			const existingPrompts = promptsHeldByFakeServerByTaskId[mutation.taskId] ?? [];
			promptsHeldByFakeServerByTaskId[mutation.taskId] = [
				...existingPrompts.filter((prompt) => prompt.id !== mutation.promptId),
				{
					id: mutation.promptId,
					text: mutation.text,
					scope: "task",
					createdAt: 0,
					updatedAt: 0,
				},
			];
		}
		if (mutation.kind === "remove_prompt") {
			for (const [taskId, prompts] of Object.entries(promptsHeldByFakeServerByTaskId)) {
				promptsHeldByFakeServerByTaskId[taskId] = prompts.filter((prompt) => prompt.id !== mutation.promptId);
			}
		}
		return { ...EMPTY_SNAPSHOT, taskScopedPromptsByTaskId: { ...promptsHeldByFakeServerByTaskId } };
	},
}));

const { PromptLibraryPanel } = await import("@/components/detail-panels/prompt-library-panel");

function renderPanel(root: Root, panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
	);
	expect(button).toBeInstanceOf(HTMLButtonElement);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected ${label} button.`);
	}
	return button;
}

describe("PromptLibraryPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollHeightSpy: ReturnType<typeof vi.spyOn> | null;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		for (const taskId of Object.keys(promptsHeldByFakeServerByTaskId)) {
			delete promptsHeldByFakeServerByTaskId[taskId];
		}
		scrollHeightSpy = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		scrollHeightSpy?.mockRestore();
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
		container.remove();
		window.localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("focuses a newly added prompt entry", async () => {
		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		await act(async () => {
			getButton(container, "Add").click();
		});

		const promptTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
		expect(promptTextarea).toBeInstanceOf(HTMLTextAreaElement);
		expect(document.activeElement).toBe(promptTextarea);
	});

	it("collapses long unfocused prompt entries without enabling textarea scrolling", async () => {
		const longPromptText = ["one", "two", "three", "four", "five", "six"].join("\n");
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{ id: "prompt-1", text: longPromptText, scope: "task", createdAt: 100, updatedAt: 100 },
		];
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		const promptTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
		expect(promptTextarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(promptTextarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected prompt textarea.");
		}
		expect(promptTextarea.style.overflowY).toBe("hidden");
		expect(promptTextarea.style.height).not.toBe("220px");
		expect(container.querySelector('button[aria-label="Show full prompt"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("keeps the prompt expand control mounted when the control receives focus", async () => {
		const longPromptText = ["one", "two", "three", "four", "five", "six"].join("\n");
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{ id: "prompt-1", text: longPromptText, scope: "task", createdAt: 100, updatedAt: 100 },
		];
		scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(220);

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		const expandButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show full prompt"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected prompt expand button.");
		}

		await act(async () => {
			expandButton.focus();
		});

		expect(container.querySelector('button[aria-label="Show full prompt"]')).toBeInstanceOf(HTMLButtonElement);
	});
});
