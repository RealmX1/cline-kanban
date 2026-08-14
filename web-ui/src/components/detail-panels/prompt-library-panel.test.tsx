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
		// 认领一条孤儿条目走的就是 set_prompt_scope（搬桶正是它的语义）。假服务端不实现它的话，
		// 「点了 Claim 之后那条真的搬过来了吗」这个断言测的就只是按钮有没有被点到。
		if (mutation.kind === "set_prompt_scope" && mutation.scope === "task" && mutation.taskId) {
			let movedPrompt: StoredPromptLibraryEntry | undefined;
			for (const [taskId, prompts] of Object.entries(promptsHeldByFakeServerByTaskId)) {
				const found = prompts.find((prompt) => prompt.id === mutation.promptId);
				if (found) {
					movedPrompt = found;
					promptsHeldByFakeServerByTaskId[taskId] = prompts.filter((prompt) => prompt.id !== mutation.promptId);
				}
			}
			if (movedPrompt) {
				promptsHeldByFakeServerByTaskId[mutation.taskId] = [
					...(promptsHeldByFakeServerByTaskId[mutation.taskId] ?? []),
					movedPrompt,
				];
			}
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

	// §六·4/5：来源与保真度已经落库很久了，面板一个都没读——徽标、来源说明、「有几段还原不了」全没有。
	it("抢占来源的条目打上来源徽标：它是用户不在场时由运行时替他写进来的，事后必须认得出", async () => {
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{
				id: "p-preempted",
				text: "被抢占时暂存下来的半句",
				scope: "task",
				origin: "terminal_stash_preempted_by_programmatic_delivery",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		];

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		expect(container.textContent).toContain("Auto-stashed");
	});

	it("手写条目不打来源徽标——给每一条都挂一个等于给整列表加一列永远为真的噪音", async () => {
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{ id: "p-manual", text: "自己写的模板", scope: "task", origin: "manual", createdAt: 1_000, updatedAt: 1_000 },
		];

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		expect(container.textContent).not.toContain("Auto-stashed");
		expect(container.textContent).not.toContain("Stashed");
	});

	it("有还原不了的折叠粘贴时常驻警告：第二天翻面板也要看得见，不能只在暂存那一刻弹一次 toast", async () => {
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{
				id: "p-lossy",
				text: "正文 [Pasted text #5 +11 lines] 还有 [Pasted text #6 +14 lines]",
				scope: "task",
				origin: "terminal_stash_preempted_by_programmatic_delivery",
				terminalInputBoxStashFidelity: {
					softWrapJoinCount: 3,
					foldedPastePlaceholderCount: 2,
					backfilledPlaceholderCount: 0,
					placeholdersLeftUnbackfilledBecausePayloadWasDropped: 1,
					placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 1,
					placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
					unrecoverablePasteCount: 1,
				},
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		];

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		// 两处不可还原，且**不**把输入侧账本的 unrecoverablePasteCount 也加进来（会重叠，相加就是虚报）。
		expect(container.textContent).toContain("2 pasted sections could not be restored");
	});

	it("没有保真度字段的条目不显示任何保真度标记——缺字段 ≠ 保真，不该凭空给出「0 处丢失」的保证", async () => {
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{ id: "p-legacy", text: "升级前存的条目", scope: "task", createdAt: 1_000, updatedAt: 1_000 },
		];

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		expect(container.textContent).not.toContain("could not be restored");
	});

	// §六·3：prompt 刻意**不**随任务删除而毁（它是用户资产，与草稿相反）。代价是任务没了之后，
	// 它名下的条目对任何任务视角都不再可见——不给回收入口的话，「不随任务删除而毁」保住的只是磁盘字节。
	it("归属任务已不在看板上的条目进孤儿回收区，并可认领到当前任务", async () => {
		promptsHeldByFakeServerByTaskId["task-1"] = [
			{ id: "p-live", text: "当前任务的模板", scope: "task", createdAt: 1_000, updatedAt: 1_000 },
		];
		promptsHeldByFakeServerByTaskId["task-deleted"] = [
			{ id: "p-orphan", text: "给一个已删任务写过的模板", scope: "task", createdAt: 1_000, updatedAt: 1_000 },
		];

		await act(async () => {
			renderPanel(
				root,
				<PromptLibraryPanel
					taskId="task-1"
					projectId="project-1"
					onFillInput={() => {}}
					taskIdsOnBoard={new Set(["task-1"])}
				/>,
			);
		});

		expect(container.textContent).toContain("1 prompt from deleted tasks");
		await act(async () => {
			getButton(container, "1 prompt from deleted tasks").click();
		});
		await act(async () => {
			getButton(container, "Claim").click();
		});

		// 认领 = 搬到当前任务的桶里，随即出现在正常列表中、不再是孤儿。
		expect(promptsHeldByFakeServerByTaskId["task-1"]?.map((prompt) => prompt.id)).toContain("p-orphan");
		expect(promptsHeldByFakeServerByTaskId["task-deleted"] ?? []).toHaveLength(0);
	});

	// 「还不知道看板上有哪些任务」与「这些任务都不存在」是两件事。把前者当后者，会让整个库在首屏
	// 加载完成前的一瞬间全部变成孤儿。
	it("还不知道看板内容时一条都不标成孤儿", async () => {
		promptsHeldByFakeServerByTaskId["task-deleted"] = [
			{ id: "p-orphan", text: "给一个已删任务写过的模板", scope: "task", createdAt: 1_000, updatedAt: 1_000 },
		];

		await act(async () => {
			renderPanel(root, <PromptLibraryPanel taskId="task-1" projectId="project-1" onFillInput={() => {}} />);
		});

		expect(container.textContent).not.toContain("from deleted tasks");
	});
});
