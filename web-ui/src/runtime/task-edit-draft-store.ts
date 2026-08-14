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
	RuntimeSupersededTaskEditDraftCopy,
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

// 订阅者。草稿本身是命令式读写（表单初值必须同步铺上，见文件头），不需要订阅；但**落败副本**需要：
// 它只可能来自服务端合并，而服务端快照是打开对话框之后才异步到的。没有订阅，通知栏就会永远停在
// 「首次渲染那一刻的 0 份副本」，用户永远看不到另一个 origin 里那份还没认领的草稿——数据没丢，
// 但效果等同于丢，而那正是这一整块要修的东西。
const storeListeners = new Set<() => void>();

function setLoadedWorkspaceSnapshot(workspaceId: string, snapshot: WorkspaceTaskEditDraftsSnapshot): void {
	loadedSnapshotByWorkspaceId.set(workspaceId, snapshot);
	for (const listener of storeListeners) {
		listener();
	}
}

export function subscribeToTaskEditDraftStore(listener: () => void): () => void {
	storeListeners.add(listener);
	return () => {
		storeListeners.delete(listener);
	};
}

// 镜像内容确认已经全部交到服务端手上的 workspace（送达了，或本来就无内容可送）。
//
// 为什么单独立一个集合、而不是复用「服务端快照已到」：拿到快照只说明**读**成功了，此时镜像里那些还
// 没迁移过去的草稿在服务端根本不存在。若那一刻就让快照代表「这个 workspace 的全部草稿」，
// `readSavedTaskEditDraftFromStore` 会对一张明明有草稿的卡片返回 null，而 use-task-editor 的去抖
// 自动保存会据此判定「表单等于任务本体」并发出 clearTaskEditDraft，把镜像里那份无法重建的草稿删掉。
const workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer = new Set<string>();

/**
 * 服务端快照是否已经取代本地镜像，成为这个 workspace 草稿的权威来源。
 *
 * 给「表单同步铺、快照迟到」那条链路用（见 use-task-editor.ts 的重铺）：读到一份草稿还不够，调用方
 * 必须能分辨「这是权威内容」与「这只是镜像里那份、可能已经在服务端合并里落败的内容」。
 */
export function hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror(
	workspaceId: string,
): boolean {
	return (
		loadedSnapshotByWorkspaceId.has(workspaceId) &&
		workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.has(workspaceId)
	);
}

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
		const draftsToMigrate = readTaskEditDraftsFromBrowserLocalStorage(workspaceId);
		if (draftsToMigrate.length === 0) {
			// 镜像本来就是空的：服务端快照已经是这个 workspace 草稿的全集。
			// 交接标记必须在通知订阅者**之前**立起来：订阅者据它判断「现在读到的是不是权威内容」，
			// 而这之后不会再有第二次通知——晚一拍等于永远读不到权威状态。
			workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.add(workspaceId);
			setLoadedWorkspaceSnapshot(workspaceId, snapshot);
			return;
		}
		setLoadedWorkspaceSnapshot(workspaceId, snapshot);
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
		// 同上：先立交接标记，再通知订阅者。
		workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.add(workspaceId);
		setLoadedWorkspaceSnapshot(workspaceId, mergedSnapshot);
	})();
}

function applyServerSnapshotIfPresent(workspaceId: string, snapshot: WorkspaceTaskEditDraftsSnapshot | null): void {
	if (snapshot !== null) {
		setLoadedWorkspaceSnapshot(workspaceId, snapshot);
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

/** 先把草稿落到本地镜像与内存快照上——服务端那一步失败也不丢用户刚打的字。 */
function writeTaskEditDraftToBrowserLocalStorageMirrorAndMemory(
	workspaceId: string,
	draft: RuntimeTaskEditDraft,
): void {
	const mirror = readBrowserLocalStorageMirror();
	mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, draft.taskId)] = draft;
	writeBrowserLocalStorageMirror(mirror);

	const currentSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId) ?? EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT;
	setLoadedWorkspaceSnapshot(workspaceId, {
		...currentSnapshot,
		draftsByTaskId: { ...currentSnapshot.draftsByTaskId, [draft.taskId]: draft },
	});
}

/** 写一份草稿：先落本地镜像（服务端失败也不丢），再发服务端。 */
export function saveTaskEditDraftToStore(workspaceId: string, draft: RuntimeTaskEditDraft): void {
	writeTaskEditDraftToBrowserLocalStorageMirrorAndMemory(workspaceId, draft);

	void sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, { kind: "save_task_edit_draft", draft })
		.then((snapshot) => applyServerSnapshotIfPresent(workspaceId, snapshot))
		.catch(() => {
			// 静默：草稿已在镜像与内存里，界面照常显示。草稿保存是每次击键的去抖副作用，
			// 网络一抖就弹 toast 只会刷屏。
		});
}

/**
 * 同上，但**等服务端收下**再返回。返回 false = 这次没落定。
 *
 * 与去抖保存的差别只在于「等不等」：那条是每次击键的副作用，等一次往返毫无意义；这条是「用这份替换
 * 当前」按下去之前的最后一次冲刷。服务端把「当前草稿」转存成副本时用的是**它手上那份**，所以表单里
 * 那些还没落盘的编辑必须先真的送达；没送达就发 promote，被留存下来的会是一份陈旧内容，而用户刚敲的
 * 字随着表单被重铺一并消失——恰恰是这条动作自己的契约（「被换下来的必须留存」）要防的事。
 */
export async function saveTaskEditDraftToStoreWaitingForServerAcknowledgement(
	workspaceId: string,
	draft: RuntimeTaskEditDraft,
): Promise<boolean> {
	writeTaskEditDraftToBrowserLocalStorageMirrorAndMemory(workspaceId, draft);

	const snapshot = await sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, {
		kind: "save_task_edit_draft",
		draft,
	}).catch(() => null);
	if (snapshot === null) {
		return false;
	}
	setLoadedWorkspaceSnapshot(workspaceId, snapshot);
	return true;
}

/** 用户保存或放弃了这次编辑。落败副本**不动**——那是另一个 origin 里还没被看过的内容。 */
export function clearTaskEditDraftInStore(workspaceId: string, taskId: string): void {
	const mirror = readBrowserLocalStorageMirror();
	delete mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, taskId)];
	writeBrowserLocalStorageMirror(mirror);

	const currentSnapshot = loadedSnapshotByWorkspaceId.get(workspaceId);
	if (currentSnapshot) {
		const { [taskId]: _cleared, ...remainingDrafts } = currentSnapshot.draftsByTaskId;
		setLoadedWorkspaceSnapshot(workspaceId, { ...currentSnapshot, draftsByTaskId: remainingDrafts });
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
		setLoadedWorkspaceSnapshot(workspaceId, {
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

// useSyncExternalStore 要求 getSnapshot 在「没变化」时返回引用相等的值，否则每次渲染都被判定为变化、
// 直接进死循环。按 taskId 过滤天然每次产生新数组，所以这里按「源数组的引用」缓存过滤结果。
const EMPTY_SUPERSEDED_DRAFT_COPIES: RuntimeSupersededTaskEditDraftCopy[] = [];
const supersededDraftCopySelectionCache = new Map<
	string,
	{ selectedFromSourceArray: RuntimeSupersededTaskEditDraftCopy[]; selected: RuntimeSupersededTaskEditDraftCopy[] }
>();

/**
 * 某个任务名下、合并时落选的那些草稿副本。
 *
 * **纯函数、无副作用**：它是 useSyncExternalStore 的 getSnapshot，不能在这里踢后台载入。载入由
 * `readSavedTaskEditDraftFromStore`（打开编辑对话框时必调）负责触发，快照到达后经订阅通知回来。
 */
export function readSupersededTaskEditDraftCopiesFromStore(
	workspaceId: string,
	taskId: string,
): RuntimeSupersededTaskEditDraftCopy[] {
	const sourceArray = loadedSnapshotByWorkspaceId.get(workspaceId)?.supersededDraftCopies;
	if (sourceArray === undefined) {
		return EMPTY_SUPERSEDED_DRAFT_COPIES;
	}
	const cacheKey = `${workspaceId}\u0000${taskId}`;
	const cached = supersededDraftCopySelectionCache.get(cacheKey);
	if (cached && cached.selectedFromSourceArray === sourceArray) {
		return cached.selected;
	}
	const matching = sourceArray.filter((copy) => copy.draft.taskId === taskId);
	// 空结果一律收敛到同一个常量数组：否则「这个任务从来没有副本」这个最常见的情形每次都返回新的 []。
	const selected = matching.length === 0 ? EMPTY_SUPERSEDED_DRAFT_COPIES : matching;
	supersededDraftCopySelectionCache.set(cacheKey, { selectedFromSourceArray: sourceArray, selected });
	return selected;
}

/**
 * 这两条意图**不做本地乐观更新**，等服务端响应回来再把快照装上。
 *
 * 与草稿保存刻意相反：保存是每次击键的去抖副作用，本地必须立刻可见；而这两条是用户显式点一次按钮的
 * 低频操作，等一次往返毫无感知。真正的理由在正确性上——「当前草稿降为副本 + 该副本升为当前」有一条
 * 次序红线（见 src/state/task-edit-draft-store.ts 的 withSupersededDraftCopyPromotedToCurrentDraft），
 * 在浏览器里照抄一份等于把那条红线维护两遍，抄错的后果恰恰是这两条意图本身要防的丢字。
 *
 * 返回 false = 这次没落定（请求失败 / 服务端写不进去）。调用方必须说出来：静默失败是这整条工作流要
 * 根除的东西。
 */
export async function discardSupersededTaskEditDraftCopy(
	workspaceId: string,
	taskId: string,
	supersededDraftSavedAt: number,
): Promise<boolean> {
	const snapshot = await sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, {
		kind: "discard_superseded_task_edit_draft_copy",
		taskId,
		supersededDraftSavedAt,
	}).catch(() => null);
	if (snapshot === null) {
		return false;
	}
	setLoadedWorkspaceSnapshot(workspaceId, snapshot);
	return true;
}

/**
 * 把某一份落败副本升回当前草稿。被顶下来的那份当前草稿由服务端转存为副本，**不是**丢弃。
 *
 * 返回被提升上来的那份草稿（而不是一个 boolean）：调用方必须拿它去重铺编辑表单。表单值活在
 * `use-task-editor` 的 state 里，只换服务端草稿的话，用户点完「用这份替换当前」眼前一切照旧，
 * 得刷新或重开对话框才看得到——那和没生效没有区别。null = 这次没落定。
 */
export async function promoteSupersededTaskEditDraftCopyToCurrentDraft(
	workspaceId: string,
	taskId: string,
	supersededDraftSavedAt: number,
): Promise<RuntimeTaskEditDraft | null> {
	const snapshot = await sendWorkspaceTaskEditDraftMutationInOrder(workspaceId, {
		kind: "promote_superseded_task_edit_draft_copy_to_current_draft",
		taskId,
		supersededDraftSavedAt,
	}).catch(() => null);
	if (snapshot === null) {
		return null;
	}
	setLoadedWorkspaceSnapshot(workspaceId, snapshot);
	const currentDraftAfterMutation = snapshot.draftsByTaskId[taskId];
	// 判据是「当前草稿**确实变成了**被点的那一份」，而不是「当前草稿存在」。服务端找不到目标副本时
	// 原样返回快照（提升是幂等的，找不到不报错）——此刻这张卡片若本来就有当前草稿，「存在」这个判据
	// 就永远为真，于是一份**根本没变过**的草稿会被当成刚提升上来的：不弹失败提示、还拿它重铺表单并
	// 覆盖镜像。常见触发是陈旧页面：目标副本已被另一个标签页丢弃或提升过。
	//
	// 用 savedAt 认身份：被提升的副本升为当前草稿时 savedAt 原样带着，所以「当前草稿的 savedAt 等于
	// 被点那一份」既涵盖这次真的换成了，也涵盖另一个标签页早就把它换上去了的幂等成功——两者对用户
	// 是同一件事：他要的那份此刻就是当前草稿。
	if (currentDraftAfterMutation === undefined || currentDraftAfterMutation.savedAt !== supersededDraftSavedAt) {
		// 目标副本已经不在了（被丢弃 / 从来不存在），当前草稿一个字都没换。如实返回 null，
		// 让调用方说出来而不是假装换过了。
		return null;
	}
	const promotedDraft = currentDraftAfterMutation;
	// 镜像也要跟上：它是刷新后首屏同步取值的来源，不更新的话下一次打开这张卡片会拿回被换下来的旧草稿。
	const mirror = readBrowserLocalStorageMirror();
	mirror.drafts[buildBrowserLocalStorageMirrorKey(workspaceId, taskId)] = promotedDraft;
	writeBrowserLocalStorageMirror(mirror);
	return promotedDraft;
}

/** 仅供测试：把单例 store 复位，避免用例之间互相串味。 */
export function resetTaskEditDraftStoreForTests(): void {
	loadedSnapshotByWorkspaceId.clear();
	workspaceIdsWithLoadInFlightOrDone.clear();
	workspaceIdsWithBrowserLocalStorageMirrorHandedOverToServer.clear();
	mutationChainTailByWorkspaceId.clear();
	supersededDraftCopySelectionCache.clear();
	storeListeners.clear();
}
