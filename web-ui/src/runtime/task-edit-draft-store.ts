// 任务编辑草稿：浏览器侧的单例外部 store。真相源在服务端
// （~/.cline/kanban/workspaces/<id>/task-edit-drafts.json），localStorage 里那个老键降级成镜像。
//
// ## 为什么是外部 store 而不是 hook/context
//
// 草稿的读写全是**命令式**的：`use-task-editor.ts` 在「打开编辑」「保存」「取消」这些回调里直接调，
// 而且 `readSavedTaskEditDraft` 必须**同步**返回——它要用来给表单铺初值，慢一帧就会先渲染出空表单
// 再跳成草稿内容。所以取值走内存快照 + localStorage 镜像，服务端同步在后台异步进行。
//
// ## 三层取值：服务端快照 → 本地镜像 → 无草稿
//
// 镜像沿用升级前的键与编码（`{ drafts: { "[projectId,taskId]": draft } }`），因为升级前留在那儿的
// 那份正是迁移要采纳的种子；换编码等于把用户没保存完的编辑读不出来。
//
// ## 草稿绝不静默丢
//
// 草稿是无法重建的原创内容。所以：写入先落镜像再发服务端（服务端失败也不丢用户刚打的字）；合并冲突
// 由服务端把落败那份另存为副本（见 src/state/task-edit-draft-store.ts）；本地数据迁移后**不删**。

import {
	EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT,
	fetchWorkspaceTaskEditDrafts,
	mutateWorkspaceTaskEditDrafts,
} from "@/runtime/task-edit-drafts-query";
import type {
	RuntimeTaskEditDraft,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";
import { runtimeTaskEditDraftSchema } from "../../../src/core/api-contract";

/** 镜像里的键：升级前就是 `JSON.stringify([projectId, taskId])`，不能改。 */
function buildBrowserLocalStorageMirrorKey(workspaceId: string, taskId: string): string {
	return JSON.stringify([workspaceId, taskId]);
}

interface BrowserLocalStorageMirrorContent {
	drafts: Record<string, RuntimeTaskEditDraft>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBrowserLocalStorageMirror(): BrowserLocalStorageMirrorContent {
	const rawText = readLocalStorageItem(LocalStorageKey.TaskEditDrafts);
	if (rawText === null) {
		return { drafts: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return { drafts: {} };
	}
	if (!isRecord(parsed) || !isRecord(parsed.drafts)) {
		return { drafts: {} };
	}
	// 逐条校验、丢弃坏条目：一条被手工编辑坏的草稿不该连累其余全部草稿。
	const drafts: Record<string, RuntimeTaskEditDraft> = {};
	for (const [mirrorKey, candidate] of Object.entries(parsed.drafts)) {
		const draft = runtimeTaskEditDraftSchema.safeParse(candidate);
		if (draft.success) {
			drafts[mirrorKey] = draft.data;
		}
	}
	return { drafts };
}

function writeBrowserLocalStorageMirror(content: BrowserLocalStorageMirrorContent): void {
	if (Object.keys(content.drafts).length === 0) {
		removeLocalStorageItem(LocalStorageKey.TaskEditDrafts);
		return;
	}
	writeLocalStorageItem(LocalStorageKey.TaskEditDrafts, JSON.stringify(content));
}

/** 这台浏览器上属于某个 workspace 的全部旧草稿——迁移的种子。 */
export function readTaskEditDraftsFromBrowserLocalStorage(workspaceId: string): RuntimeTaskEditDraft[] {
	const mirror = readBrowserLocalStorageMirror();
	return Object.entries(mirror.drafts).flatMap(([mirrorKey, draft]) =>
		mirrorKey === buildBrowserLocalStorageMirrorKey(workspaceId, draft.taskId) ? [draft] : [],
	);
}

const loadedSnapshotByWorkspaceId = new Map<string, WorkspaceTaskEditDraftsSnapshot>();
const workspaceIdsWithLoadInFlightOrDone = new Set<string>();

// 镜像内容确认已经全部交到服务端手上的 workspace（送达了，或本来就无内容可送）。
//
// 为什么单独立一个集合、而不是复用「服务端快照已到」：拿到快照只说明**读**成功了，此时镜像里那些还
// 没迁移过去的草稿在服务端根本不存在。若那一刻就让快照代表「这个 workspace 的全部草稿」，
// `readSavedTaskEditDraftFromStore` 会对一张明明有草稿的卡片返回 null，而 use-task-editor 的去抖
// 自动保存会据此判定「表单等于任务本体」并发出 clearTaskEditDraft，把镜像里那份无法重建的草稿删掉。
const workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer = new Set<string>();

// 每个 workspace 一条串行链：这一串意图必须按发起顺序抵达服务端。
const mutationChainTailByWorkspaceId = new Map<string, Promise<unknown>>();

/**
 * 把一条意图排进这个 workspace 的串行链，等前面那些都落定了再发。
 *
 * 不串行化会真的丢用户已经收尾的编辑：草稿保存是**每次击键的去抖副作用**，用户点「保存」或「取消」
 * 触发的 clear 与最后一次去抖 save 几乎同时出发。两条都是 fire-and-forget，谁先摸到服务端的文件锁
 * 由网络说了算——save 迟到一步就会把刚被清掉的草稿整条写回去，下次打开这张卡片又冒出「幽灵草稿」。
 *
 * 为什么整个 workspace 一条链、而不是按 taskId 分链：mutate 的响应是**整份 workspace 快照**，会被
 * `applyServerSnapshotIfPresent` 原样装回内存。两条不同 taskId 的意图并发时，晚发早回的那份响应会
 * 把已经落定的改动整体盖回去——按 taskId 分链挡不住这种跨任务的快照倒退。草稿写入本身是去抖后的
 * 低频操作，串行不会带来可感知的延迟。
 */
function sendWorkspaceTaskEditDraftMutationInOrder(
	workspaceId: string,
	mutation: WorkspaceTaskEditDraftMutation,
): Promise<WorkspaceTaskEditDraftsSnapshot | null> {
	const previousTail = mutationChainTailByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	const sent = previousTail.then(() => mutateWorkspaceTaskEditDrafts(workspaceId, mutation));
	// 链尾只用来排队，所以要把失败吞掉：一次清除失败不该把后面每一次保存都永远卡在队列里。
	mutationChainTailByWorkspaceId.set(
		workspaceId,
		sent.catch(() => null),
	);
	return sent;
}

/**
 * 后台载入某个 workspace 的草稿，并把这台浏览器里的那份合并上去。幂等，重复调用只做一次。
 *
 * 迁移**不删**本地镜像：它既是回退备份，也仍然是首屏同步取值的来源。重复迁移在服务端是「savedAt
 * 相等即视为同一次编辑」，不会凭空造出落败副本。
 */
export function startLoadingWorkspaceTaskEditDrafts(workspaceId: string): void {
	if (workspaceIdsWithLoadInFlightOrDone.has(workspaceId)) {
		return;
	}
	workspaceIdsWithLoadInFlightOrDone.add(workspaceId);
	void (async () => {
		const snapshot = await fetchWorkspaceTaskEditDrafts(workspaceId).catch(() => null);
		if (snapshot === null) {
			// 读不出来（文件损坏等）就继续用镜像跑，并允许下次重试；**不做迁移**——把损坏当空集会再叠一份。
			workspaceIdsWithLoadInFlightOrDone.delete(workspaceId);
			return;
		}
		loadedSnapshotByWorkspaceId.set(workspaceId, snapshot);
		const draftsToMigrate = readTaskEditDraftsFromBrowserLocalStorage(workspaceId);
		if (draftsToMigrate.length === 0) {
			// 镜像本来就是空的：服务端快照已经是这个 workspace 草稿的全集。
			workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.add(workspaceId);
			return;
		}
		const mergedSnapshot = await sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, {
			kind: "merge_task_edit_drafts_migrated_from_browser_local_storage",
			drafts: draftsToMigrate,
		}).catch(() => null);
		if (mergedSnapshot === null) {
			// 合并没落定（请求失败，或服务端写不进去）。镜像那份仍只存在于本地，所以既不能宣告交接完成、
			// 也不能就此不再重试——让下一次取值把整条载入重新踢起来。
			workspaceIdsWithLoadInFlightOrDone.delete(workspaceId);
			return;
		}
		loadedSnapshotByWorkspaceId.set(workspaceId, mergedSnapshot);
		workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.add(workspaceId);
	})();
}

function applyServerSnapshotIfPresent(workspaceId: string, snapshot: WorkspaceTaskEditDraftsSnapshot | null): void {
	if (snapshot !== null) {
		loadedSnapshotByWorkspaceId.set(workspaceId, snapshot);
	}
}

/**
 * 同步读一份草稿：服务端快照已到**且镜像已交接完毕**就以它为准，否则回落本地镜像。
 *
 * 顺带把这个 workspace 的后台载入踢起来——调用方（打开编辑对话框）是最早知道「用户要用草稿了」的人。
 */
export function readSavedTaskEditDraftFromStore(workspaceId: string, taskId: string): RuntimeTaskEditDraft | null {
	startLoadingWorkspaceTaskEditDrafts(workspaceId);
	const loadedSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId);
	const draftFromServerSnapshot = loadedSnapshot?.draftsByTaskId[taskId];
	if (draftFromServerSnapshot) {
		return draftFromServerSnapshot;
	}
	if (loadedSnapshot && workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.has(workspaceId)) {
		// 镜像内容已经全部交到服务端、服务端却没有这条：那只能是被用户（在这个或另一个标签页里）主动
		// 清掉的。此时**不**回落镜像，否则刚清掉的草稿会像幽灵一样回来。
		return null;
	}
	// 交接还没落定（快照未到、迁移在途、或迁移请求失败）。镜像里那份可能是服务端**尚未见过**的内容，
	// 把它读成「无草稿」等于让下游的自动保存把无法重建的原创内容当成多余状态清掉。
	return readBrowserLocalStorageMirror().drafts[buildBrowserLocalStorageMirrorKey(workspaceId, taskId)] ?? null;
}

/** 写一份草稿：先落本地镜像（服务端失败也不丢），再发服务端。 */
export function saveTaskEditDraftToStore(workspaceId: string, draft: RuntimeTaskEditDraft): void {
	const mirror = readBrowserLocalStorageMirror();
	mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, draft.taskId)] = draft;
	writeBrowserLocalStorageMirror(mirror);

	const currentSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId) ?? EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT;
	loadedSnapshotByWorkspaceId.set(workspaceId, {
		...currentSnapshot,
		draftsByTaskId: { ...currentSnapshot.draftsByTaskId, [draft.taskId]: draft },
	});

	void sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, { kind: "save_task_edit_draft", draft })
		.then((snapshot) => applyServerSnapshotIfPresent(workspaceId, snapshot))
		.catch(() => {
			// 静默：草稿已在镜像与内存里，界面照常显示。草稿保存是每次击键的去抖副作用，
			// 网络一抖就弹 toast 只会刷屏。
		});
}

/** 用户保存或放弃了这次编辑。落败副本**不动**——那是另一个 origin 里还没被看过的内容。 */
export function clearTaskEditDraftInStore(workspaceId: string, taskId: string): void {
	const mirror = readBrowserLocalStorageMirror();
	delete mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, taskId)];
	writeBrowserLocalStorageMirror(mirror);

	const currentSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId);
	if (currentSnapshot) {
		const { [taskId]: _cleared, ...remainingDrafts } = currentSnapshot.draftsByTaskId;
		loadedSnapshotByWorkspaceId.set(workspaceId, { ...currentSnapshot, draftsByTaskId: remainingDrafts });
	}

	void sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, { kind: "clear_task_edit_draft", taskId })
		.then((snapshot) => applyServerSnapshotIfPresent(workspaceId, snapshot))
		.catch(() => {
			// 静默：清除失败最坏是草稿多留一会儿，下次保存/清除会再试。
		});
}

/**
 * 任务被删除：草稿与它的全部落败副本一起清掉。
 *
 * 与 `clearTaskEditDraftInStore` 是两件事：那条是「这次编辑收尾了」，这条是「这个任务不存在了」——
 * 任务没了之后，留着的草稿再也没有可以认领它的地方，只会变成永远看不见的垃圾。
 */
export function discardAllTaskEditDraftsForDeletedTask(workspaceId: string, taskId: string): void {
	const mirror = readBrowserLocalStorageMirror();
	delete mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, taskId)];
	writeBrowserLocalStorageMirror(mirror);

	const currentSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId);
	if (currentSnapshot) {
		const { [taskId]: _discarded, ...remainingDrafts } = currentSnapshot.draftsByTaskId;
		loadedSnapshotByWorkspaceId.set(workspaceId, {
			draftsByTaskId: remainingDrafts,
			supersededDraftCopies: currentSnapshot.supersededDraftCopies.filter((copy) => copy.draft.taskId !== taskId),
		});
	}

	void sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, {
		kind: "discard_all_task_edit_drafts_for_deleted_task",
		taskId,
	})
		.then((snapshot) => applyServerSnapshotIfPresent(workspaceId, snapshot))
		.catch(() => {
			// 静默：清理失败只是留下一条孤儿草稿，不影响任何用户可见行为。
		});
}

/** 仅供测试：把单例 store 复位，避免用例之间互相串味。 */
export function resetTaskEditDraftStoreForTests(): void {
	loadedSnapshotByWorkspaceId.clear();
	workspaceIdsWithLoadInFlightOrDone.clear();
	workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.clear();
	mutationChainTailByWorkspaceId.clear();
}
