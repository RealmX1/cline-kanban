import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeTaskEditDraft,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";

const fetchWorkspaceTaskEditDraftsMock = vi.fn();
const mutateWorkspaceTaskEditDraftsMock = vi.fn();

vi.mock("@/runtime/task-edit-drafts-query", () => ({
	EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT: { draftsByTaskId: {}, supersededDraftCopies: [] },
	fetchWorkspaceTaskEditDrafts: (...args: unknown[]) => fetchWorkspaceTaskEditDraftsMock(...args),
	mutateWorkspaceTaskEditDrafts: (...args: unknown[]) => mutateWorkspaceTaskEditDraftsMock(...args),
}));

const {
	clearTaskEditDraftInStore,
	discardAllTaskEditDraftsForDeletedTask,
	readSavedTaskEditDraftFromStore,
	readTaskEditDraftsFromBrowserLocalStorage,
	resetTaskEditDraftStoreForTests,
	saveTaskEditDraftToStore,
	discardSupersededTaskEditDraftCopy,
	promoteSupersededTaskEditDraftCopyToCurrentDraft,
	readSupersededTaskEditDraftCopiesFromStore,
	startLoadingWorkspaceTaskEditDrafts,
} = await import("@/runtime/task-edit-draft-store");

const WORKSPACE_ID = "workspace-alpha";
const TASK_EDIT_DRAFTS_MIRROR_KEY = "kanban.task-edit-drafts.v1";

function createDraft(
	overrides: Partial<RuntimeTaskEditDraft> & Pick<RuntimeTaskEditDraft, "taskId">,
): RuntimeTaskEditDraft {
	return {
		prompt: "",
		images: [],
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		branchRef: "main",
		savedAt: 0,
		...overrides,
	};
}

function seedBrowserLocalStorageMirror(workspaceId: string, draft: RuntimeTaskEditDraft): void {
	localStorage.setItem(
		TASK_EDIT_DRAFTS_MIRROR_KEY,
		JSON.stringify({ drafts: { [JSON.stringify([workspaceId, draft.taskId])]: draft } }),
	);
}

/**
 * 等 store 内部那串 `await` 全部跑完。
 *
 * 断言「迁移已落定」不能只等 mutate 被**调用**：调用之后还有几步 microtask 才轮到 store 记下交接完成。
 * 跨一个 macrotask 边界可以确保 microtask 队列已经排空。
 */
async function flushPendingTaskEditDraftStoreWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("任务编辑草稿 store", () => {
	// 假服务端保有状态：mutate 必须把意图应用上去再回快照，与真实 mutateWorkspaceTaskEditDrafts 一致。
	let draftsHeldByFakeServer: WorkspaceTaskEditDraftsSnapshot;

	// 单独提出来，好让个别用例在它外面再包一层「卡住某条意图」的时序控制。
	function applyMutationToDraftsHeldByFakeServer(
		mutation: WorkspaceTaskEditDraftMutation,
	): WorkspaceTaskEditDraftsSnapshot {
		if (mutation.kind === "save_task_edit_draft") {
			draftsHeldByFakeServer = {
				...draftsHeldByFakeServer,
				draftsByTaskId: {
					...draftsHeldByFakeServer.draftsByTaskId,
					[mutation.draft.taskId]: mutation.draft,
				},
			};
		}
		if (
			mutation.kind === "clear_task_edit_draft" ||
			mutation.kind === "discard_all_task_edit_drafts_for_deleted_task"
		) {
			const { [mutation.taskId]: _removed, ...remaining } = draftsHeldByFakeServer.draftsByTaskId;
			draftsHeldByFakeServer = { ...draftsHeldByFakeServer, draftsByTaskId: remaining };
		}
		if (mutation.kind === "discard_superseded_task_edit_draft_copy") {
			draftsHeldByFakeServer = {
				...draftsHeldByFakeServer,
				supersededDraftCopies: draftsHeldByFakeServer.supersededDraftCopies.filter(
					(copy) =>
						!(copy.draft.taskId === mutation.taskId && copy.draft.savedAt === mutation.supersededDraftSavedAt),
				),
			};
		}
		if (mutation.kind === "promote_superseded_task_edit_draft_copy_to_current_draft") {
			const promotedCopy = draftsHeldByFakeServer.supersededDraftCopies.find(
				(copy) => copy.draft.taskId === mutation.taskId && copy.draft.savedAt === mutation.supersededDraftSavedAt,
			);
			if (promotedCopy) {
				const currentDraftBeingReplaced = draftsHeldByFakeServer.draftsByTaskId[mutation.taskId];
				draftsHeldByFakeServer = {
					draftsByTaskId: { ...draftsHeldByFakeServer.draftsByTaskId, [mutation.taskId]: promotedCopy.draft },
					supersededDraftCopies: [
						...draftsHeldByFakeServer.supersededDraftCopies.filter((copy) => copy !== promotedCopy),
						...(currentDraftBeingReplaced
							? [
									{
										draft: currentDraftBeingReplaced,
										supersededAt: 9_999,
										supersededBySavedAt: promotedCopy.draft.savedAt,
									},
								]
							: []),
					],
				};
			}
		}
		return draftsHeldByFakeServer;
	}

	beforeEach(() => {
		localStorage.clear();
		fetchWorkspaceTaskEditDraftsMock.mockReset();
		mutateWorkspaceTaskEditDraftsMock.mockReset();
		draftsHeldByFakeServer = { draftsByTaskId: {}, supersededDraftCopies: [] };
		fetchWorkspaceTaskEditDraftsMock.mockImplementation(async () => draftsHeldByFakeServer);
		mutateWorkspaceTaskEditDraftsMock.mockImplementation(
			async (_workspaceId: string, mutation: WorkspaceTaskEditDraftMutation) =>
				applyMutationToDraftsHeldByFakeServer(mutation),
		);
		resetTaskEditDraftStoreForTests();
	});

	afterEach(() => {
		resetTaskEditDraftStoreForTests();
	});

	describe("同步取值", () => {
		it("服务端快照还没到时同步读出本地镜像——编辑表单要靠它铺初值，慢一帧就会先闪一个空表单", () => {
			seedBrowserLocalStorageMirror(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "镜像里那份" }));

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("镜像里那份");
		});

		it("镜像的键按 [workspaceId, taskId] 配对，别的 workspace 那份读不到", () => {
			seedBrowserLocalStorageMirror("another-workspace", createDraft({ taskId: "task-1", prompt: "别人的" }));

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")).toBeNull();
		});

		it("服务端快照到了之后以它为准", async () => {
			draftsHeldByFakeServer = {
				draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", prompt: "服务端那份" }) },
				supersededDraftCopies: [],
			};

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await vi.waitFor(() =>
				expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("服务端那份"),
			);
		});

		// 否则刚被另一个标签页清掉的草稿会像幽灵一样从镜像里回来。
		it("镜像交接完成后，服务端没有的那条就是被清掉了，不回落镜像", async () => {
			const draft = createDraft({ taskId: "task-1", prompt: "镜像里那份", savedAt: 5 });
			seedBrowserLocalStorageMirror(WORKSPACE_ID, draft);
			draftsHeldByFakeServer = { draftsByTaskId: { "task-1": draft }, supersededDraftCopies: [] };

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalled());
			await flushPendingTaskEditDraftStoreWork();

			// 另一个标签页清掉了 task-1，而本标签页的镜像还留着那份；下一次写入的响应把服务端最新状态带回来。
			draftsHeldByFakeServer = { draftsByTaskId: {}, supersededDraftCopies: [] };
			saveTaskEditDraftToStore(WORKSPACE_ID, createDraft({ taskId: "task-2" }));
			await vi.waitFor(() => expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")).toBeNull());
		});

		// 这是「草稿被静默删除」的那条路径：读成「无草稿」之后，use-task-editor 的去抖自动保存会判定
		// 表单等于任务本体而发出 clearTaskEditDraft，把镜像里那份无法重建的草稿一起抹掉。
		it("服务端快照已到但迁移还在途时，仍读得出镜像里那份", async () => {
			seedBrowserLocalStorageMirror(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "镜像里那份" }));
			// 服务端此刻还没有这条——它正是这次迁移要送上去的内容。合并请求挂着不落定，构造那段窗口。
			mutateWorkspaceTaskEditDraftsMock.mockImplementation(() => new Promise(() => {}));

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalled());
			await flushPendingTaskEditDraftStoreWork();

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("镜像里那份");
		});

		it("迁移请求失败时仍读得出镜像里那份，且允许下次重试", async () => {
			seedBrowserLocalStorageMirror(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "镜像里那份" }));
			mutateWorkspaceTaskEditDraftsMock.mockRejectedValue(new Error("offline"));

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(1));
			await flushPendingTaskEditDraftStoreWork();

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("镜像里那份");
			// 交接没落定就不能停在那儿不再重试——上一句的取值会把整条载入重新踢起来。
			await vi.waitFor(() => expect(fetchWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(2));
		});

		it("读不出服务端草稿时继续用镜像跑，且允许下次重试", async () => {
			seedBrowserLocalStorageMirror(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "镜像里那份" }));
			fetchWorkspaceTaskEditDraftsMock.mockResolvedValueOnce(null);

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await vi.waitFor(() => expect(fetchWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(1));

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("镜像里那份");
			// 读坏了就**不**迁移——把损坏当空集会再叠一份重复草稿上去。
			expect(mutateWorkspaceTaskEditDraftsMock).not.toHaveBeenCalled();
			await vi.waitFor(() => {
				startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
				expect(fetchWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(2);
			});
		});
	});

	describe("写入", () => {
		it("先落本地镜像再发服务端，服务端失败也不丢用户刚打的字", async () => {
			mutateWorkspaceTaskEditDraftsMock.mockRejectedValue(new Error("offline"));

			saveTaskEditDraftToStore(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "打了一半" }));

			expect(localStorage.getItem(TASK_EDIT_DRAFTS_MIRROR_KEY)).toContain("打了一半");
			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("打了一半");
			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalled());
			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")?.prompt).toBe("打了一半");
		});

		it("清除同时抹掉镜像与内存里那份", () => {
			saveTaskEditDraftToStore(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "打了一半" }));
			clearTaskEditDraftInStore(WORKSPACE_ID, "task-1");

			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")).toBeNull();
			expect(localStorage.getItem(TASK_EDIT_DRAFTS_MIRROR_KEY)).toBeNull();
		});

		it("任务删除走的是独立意图——它要连落败副本一起清，与「这次编辑收尾了」不是一回事", async () => {
			saveTaskEditDraftToStore(WORKSPACE_ID, createDraft({ taskId: "task-1" }));
			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(1));
			mutateWorkspaceTaskEditDraftsMock.mockClear();

			discardAllTaskEditDraftsForDeletedTask(WORKSPACE_ID, "task-1");

			await vi.waitFor(() =>
				expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledWith(WORKSPACE_ID, {
					kind: "discard_all_task_edit_drafts_for_deleted_task",
					taskId: "task-1",
				}),
			);
			expect(readSavedTaskEditDraftFromStore(WORKSPACE_ID, "task-1")).toBeNull();
		});

		// 草稿保存是每次击键的去抖副作用，最后一次 save 与用户点「保存」/「取消」触发的 clear 几乎同时
		// 出发；save 迟一步落到服务端的文件锁，就会把刚清掉的那份整条写回去，下次打开又冒出幽灵草稿。
		it("迟到的保存不会把已经清除的草稿写回服务端", async () => {
			let releaseFirstMutationHeldAtServer: () => void = () => {};
			const firstMutationHeldAtServer = new Promise<void>((resolve) => {
				releaseFirstMutationHeldAtServer = resolve;
			});
			let mutationsReachingFakeServer = 0;
			mutateWorkspaceTaskEditDraftsMock.mockImplementation(
				async (_workspaceId: string, mutation: WorkspaceTaskEditDraftMutation) => {
					mutationsReachingFakeServer += 1;
					// 卡住最先抵达的那条，制造「后发的意图先摸到文件锁」的时序。
					if (mutationsReachingFakeServer === 1) {
						await firstMutationHeldAtServer;
					}
					return applyMutationToDraftsHeldByFakeServer(mutation);
				},
			);

			saveTaskEditDraftToStore(WORKSPACE_ID, createDraft({ taskId: "task-1", prompt: "去抖自动保存" }));
			clearTaskEditDraftInStore(WORKSPACE_ID, "task-1");
			releaseFirstMutationHeldAtServer();

			await vi.waitFor(() => expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(draftsHeldByFakeServer.draftsByTaskId["task-1"]).toBeUndefined());
		});
	});

	describe("合并迁移", () => {
		it("首次载入把这台浏览器里属于本 workspace 的草稿送上去，且不删本地镜像", async () => {
			const draft = createDraft({ taskId: "task-1", prompt: "历史草稿", savedAt: 5 });
			seedBrowserLocalStorageMirror(WORKSPACE_ID, draft);

			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);

			await vi.waitFor(() =>
				expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledWith(WORKSPACE_ID, {
					kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
					drafts: [draft],
				}),
			);
			// 草稿无法重建，本地那份要留作回退备份。
			expect(localStorage.getItem(TASK_EDIT_DRAFTS_MIRROR_KEY)).toContain("历史草稿");
		});

		it("本地没有草稿时不发迁移请求", async () => {
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);

			await vi.waitFor(() => expect(fetchWorkspaceTaskEditDraftsMock).toHaveBeenCalled());
			expect(mutateWorkspaceTaskEditDraftsMock).not.toHaveBeenCalled();
		});

		it("重复调用只载入一次", async () => {
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);

			await vi.waitFor(() => expect(fetchWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(1));
		});
	});

	describe("镜像读取", () => {
		it("只返回属于该 workspace 的草稿", () => {
			localStorage.setItem(
				TASK_EDIT_DRAFTS_MIRROR_KEY,
				JSON.stringify({
					drafts: {
						[JSON.stringify([WORKSPACE_ID, "task-1"])]: createDraft({ taskId: "task-1" }),
						[JSON.stringify(["another-workspace", "task-2"])]: createDraft({ taskId: "task-2" }),
					},
				}),
			);

			expect(readTaskEditDraftsFromBrowserLocalStorage(WORKSPACE_ID).map((draft) => draft.taskId)).toEqual([
				"task-1",
			]);
		});

		it("坏条目逐条丢弃，不让一条脏数据把整份迁移带崩", () => {
			localStorage.setItem(
				TASK_EDIT_DRAFTS_MIRROR_KEY,
				JSON.stringify({
					drafts: {
						[JSON.stringify([WORKSPACE_ID, "task-1"])]: createDraft({ taskId: "task-1" }),
						[JSON.stringify([WORKSPACE_ID, "task-bad"])]: { taskId: 42 },
					},
				}),
			);

			expect(readTaskEditDraftsFromBrowserLocalStorage(WORKSPACE_ID).map((draft) => draft.taskId)).toEqual([
				"task-1",
			]);
		});

		it("整份 JSON 坏掉时当作没有历史草稿，而不是抛出去把编辑对话框打不开", () => {
			localStorage.setItem(TASK_EDIT_DRAFTS_MIRROR_KEY, "{ 这不是 JSON");

			expect(readTaskEditDraftsFromBrowserLocalStorage(WORKSPACE_ID)).toEqual([]);
		});
	});

	describe("落败副本", () => {
		function seedServerWithSupersededCopies(): void {
			draftsHeldByFakeServer = {
				draftsByTaskId: { "task-1": createDraft({ taskId: "task-1", savedAt: 30, prompt: "当前这份" }) },
				supersededDraftCopies: [
					{
						draft: createDraft({ taskId: "task-1", savedAt: 10, prompt: "另一个 origin 那份" }),
						supersededAt: 1,
						supersededBySavedAt: 30,
					},
					{
						draft: createDraft({ taskId: "task-2", savedAt: 10, prompt: "别的任务" }),
						supersededAt: 1,
						supersededBySavedAt: 30,
					},
				],
			};
		}

		it("选择器只挑这张卡片名下的副本", async () => {
			seedServerWithSupersededCopies();
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await flushPendingTaskEditDraftStoreWork();

			expect(
				readSupersededTaskEditDraftCopiesFromStore(WORKSPACE_ID, "task-1").map((copy) => copy.draft.prompt),
			).toEqual(["另一个 origin 那份"]);
		});

		// useSyncExternalStore 的 getSnapshot 每次渲染都会被调一遍。返回值引用一变就被判定为「store 变了」，
		// 于是再渲染一次、再调一次——直接进死循环把整个编辑对话框卡死。按 taskId 过滤天生每次产生新数组，
		// 所以这条不是锦上添花的性能断言，是这个选择器能不能被 useSyncExternalStore 用的前提。
		it("快照没变时选择器返回引用相等的数组，否则 useSyncExternalStore 会进死循环", async () => {
			seedServerWithSupersededCopies();
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await flushPendingTaskEditDraftStoreWork();

			expect(readSupersededTaskEditDraftCopiesFromStore(WORKSPACE_ID, "task-1")).toBe(
				readSupersededTaskEditDraftCopiesFromStore(WORKSPACE_ID, "task-1"),
			);
			// 一份副本都没有的卡片同样要引用稳定——那才是最常见的情形。
			expect(readSupersededTaskEditDraftCopiesFromStore(WORKSPACE_ID, "task-without-copies")).toBe(
				readSupersededTaskEditDraftCopiesFromStore(WORKSPACE_ID, "task-without-copies"),
			);
		});

		it("提升副本后镜像也要跟上——刷新后首屏读的是它，不更新就会拿回被换下来的旧草稿", async () => {
			seedServerWithSupersededCopies();
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await flushPendingTaskEditDraftStoreWork();

			const promotedDraft = await promoteSupersededTaskEditDraftCopyToCurrentDraft(WORKSPACE_ID, "task-1", 10);

			expect(promotedDraft?.prompt).toBe("另一个 origin 那份");
			expect(readTaskEditDraftsFromBrowserLocalStorage(WORKSPACE_ID).map((draft) => draft.prompt)).toEqual([
				"另一个 origin 那份",
			]);
		});

		it("服务端没有那一份时如实返回 null，不假装换过了", async () => {
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await flushPendingTaskEditDraftStoreWork();

			await expect(promoteSupersededTaskEditDraftCopyToCurrentDraft(WORKSPACE_ID, "task-1", 10)).resolves.toBeNull();
		});

		// RVF-004 立下的规矩：草稿类意图必须走 per-workspace 串行链。这两条新意图整体替换服务端快照，
		// 一旦与在途的 save/clear 乱序，晚到的那份响应会把已经落定的改动整体盖回去。
		it("两条副本意图都排在 per-workspace 串行链上，不得旁路", async () => {
			seedServerWithSupersededCopies();
			startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
			await flushPendingTaskEditDraftStoreWork();

			let releaseFirstMutation = (): void => {};
			const firstMutationCanFinish = new Promise<void>((resolve) => {
				releaseFirstMutation = resolve;
			});
			let isFirstMutation = true;
			mutateWorkspaceTaskEditDraftsMock.mockImplementation(
				async (_workspaceId: string, mutation: WorkspaceTaskEditDraftMutation) => {
					if (isFirstMutation) {
						isFirstMutation = false;
						await firstMutationCanFinish;
					}
					return applyMutationToDraftsHeldByFakeServer(mutation);
				},
			);

			const discarded = discardSupersededTaskEditDraftCopy(WORKSPACE_ID, "task-1", 10);
			const promoted = promoteSupersededTaskEditDraftCopyToCurrentDraft(WORKSPACE_ID, "task-1", 10);
			await flushPendingTaskEditDraftStoreWork();

			// 第一条还卡着，第二条就绝不该已经打到服务端——那正是串行链的定义。
			expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(1);
			releaseFirstMutation();
			await discarded;
			await promoted;
			expect(mutateWorkspaceTaskEditDraftsMock).toHaveBeenCalledTimes(2);
		});
	});
});
