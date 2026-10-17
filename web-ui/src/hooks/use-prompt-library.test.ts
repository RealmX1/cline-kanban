import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PromptLibraryController, StoredPrompt } from "@/hooks/use-prompt-library";
import { notifyPromptLibraryInvalidated } from "@/runtime/prompt-library-invalidation-events";
import type { WorkspacePromptLibraryMutation, WorkspacePromptLibrarySnapshot } from "@/runtime/types";

const fetchWorkspacePromptLibraryMock = vi.fn();
const mutateWorkspacePromptLibraryMock = vi.fn();

vi.mock("@/runtime/prompt-library-query", () => ({
	EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT: {
		globalScopedPrompts: [],
		repoScopedPrompts: [],
		taskScopedPromptsByTaskId: {},
	},
	fetchWorkspacePromptLibrary: (...args: unknown[]) => fetchWorkspacePromptLibraryMock(...args),
	mutateWorkspacePromptLibrary: (...args: unknown[]) => mutateWorkspacePromptLibraryMock(...args),
}));

const { resolveVisiblePrompts, usePromptLibrary } = await import("@/hooks/use-prompt-library");

const PROJECT_ID = "workspace-alpha";
const TASK_ID = "task-1";

function createPrompt(overrides: Partial<StoredPrompt> & Pick<StoredPrompt, "id" | "scope">): StoredPrompt {
	return { text: "", createdAt: 0, updatedAt: 0, ...overrides };
}

function emptySnapshot(): WorkspacePromptLibrarySnapshot {
	return { globalScopedPrompts: [], repoScopedPrompts: [], taskScopedPromptsByTaskId: {} };
}

// 待落盘正文只有在「这个 id 在服务端快照里确实存在」时才会显示出来（正文覆盖是盖在快照条目上的），
// 所以凡是要断言「界面上还看得见刚打的字」的用例，都得先让服务端快照里有这一条。
function snapshotWithGlobalPrompt(text: string): WorkspacePromptLibrarySnapshot {
	return { ...emptySnapshot(), globalScopedPrompts: [createPrompt({ id: "g", scope: "global", text })] };
}

describe("可见条目的排列", () => {
	it("全局组在前、然后本仓库组、最后是当前任务自己的组", () => {
		const snapshot: WorkspacePromptLibrarySnapshot = {
			globalScopedPrompts: [createPrompt({ id: "g", scope: "global" })],
			repoScopedPrompts: [createPrompt({ id: "r", scope: "repo" })],
			taskScopedPromptsByTaskId: {
				[TASK_ID]: [createPrompt({ id: "t", scope: "task" })],
				"other-task": [createPrompt({ id: "other", scope: "task" })],
			},
		};

		expect(resolveVisiblePrompts(snapshot, TASK_ID).map((prompt) => prompt.id)).toEqual(["g", "r", "t"]);
	});

	it("别的任务的条目不出现在本任务视角里", () => {
		const snapshot: WorkspacePromptLibrarySnapshot = {
			...emptySnapshot(),
			taskScopedPromptsByTaskId: { "other-task": [createPrompt({ id: "other", scope: "task" })] },
		};

		expect(resolveVisiblePrompts(snapshot, TASK_ID)).toEqual([]);
	});
});

describe("usePromptLibrary", () => {
	let container: HTMLDivElement;
	let root: Root | null;
	let previousActEnvironment: boolean | undefined;
	let latestController: PromptLibraryController | null;

	function HookHarness({ projectId, taskId }: { projectId: string; taskId: string }): null {
		latestController = usePromptLibrary(taskId, projectId);
		return null;
	}

	async function renderHarness(projectId = PROJECT_ID, taskId = TASK_ID): Promise<void> {
		await act(async () => {
			root?.render(createElement(HookHarness, { projectId, taskId }));
		});
	}

	function requireController(): PromptLibraryController {
		if (!latestController) {
			throw new Error("Hook harness has not rendered yet.");
		}
		return latestController;
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		localStorage.clear();
		latestController = null;
		fetchWorkspacePromptLibraryMock.mockReset();
		mutateWorkspacePromptLibraryMock.mockReset();
		fetchWorkspacePromptLibraryMock.mockResolvedValue(emptySnapshot());
		mutateWorkspacePromptLibraryMock.mockResolvedValue(emptySnapshot());
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	it.each(["成功", "失败"] as const)("切换项目后旧项目保存%s也不会把正文复制到当前项目", async (saveResult) => {
		const otherProjectId = "workspace-beta";
		const otherTaskId = "task-beta";
		const projectSnapshot = {
			...emptySnapshot(),
			repoScopedPrompts: [createPrompt({ id: "project-alpha-prompt", scope: "repo", text: "项目 A 旧正文" })],
		};
		const otherProjectSnapshot = {
			...emptySnapshot(),
			repoScopedPrompts: [createPrompt({ id: "project-beta-prompt", scope: "repo", text: "项目 B 旧正文" })],
		};
		let finishOtherProjectFetch: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(projectSnapshot).mockReturnValueOnce(
			new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
				finishOtherProjectFetch = resolve;
			}),
		);
		let finishOldProjectSave: (snapshot: WorkspacePromptLibrarySnapshot | null) => void = () => {};
		const oldProjectSave = new Promise<WorkspacePromptLibrarySnapshot | null>((resolve) => {
			finishOldProjectSave = resolve;
		});
		mutateWorkspacePromptLibraryMock.mockImplementation((requestedProjectId: string) =>
			requestedProjectId === PROJECT_ID ? oldProjectSave : Promise.resolve(otherProjectSnapshot),
		);
		await renderHarness();
		await act(async () => requireController().updatePromptText("project-alpha-prompt", "项目 A 尚在保存的正文"));
		await act(async () => vi.advanceTimersByTime(600));
		await renderHarness(otherProjectId, otherTaskId);
		const promptsWhileOtherProjectLoads = requireController().prompts;
		await act(async () => finishOtherProjectFetch(otherProjectSnapshot));
		const savedProjectSnapshot = {
			...projectSnapshot,
			repoScopedPrompts: [
				createPrompt({ id: "project-alpha-prompt", scope: "repo", text: "项目 A 尚在保存的正文" }),
			],
		};
		await act(async () => finishOldProjectSave(saveResult === "成功" ? savedProjectSnapshot : null));
		await act(async () => requireController().updatePromptText("project-beta-prompt", "项目 B 新正文"));
		await act(async () => vi.advanceTimersByTime(600));
		await act(async () => root?.unmount());
		root = null;

		expect.soft(promptsWhileOtherProjectLoads).toEqual([]);
		const otherProjectWrites = mutateWorkspacePromptLibraryMock.mock.calls.filter(
			([requestedProjectId]) => requestedProjectId === otherProjectId,
		);
		expect(otherProjectWrites.length).toBeGreaterThan(0);
		expect(otherProjectWrites.every(([, mutation]) => mutation.promptId === "project-beta-prompt")).toBe(true);
	});

	it.each(["成功", "失败"] as const)("旧项目保存%s后切回时，正文按原项目保留或清理", async (saveResult) => {
		const projectPromptId = "project-alpha-prompt";
		const projectSnapshot = {
			...emptySnapshot(),
			repoScopedPrompts: [createPrompt({ id: projectPromptId, scope: "repo", text: "项目 A 旧正文" })],
		};
		fetchWorkspacePromptLibraryMock.mockResolvedValue(projectSnapshot);
		let finishOldProjectSave: (snapshot: WorkspacePromptLibrarySnapshot | null) => void = () => {};
		const oldProjectSave = new Promise<WorkspacePromptLibrarySnapshot | null>((resolve) => {
			finishOldProjectSave = resolve;
		});
		mutateWorkspacePromptLibraryMock.mockReturnValue(oldProjectSave);
		await renderHarness();
		await act(async () => requireController().updatePromptText(projectPromptId, "项目 A 待保存正文"));
		await act(async () => vi.advanceTimersByTime(600));
		await renderHarness("workspace-beta", "task-beta");
		const savedProjectSnapshot = {
			...projectSnapshot,
			repoScopedPrompts: [createPrompt({ id: projectPromptId, scope: "repo", text: "项目 A 待保存正文" })],
		};
		await act(async () => finishOldProjectSave(saveResult === "成功" ? savedProjectSnapshot : null));
		if (saveResult === "成功") {
			// 不让重读替成功响应做清理：即使切回后尚未读到快照，已保存正文也不能再次冲刷。
			fetchWorkspacePromptLibraryMock.mockReturnValue(new Promise<never>(() => {}));
		} else {
			fetchWorkspacePromptLibraryMock.mockResolvedValue(projectSnapshot);
		}
		await renderHarness(PROJECT_ID, "another-task-alpha");
		if (saveResult === "失败") {
			expect(requireController().prompts.find((prompt) => prompt.id === projectPromptId)?.text).toBe(
				"项目 A 待保存正文",
			);
		}
		mutateWorkspacePromptLibraryMock.mockClear();
		await act(async () => root?.unmount());
		root = null;

		if (saveResult === "成功") {
			expect(mutateWorkspacePromptLibraryMock).not.toHaveBeenCalled();
		} else {
			expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledExactlyOnceWith(PROJECT_ID, {
				kind: "upsert_prompt",
				promptId: projectPromptId,
				text: "项目 A 待保存正文",
				scope: "task",
				taskId: TASK_ID,
			});
		}
	});

	it("迁移的旧响应迟到时，不得覆盖已经显示的已使用状态", async () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "g", text: "历史正文", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);
		const migratedSnapshot = snapshotWithGlobalPrompt("历史正文");
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(migratedSnapshot);
		let finishMigration: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		mutateWorkspacePromptLibraryMock.mockReturnValueOnce(
			new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
				finishMigration = resolve;
			}),
		);
		await renderHarness();
		const usedSnapshot = snapshotWithGlobalPrompt("历史正文");
		for (const prompt of usedSnapshot.globalScopedPrompts) prompt.draftUsage = { markedUsedAtEpochMs: 1000 };
		fetchWorkspacePromptLibraryMock.mockResolvedValue(usedSnapshot);
		await act(async () => notifyPromptLibraryInvalidated(PROJECT_ID));
		expect(requireController().prompts[0]?.draftUsage?.markedUsedAtEpochMs).toBe(1000);
		await act(async () => finishMigration(migratedSnapshot));
		expect(requireController().prompts[0]?.draftUsage?.markedUsedAtEpochMs).toBe(1000);
		expect(localStorage.getItem("kanban.prompt-library.uploaded-to-server-at.v1")).toContain(PROJECT_ID);
	});

	it.each(["正文", "使用状态"] as const)(
		"较晚发出的失效查询最后返回旧库时，已保存的%s不能回退",
		async (editedField) => {
			const oldSnapshot = snapshotWithGlobalPrompt("旧正文");
			fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(oldSnapshot);
			await renderHarness();
			let finishMutation: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
			mutateWorkspacePromptLibraryMock.mockReturnValueOnce(
				new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
					finishMutation = resolve;
				}),
			);
			const savedSnapshot = snapshotWithGlobalPrompt(editedField === "正文" ? "已保存的新正文" : "旧正文");
			if (editedField === "正文") {
				await act(async () => requireController().updatePromptText("g", "已保存的新正文"));
				await act(async () => vi.advanceTimersByTime(600));
			} else {
				for (const prompt of savedSnapshot.globalScopedPrompts) prompt.draftUsage = { markedUsedAtEpochMs: 1000 };
				await act(async () => requireController().setPromptUsageStatus("g", true));
			}
			let finishOldRead: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
			fetchWorkspacePromptLibraryMock
				.mockReturnValueOnce(
					new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
						finishOldRead = resolve;
					}),
				)
				.mockResolvedValue(savedSnapshot);
			await act(async () => notifyPromptLibraryInvalidated(PROJECT_ID));
			await act(async () => finishMutation(savedSnapshot));
			expect(requireController().prompts[0]?.text).toBe(savedSnapshot.globalScopedPrompts[0]?.text);
			expect(requireController().prompts[0]?.draftUsage).toEqual(savedSnapshot.globalScopedPrompts[0]?.draftUsage);
			await act(async () => finishOldRead(oldSnapshot));
			expect(requireController().prompts[0]?.text).toBe(savedSnapshot.globalScopedPrompts[0]?.text);
			expect(requireController().prompts[0]?.draftUsage).toEqual(savedSnapshot.globalScopedPrompts[0]?.draftUsage);
		},
	);

	it("写入前读到旧库的查询先返回时，写入成功后补读真实已使用状态", async () => {
		const oldSnapshot = snapshotWithGlobalPrompt("旧正文");
		fetchWorkspacePromptLibraryMock.mockResolvedValue(oldSnapshot);
		await renderHarness();
		let finishMutation: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		mutateWorkspacePromptLibraryMock.mockReturnValueOnce(
			new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
				finishMutation = resolve;
			}),
		);
		await act(async () => requireController().setPromptUsageStatus("g", true));
		await act(async () => notifyPromptLibraryInvalidated(PROJECT_ID));
		const savedSnapshot = snapshotWithGlobalPrompt("旧正文");
		for (const prompt of savedSnapshot.globalScopedPrompts) prompt.draftUsage = { markedUsedAtEpochMs: 1000 };
		fetchWorkspacePromptLibraryMock.mockResolvedValue(savedSnapshot);
		await act(async () => finishMutation(savedSnapshot));
		expect(requireController().prompts[0]?.draftUsage?.markedUsedAtEpochMs).toBe(1000);
	});

	it("推流重读晚于保存响应时，读取失败也不会让刚编辑的正文回退", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(snapshotWithGlobalPrompt("旧正文"));
		await renderHarness();
		let finishMutation: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		mutateWorkspacePromptLibraryMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishMutation = resolve;
				}),
		);
		await act(async () => requireController().updatePromptText("g", "已保存的新正文"));
		await act(async () => vi.advanceTimersByTime(600));
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(null);
		await act(async () => notifyPromptLibraryInvalidated(PROJECT_ID));
		await act(async () => finishMutation(snapshotWithGlobalPrompt("已保存的新正文")));
		expect(requireController().prompts[0]?.text).toBe("已保存的新正文");
	});

	it("已使用的推流快照先返回时，较早发出的编辑响应不能把状态改回未使用", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(snapshotWithGlobalPrompt("旧正文"));
		await renderHarness();
		let finishMutation: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		mutateWorkspacePromptLibraryMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishMutation = resolve;
				}),
		);
		await act(async () => requireController().updatePromptText("g", "已保存的新正文"));
		await act(async () => vi.advanceTimersByTime(600));
		const usedSnapshot = snapshotWithGlobalPrompt("已保存的新正文");
		for (const prompt of usedSnapshot.globalScopedPrompts) prompt.draftUsage = { markedUsedAtEpochMs: 1000 };
		// 写后确认读取失败时，也保留此前已经显示的较新使用状态。
		fetchWorkspacePromptLibraryMock.mockResolvedValueOnce(usedSnapshot).mockResolvedValue(null);
		await act(async () => notifyPromptLibraryInvalidated(PROJECT_ID));
		await act(async () => finishMutation(snapshotWithGlobalPrompt("已保存的新正文")));
		expect(requireController().prompts[0]?.draftUsage?.markedUsedAtEpochMs).toBe(1000);
	});

	afterEach(async () => {
		await act(async () => {
			root?.unmount();
		});
		root = null;
		container.remove();
		vi.useRealTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("新增条目立刻出现在列表里，不必等服务端 ack——否则面板的自动聚焦会落空", async () => {
		await renderHarness();
		// 让 ack 一直悬着：本用例断言的正是「ack 还没回来时列表里就有这一行」。
		mutateWorkspacePromptLibraryMock.mockReturnValue(new Promise<never>(() => {}));

		let newPromptId = "";
		await act(async () => {
			newPromptId = requireController().addPrompt();
		});

		expect(requireController().prompts.map((prompt) => prompt.id)).toEqual([newPromptId]);
		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "upsert_prompt",
			promptId: newPromptId,
			text: "",
			scope: "task",
			taskId: TASK_ID,
			origin: "manual",
		});
	});

	it("打字即时回显，但要静默一段时间才落盘——逐次击键发请求会既卡输入又把库文件锁成热点", async () => {
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();

		await act(async () => {
			requireController().updatePromptText("p1", "写");
			requireController().updatePromptText("p1", "写测");
			requireController().updatePromptText("p1", "写测试");
		});

		expect(requireController().prompts.find((prompt) => prompt.id === "p1")).toBeUndefined();
		expect(mutateWorkspacePromptLibraryMock).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		// 三次击键只落一趟，且落的是最后那份正文。
		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledTimes(1);
		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "upsert_prompt",
			promptId: "p1",
			text: "写测试",
			scope: "task",
			taskId: TASK_ID,
		});
	});

	it("正文编辑盖在服务端快照之上，打字过程中列表显示的是本地那份", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue({
			...emptySnapshot(),
			globalScopedPrompts: [createPrompt({ id: "g", scope: "global", text: "服务端正文" })],
		});
		await renderHarness();

		await act(async () => {
			requireController().updatePromptText("g", "刚打的字");
		});

		expect(requireController().prompts.find((prompt) => prompt.id === "g")?.text).toBe("刚打的字");
	});

	it("卸载时强制冲刷——面板经常是打完字直接切走，等去抖到点已经来不及", async () => {
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();

		await act(async () => {
			requireController().updatePromptText("p1", "还没到点就切走了");
		});
		await act(async () => {
			root?.unmount();
		});
		root = null;

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "upsert_prompt",
			promptId: "p1",
			text: "还没到点就切走了",
			scope: "task",
			taskId: TASK_ID,
		});
	});

	it("落盘抛异常时待落盘正文留在界面上——清掉它等于让用户刚打的字凭空回落成服务端旧正文", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("服务端旧正文"));
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();
		mutateWorkspacePromptLibraryMock.mockRejectedValue(new Error("offline"));

		await act(async () => {
			requireController().updatePromptText("g", "刚打的字");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledTimes(1);
		expect(requireController().prompts.find((prompt) => prompt.id === "g")?.text).toBe("刚打的字");
	});

	it("服务端回 ok:false（helper 给 null）同样算落盘失败，正文照样留在界面上", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("服务端旧正文"));
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();
		mutateWorkspacePromptLibraryMock.mockResolvedValue(null);

		await act(async () => {
			requireController().updatePromptText("g", "刚打的字");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		expect(requireController().prompts.find((prompt) => prompt.id === "g")?.text).toBe("刚打的字");
	});

	it("落盘失败后正文仍是待落盘的，下一轮冲刷会把它连同新打的字再送一次", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("服务端旧正文"));
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();
		mutateWorkspacePromptLibraryMock.mockRejectedValue(new Error("offline"));

		await act(async () => {
			requireController().updatePromptText("g", "第一段");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		mutateWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("第一段第二段"));
		await act(async () => {
			requireController().updatePromptText("g", "第一段第二段");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenLastCalledWith(PROJECT_ID, {
			kind: "upsert_prompt",
			promptId: "g",
			text: "第一段第二段",
			scope: "task",
			taskId: TASK_ID,
		});
		expect(requireController().prompts.find((prompt) => prompt.id === "g")?.text).toBe("第一段第二段");
	});

	it("请求在途时继续打字，这次冲刷的清理不会吃掉更新的那份正文", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("服务端旧正文"));
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();
		let resolveFirstWrite: (snapshot: WorkspacePromptLibrarySnapshot) => void = () => {};
		mutateWorkspacePromptLibraryMock.mockReturnValueOnce(
			new Promise<WorkspacePromptLibrarySnapshot>((resolve) => {
				resolveFirstWrite = resolve;
			}),
		);

		await act(async () => {
			requireController().updatePromptText("g", "第一段");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});
		// 第一趟写还悬在途中，用户又敲了几个字。
		await act(async () => {
			requireController().updatePromptText("g", "第一段第二段");
		});
		await act(async () => {
			resolveFirstWrite(snapshotWithGlobalPrompt("第一段"));
		});

		expect(requireController().prompts.find((prompt) => prompt.id === "g")?.text).toBe("第一段第二段");

		mutateWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("第一段第二段"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenLastCalledWith(PROJECT_ID, {
			kind: "upsert_prompt",
			promptId: "g",
			text: "第一段第二段",
			scope: "task",
			taskId: TASK_ID,
		});
	});

	it("删除会连本地那份待落盘正文一起丢掉，否则它会在下一次冲刷时被 upsert 回来", async () => {
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();

		await act(async () => {
			requireController().updatePromptText("p1", "要被删掉的");
			requireController().removePrompt("p1");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		const sentMutations = mutateWorkspacePromptLibraryMock.mock.calls.map(
			([, mutation]) => mutation as WorkspacePromptLibraryMutation,
		);
		expect(sentMutations).toContainEqual({ kind: "remove_prompt", promptId: "p1" });
		expect(sentMutations.some((mutation) => mutation.kind === "upsert_prompt")).toBe(false);
	});

	it("落盘失败后又删除条目，被留下的待落盘正文照样丢弃，不会在后续冲刷里复活", async () => {
		fetchWorkspacePromptLibraryMock.mockResolvedValue(snapshotWithGlobalPrompt("服务端旧正文"));
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();
		mutateWorkspacePromptLibraryMock.mockRejectedValue(new Error("offline"));

		await act(async () => {
			requireController().updatePromptText("g", "落盘失败的正文");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		mutateWorkspacePromptLibraryMock.mockClear();
		mutateWorkspacePromptLibraryMock.mockResolvedValue(emptySnapshot());
		await act(async () => {
			requireController().removePrompt("g");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(700);
		});

		const sentMutations = mutateWorkspacePromptLibraryMock.mock.calls.map(
			([, mutation]) => mutation as WorkspacePromptLibraryMutation,
		);
		expect(sentMutations).toContainEqual({ kind: "remove_prompt", promptId: "g" });
		expect(sentMutations.some((mutation) => mutation.kind === "upsert_prompt")).toBe(false);
	});

	it("换 scope 离开 task 时把 taskId 置空，进 task 时带上当前任务", async () => {
		await renderHarness();
		mutateWorkspacePromptLibraryMock.mockClear();

		await act(async () => {
			requireController().setPromptScope("p1", "global");
			requireController().setPromptScope("p2", "task");
		});

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "set_prompt_scope",
			promptId: "p1",
			scope: "global",
			taskId: null,
		});
		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "set_prompt_scope",
			promptId: "p2",
			scope: "task",
			taskId: TASK_ID,
		});
	});

	it("库读不出来时保持空列表且**不做迁移**——把损坏当空库会再叠一份重复数据", async () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "old", text: "历史模板", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);
		fetchWorkspacePromptLibraryMock.mockResolvedValue(null);

		await renderHarness();

		expect(requireController().prompts).toEqual([]);
		expect(mutateWorkspacePromptLibraryMock).not.toHaveBeenCalled();
	});

	it("首次载入把浏览器里的历史条目合并上去，并打上已迁移标记", async () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "old", text: "历史模板", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);

		await renderHarness();

		expect(mutateWorkspacePromptLibraryMock).toHaveBeenCalledWith(PROJECT_ID, {
			kind: "merge_prompts_migrated_from_browser_local_storage",
			prompts: [{ id: "old", text: "历史模板", scope: "global", createdAt: 1, updatedAt: 2 }],
		});
		expect(localStorage.getItem("kanban.prompt-library.uploaded-to-server-at.v1")).toContain(PROJECT_ID);
		// 刻意不删本地数据：它是回退备份，而合并按「桶 + 正文」去重、天然幂等。
		expect(localStorage.getItem("kanban.prompt-library.global.v1")).not.toBeNull();
	});

	it("迁移失败不打标记，下次挂载会再试一遍", async () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "old", text: "历史模板", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);
		mutateWorkspacePromptLibraryMock.mockRejectedValue(new Error("offline"));

		await renderHarness();

		expect(localStorage.getItem("kanban.prompt-library.uploaded-to-server-at.v1")).toBeNull();
	});

	it("已打过标记的 workspace 不再重发迁移载荷", async () => {
		localStorage.setItem(
			"kanban.prompt-library.global.v1",
			JSON.stringify([{ id: "old", text: "历史模板", scope: "global", createdAt: 1, updatedAt: 2 }]),
		);
		localStorage.setItem("kanban.prompt-library.uploaded-to-server-at.v1", JSON.stringify({ [PROJECT_ID]: 123 }));

		await renderHarness();

		expect(mutateWorkspacePromptLibraryMock).not.toHaveBeenCalled();
	});
});
