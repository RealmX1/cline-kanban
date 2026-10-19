import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IndependentTaskCreationDraft, IndependentTaskCreationDraftEdit } from "@/runtime/types";
import { useIndependentTaskCreation } from "./use-independent-task-creation";

const mocked = vi.hoisted(() => ({
	latest: vi.fn(),
	read: vi.fn(),
	save: vi.fn(),
	generate: vi.fn(),
	prepare: vi.fn(),
	create: vi.fn(),
}));
vi.mock("@/runtime/independent-task-creation-query", () => ({
	independentTaskCreationClient: () => ({
		latestDraft: { query: mocked.latest },
		read: { query: mocked.read },
		generate: { mutate: mocked.generate },
		prepare: { mutate: mocked.prepare },
		create: { mutate: mocked.create },
	}),
	saveIndependentTaskCreationDraft: (_workspace: string, input: IndependentTaskCreationDraftEdit) =>
		mocked.save(input),
}));

let persisted: IndependentTaskCreationDraft;
const mountedRoots: { root: Root; container: HTMLElement }[] = [];
function renderIndependentTaskCreationHook() {
	let current!: ReturnType<typeof useIndependentTaskCreation>;
	function HookHarness() {
		current = useIndependentTaskCreation("workspace", "source", "peer");
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mountedRoots.push({ root, container });
	act(() => root.render(<HookHarness />));
	return {
		result: {
			get current() {
				return current;
			},
		},
	};
}
afterEach(() => {
	for (const { root, container } of mountedRoots.splice(0)) {
		act(() => root.unmount());
		container.remove();
	}
});
beforeEach(() => {
	vi.clearAllMocks();
	persisted = {
		requestId: "11111111-1111-4111-8111-111111111111",
		sourceTaskId: "source",
		sourceTaskConversationSessionId: "peer",
		revision: 1,
		status: "ready",
		userTaskDescription: "已有范围",
		suggestedTaskDescription: "已有建议",
		title: "[FEAT]已有标题",
		initialPrompt: "已有需求",
		titleWasEditedByUser: false,
		initialPromptWasEditedByUser: false,
		contextInheritance: "fresh_conversation",
		worktreeSource: "local_main_immediately",
		generationSource: "kanban_model_provider",
		sourceAgentGenerationUnavailableReason: null,
		generatedFromDescription: "已有范围",
		contextCapturedAt: 1,
		contextWarnings: [],
		forkUnavailableReason: null,
		sourceGitStatus: "",
		sourceCommitsNotInLocalMain: 0,
		errorMessage: null,
		createdTaskId: null,
	};
	mocked.latest.mockImplementation(async () => ({ ...persisted }));
	mocked.read.mockImplementation(async () => ({ ...persisted }));
	mocked.save.mockImplementation(async (input: IndependentTaskCreationDraftEdit) => {
		persisted = { ...persisted, ...input, revision: persisted.revision + 1 };
		return { ...persisted };
	});
});

it("重开已有草稿不自动付费；按键仅编辑，关闭会等待持久保存", async () => {
	const hook = renderIndependentTaskCreationHook();
	await act(() => hook.result.current.begin());
	expect(mocked.generate).not.toHaveBeenCalled();
	act(() => hook.result.current.edit({ userTaskDescription: "用户的新范围" }));
	act(() => hook.result.current.edit({ initialPrompt: "用户手改需求", initialPromptWasEditedByUser: true }));
	expect(mocked.generate).not.toHaveBeenCalled();
	await act(() => hook.result.current.close());
	expect(hook.result.current.open).toBe(false);
	expect(persisted.initialPrompt).toBe("用户手改需求");
	await act(() => hook.result.current.begin());
	expect(hook.result.current.draft?.initialPrompt).toBe("用户手改需求");
	expect(mocked.generate).not.toHaveBeenCalled();
});

it("生成期间可继续编辑，迟到的结果不能抹掉本地输入", async () => {
	let finish: (draft: IndependentTaskCreationDraft) => void = () => {};
	mocked.generate.mockImplementation(
		() =>
			new Promise<IndependentTaskCreationDraft>((resolve) => {
				finish = resolve;
			}),
	);
	const hook = renderIndependentTaskCreationHook();
	await act(() => hook.result.current.begin());
	let generation: Promise<void>;
	await act(async () => {
		generation = hook.result.current.generate();
		await Promise.resolve();
	});
	act(() => hook.result.current.edit({ initialPrompt: "生成期间输入", initialPromptWasEditedByUser: true }));
	await act(async () => {
		finish({ ...persisted, revision: 3, initialPrompt: "迟到模型结果" });
		await generation;
	});
	expect(hook.result.current.draft?.initialPrompt).toBe("生成期间输入");
	await act(() => hook.result.current.close());
	expect(persisted.initialPrompt).toBe("生成期间输入");
});
