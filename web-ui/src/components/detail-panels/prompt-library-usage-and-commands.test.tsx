import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyPromptLibraryInvalidated } from "@/runtime/prompt-library-invalidation-events";
import type { StoredPromptLibraryEntry, WorkspacePromptLibrarySnapshot } from "@/runtime/types";

const server = vi.hoisted(() => ({
	library: {
		globalScopedPrompts: [],
		repoScopedPrompts: [],
		taskScopedPromptsByTaskId: {},
	} as WorkspacePromptLibrarySnapshot,
	mutations: vi.fn(),
}));
vi.mock("@/runtime/prompt-library-query", () => ({
	EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT: {
		globalScopedPrompts: [],
		repoScopedPrompts: [],
		taskScopedPromptsByTaskId: {},
	},
	fetchWorkspacePromptLibrary: async () => server.library,
	mutateWorkspacePromptLibrary: async (...args: unknown[]) => {
		server.mutations(...args);
		return server.library;
	},
}));

import { PromptLibraryPanel } from "@/components/detail-panels/prompt-library-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

let root: Root;
let container: HTMLDivElement;
function entry(id: string, updatedAt: number, extra: Partial<StoredPromptLibraryEntry> = {}): StoredPromptLibraryEntry {
	return { id, text: id, scope: "global", createdAt: 1, updatedAt, ...extra };
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	server.mutations.mockClear();
	server.library = {
		globalScopedPrompts: [
			entry("已用", 500, { draftUsage: { markedUsedAtEpochMs: 600 } }),
			entry("较早", 10),
			entry("较新", 20),
			entry("命令", 100, { entryKind: "reusable_command" }),
		],
		repoScopedPrompts: [],
		taskScopedPromptsByTaskId: {},
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("草稿分组与 Commands", () => {
	it("未使用按编辑倒序，已使用放最后；Command 仅出现在自己的 Tab", async () => {
		await act(async () =>
			root.render(
				createElement(
					TooltipProvider,
					null,
					createElement(PromptLibraryPanel, { taskId: "task", projectId: "workspace", onFillInput: () => {} }),
				),
			),
		);
		expect([...container.querySelectorAll("textarea")].map((element) => element.value)).toEqual([
			"较新",
			"较早",
			"已用",
		]);
		expect(container.querySelector("h3")?.textContent).toBe("已使用");
		await act(async () =>
			root.render(
				createElement(
					TooltipProvider,
					null,
					createElement(PromptLibraryPanel, {
						taskId: "task",
						projectId: "workspace",
						entryKind: "reusable_command",
						onFillInput: () => {},
					}),
				),
			),
		);
		expect([...container.querySelectorAll("textarea")].map((element) => element.value)).toEqual(["命令"]);
		expect(container.querySelector('[aria-label="标记已使用"]')).toBeNull();
	});
	it("转存操作明确选择范围，并消费其他项目发来的全局失效通知", async () => {
		await act(async () =>
			root.render(
				createElement(
					TooltipProvider,
					null,
					createElement(PromptLibraryPanel, { taskId: "task", projectId: "workspace", onFillInput: () => {} }),
				),
			),
		);
		await act(async () => (container.querySelector('[aria-label="转为 Command"]') as HTMLButtonElement).click());
		await act(async () =>
			[...container.querySelectorAll("button")].find((button) => button.textContent === "当前 Project")?.click(),
		);
		expect(server.mutations).toHaveBeenCalledWith("workspace", {
			kind: "convert_prompt_to_reusable_command",
			promptId: "较新",
			scope: "repo",
		});
		server.library = { ...server.library, globalScopedPrompts: [entry("新全局内容", 1000)] };
		await act(async () => notifyPromptLibraryInvalidated(null));
		expect(container.querySelector("textarea")?.value).toBe("新全局内容");
	});
});
