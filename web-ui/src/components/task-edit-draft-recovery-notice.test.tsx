import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type TaskEditDraftComparableValues,
	TaskEditDraftRecoveryNotice,
} from "@/components/task-edit-draft-recovery-notice";
import type {
	RuntimeTaskEditDraft,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const EMPTY_SNAPSHOT: WorkspaceTaskEditDraftsSnapshot = { draftsByTaskId: {}, supersededDraftCopies: [] };

let draftsHeldByFakeServer: WorkspaceTaskEditDraftsSnapshot = EMPTY_SNAPSHOT;
const mutationsSentToFakeServer: WorkspaceTaskEditDraftMutation[] = [];

// 假服务端要真的把意图**应用**上去：ack 回一份没变的快照会让「丢弃后那一条消失」看起来像组件没生效，
// 而那是假服务端在撒谎。这里复刻的是 src/state/task-edit-draft-store.ts 的两条副本意图语义
// （真实实现由 test/runtime/state/task-edit-draft-store.test.ts 钉住，这里只需要它对得上）。
function applyMutationToDraftsHeldByFakeServer(
	mutation: WorkspaceTaskEditDraftMutation,
): WorkspaceTaskEditDraftsSnapshot {
	mutationsSentToFakeServer.push(mutation);
	if (mutation.kind === "save_task_edit_draft") {
		draftsHeldByFakeServer = {
			...draftsHeldByFakeServer,
			draftsByTaskId: { ...draftsHeldByFakeServer.draftsByTaskId, [mutation.draft.taskId]: mutation.draft },
		};
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

vi.mock("@/runtime/task-edit-drafts-query", () => ({
	EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT: { draftsByTaskId: {}, supersededDraftCopies: [] },
	fetchWorkspaceTaskEditDrafts: async () => draftsHeldByFakeServer,
	mutateWorkspaceTaskEditDrafts: async (_workspaceId: string, mutation: WorkspaceTaskEditDraftMutation) =>
		applyMutationToDraftsHeldByFakeServer(mutation),
}));

const shownToasts: Array<{ intent: string; message: string }> = [];
vi.mock("@/components/app-toaster", () => ({
	showAppToast: (toast: { intent: string; message: string }) => {
		shownToasts.push(toast);
	},
}));

const { resetTaskEditDraftStoreForTests, startLoadingWorkspaceTaskEditDrafts } = await import(
	"@/runtime/task-edit-draft-store"
);

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";

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

const CURRENT_FORM_VALUES: TaskEditDraftComparableValues = {
	prompt: "表单里此刻这份",
	images: [],
	startInPlanMode: false,
	autoReviewEnabled: false,
	autoReviewMode: "commit",
	branchRef: "main",
};

let container: HTMLDivElement;
let root: Root;

function renderNotice(overrides?: {
	seededFromSavedDraftAt?: number | null;
	currentFormValues?: TaskEditDraftComparableValues;
	onRevertToSavedTaskContent?: () => void;
	onSupersededCopyPromotedToCurrentDraft?: (draft: RuntimeTaskEditDraft) => void;
}): void {
	const element: ReactElement = (
		<TaskEditDraftRecoveryNotice
			workspaceId={WORKSPACE_ID}
			taskId={TASK_ID}
			seededFromSavedDraftAt={overrides?.seededFromSavedDraftAt ?? null}
			currentFormValues={overrides?.currentFormValues ?? CURRENT_FORM_VALUES}
			onRevertToSavedTaskContent={overrides?.onRevertToSavedTaskContent ?? (() => {})}
			onSupersededCopyPromotedToCurrentDraft={overrides?.onSupersededCopyPromotedToCurrentDraft ?? (() => {})}
		/>
	);
	act(() => {
		root.render(element);
	});
}

function findButtonByLabel(label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.textContent ?? "").includes(label),
	);
	if (!button) {
		throw new Error(`找不到按钮「${label}」，当前渲染：${container.textContent}`);
	}
	return button;
}

/** 让 store 内部那串 await 全部跑完（载入 → 快照落位 → 通知订阅者）。 */
async function flushPendingStoreWork(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("草稿通知栏", () => {
	beforeEach(() => {
		localStorage.clear();
		draftsHeldByFakeServer = EMPTY_SNAPSHOT;
		mutationsSentToFakeServer.length = 0;
		shownToasts.length = 0;
		resetTaskEditDraftStoreForTests();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		resetTaskEditDraftStoreForTests();
	});

	it("没有草稿、也没有落败副本时整条不出现——不给用户凭空加一条永远为真的提示", () => {
		renderNotice();

		expect(container.textContent).toBe("");
	});

	it("这次打开用了草稿 → 说出来并给出退路，文案里带保存时间", () => {
		renderNotice({ seededFromSavedDraftAt: new Date("2026-03-05T14:32:00Z").getTime() });

		expect(container.textContent).toContain("Showing an unsaved draft");
		// 时间必须出现：没有它用户无从判断眼前这份草稿该不该采信。
		expect(container.textContent).toMatch(/saved .*\d/);
		expect(findButtonByLabel("Revert to saved content")).toBeTruthy();
	});

	it("点「Revert to saved content」把决定交回给编辑器（清草稿 + 重铺表单归 use-task-editor）", () => {
		const onRevertToSavedTaskContent = vi.fn();
		renderNotice({ seededFromSavedDraftAt: 1_000, onRevertToSavedTaskContent });

		act(() => {
			findButtonByLabel("Revert to saved content").click();
		});

		expect(onRevertToSavedTaskContent).toHaveBeenCalledTimes(1);
	});

	// 这一条同时钉住订阅：副本只可能来自服务端合并，而快照是渲染之后才异步到的。没有订阅，
	// 通知栏会永远停在「首次渲染那一刻的 0 份副本」。
	it("服务端快照到达后落败副本才出现，且只算这张卡片名下的", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{ draft: createDraft({ taskId: TASK_ID, savedAt: 10 }), supersededAt: 1, supersededBySavedAt: 30 },
				{ draft: createDraft({ taskId: TASK_ID, savedAt: 20 }), supersededAt: 1, supersededBySavedAt: 30 },
				{ draft: createDraft({ taskId: "another-task", savedAt: 10 }), supersededAt: 1, supersededBySavedAt: 30 },
			],
		};
		renderNotice();
		expect(container.textContent).toBe("");

		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();

		expect([...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Discard"))).toHaveLength(
			2,
		);
	});

	it("点「View」展开只读对照：副本正文全文可见，images 与设置只报有无差异", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 10, prompt: "另一个 origin 写的那段" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		renderNotice();

		act(() => {
			findButtonByLabel("View").click();
		});

		expect(container.textContent).toContain("另一个 origin 写的那段");
		expect(container.textContent).toContain("Images: 0");
		expect(container.textContent).toContain("Settings: same as current");
	});

	it("点「Use this one」：副本升为当前草稿、被顶下来的那份进副本，且把新草稿交回给表单", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: { [TASK_ID]: createDraft({ taskId: TASK_ID, savedAt: 30, prompt: "当前这份" }) },
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 10, prompt: "另一个 origin 那份" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		const onSupersededCopyPromotedToCurrentDraft = vi.fn();
		renderNotice({ onSupersededCopyPromotedToCurrentDraft });

		await act(async () => {
			findButtonByLabel("Use this one").click();
		});
		await flushPendingStoreWork();

		expect(mutationsSentToFakeServer).toEqual([
			{
				kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
				taskId: TASK_ID,
				supersededDraftSavedAt: 10,
			},
		]);
		// 「用这份替换当前」**不是**丢弃：被换下来的那份必须还在副本里，否则这个按钮自己就是丢字点。
		expect(draftsHeldByFakeServer.draftsByTaskId[TASK_ID]?.prompt).toBe("另一个 origin 那份");
		expect(draftsHeldByFakeServer.supersededDraftCopies.map((copy) => copy.draft.prompt)).toEqual(["当前这份"]);
		// 表单必须跟着换：只换服务端草稿的话，用户点完眼前一切照旧，与没生效没有区别。
		expect(onSupersededCopyPromotedToCurrentDraft).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "另一个 origin 那份" }),
		);
	});

	it("点「Use this one」之前先把表单里还没落盘的编辑落成当前草稿——它才是被换下来的那一份", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: { [TASK_ID]: createDraft({ taskId: TASK_ID, savedAt: 30, prompt: "上一拍去抖存下的" }) },
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 10, prompt: "另一个 origin 那份" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		renderNotice();
		// 用户又敲了一段：还没到 400ms 那一拍，prompt 甚至还没从对话框上抛到父层。
		renderNotice({ currentFormValues: { ...CURRENT_FORM_VALUES, prompt: "刚敲下、还没落盘的那段" } });

		await act(async () => {
			findButtonByLabel("Use this one").click();
		});
		await flushPendingStoreWork();

		expect(mutationsSentToFakeServer.map((mutation) => mutation.kind)).toEqual([
			"save_task_edit_draft",
			"promote_superseded_task_edit_draft_copy_to_current_draft",
		]);
		expect(draftsHeldByFakeServer.draftsByTaskId[TASK_ID]?.prompt).toBe("另一个 origin 那份");
		// 被换下来的必须是**表单里那份**，而不是服务端手上那份陈旧草稿。
		expect(draftsHeldByFakeServer.supersededDraftCopies.map((copy) => copy.draft.prompt)).toEqual([
			"刚敲下、还没落盘的那段",
		]);
	});

	it("点「Discard」只掉被点的那一份，其余副本一个不动", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 10, prompt: "要丢的" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 20, prompt: "要留的" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		renderNotice();

		await act(async () => {
			[...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Discard"))[0]?.click();
		});
		await flushPendingStoreWork();

		expect(draftsHeldByFakeServer.supersededDraftCopies.map((copy) => copy.draft.prompt)).toEqual(["要留的"]);
		expect(container.textContent).not.toBe("");
	});

	it("动作没落定时必须弹出来说：静默失败等于让用户以为他刚处理掉了", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{ draft: createDraft({ taskId: TASK_ID, savedAt: 10 }), supersededAt: 1, supersededBySavedAt: 30 },
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		renderNotice();
		// 提升一个服务端并不存在的副本：意图是幂等的，但确实没有草稿可铺——不能假装换过了。
		draftsHeldByFakeServer = { draftsByTaskId: {}, supersededDraftCopies: [] };

		await act(async () => {
			findButtonByLabel("Use this one").click();
		});
		await flushPendingStoreWork();

		expect(shownToasts).toHaveLength(1);
		expect(shownToasts[0]?.intent).toBe("danger");
	});

	// 上一条的孪生反例，也是更容易漏的那个：服务端找不到目标副本时**原样返回快照**，此时这张卡片
	// 若本来就有当前草稿，「当前草稿存在」这个判据永远为真——一份根本没变过的草稿会被当成刚提升上来的。
	it("目标副本已不在服务端、当前草稿还在时不算换成功：不重铺表单、不覆盖镜像，如实弹失败提示", async () => {
		draftsHeldByFakeServer = {
			draftsByTaskId: {},
			supersededDraftCopies: [
				{
					draft: createDraft({ taskId: TASK_ID, savedAt: 10, prompt: "另一个标签页已经处理掉的那份" }),
					supersededAt: 1,
					supersededBySavedAt: 30,
				},
			],
		};
		startLoadingWorkspaceTaskEditDrafts(WORKSPACE_ID);
		await flushPendingStoreWork();
		const onSupersededCopyPromotedToCurrentDraft = vi.fn();
		renderNotice({ onSupersededCopyPromotedToCurrentDraft });
		// 陈旧页面：副本已被另一个标签页丢弃，而当前草稿还在。
		draftsHeldByFakeServer = {
			draftsByTaskId: { [TASK_ID]: createDraft({ taskId: TASK_ID, savedAt: 30, prompt: "一个字都没换的当前草稿" }) },
			supersededDraftCopies: [],
		};

		await act(async () => {
			findButtonByLabel("Use this one").click();
		});
		await flushPendingStoreWork();

		expect(onSupersededCopyPromotedToCurrentDraft).not.toHaveBeenCalled();
		expect(localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toBeNull();
		expect(shownToasts).toHaveLength(1);
		expect(shownToasts[0]?.intent).toBe("danger");
	});
});
