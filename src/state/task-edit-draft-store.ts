// 任务编辑草稿的**服务端**真相源。
//
// 草稿是用户打了字但还没保存的那一份：正文 + 内联 base64 图片 + 整套 agent / 权限 / worktree 设置。
// 它**无法重建**——判错一次就永远拿不回来了，所以这个模块里所有取舍都偏向「宁可多留一份」。
//
// ## 落点：每个 workspace 一份独立文件，board.json 一个字节都不加
//
//   ~/.cline/kanban/workspaces/<workspaceId>/task-edit-drafts.json
//
// 与 prompt library 同一个理由（见 prompt-library-store.ts 顶部）：草稿带内联 base64 图片，而
// board.json 是每次看板改动都整体读写 + 广播的最热路径。
//
// ## 为什么写的是意图
//
// 多个标签页会同时编辑同一个看板。整份 PUT 的 last-write-wins 会让「另一个标签页刚存的草稿」被静默
// 抹掉，而那正是最不能丢的东西。这里把意图送到服务端，在文件锁内读-改-写。
//
// ## 生命周期
//
// 草稿只在两种情况下消失：用户自己保存/放弃了这次编辑（clear_task_edit_draft），或任务被删除
// （discard_all_task_edit_drafts_for_deleted_task）。这与 prompt library 刻意相反——prompt 是用户
// 攒的**资产**，不该随任务删除而毁；草稿是某个任务的**未完成编辑**，任务没了它就再也无法认领。

import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
	type RuntimeSupersededTaskEditDraftCopy,
	type RuntimeTaskEditDraft,
	runtimeSupersededTaskEditDraftCopySchema,
	runtimeTaskEditDraftSchema,
	type WorkspaceTaskEditDraftMutation,
	type WorkspaceTaskEditDraftsSnapshot,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

const TASK_EDIT_DRAFTS_FILENAME = "task-edit-drafts.json";

export const EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT: WorkspaceTaskEditDraftsSnapshot = {
	draftsByTaskId: {},
	supersededDraftCopies: [],
};

export function getWorkspaceTaskEditDraftsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), TASK_EDIT_DRAFTS_FILENAME);
}

// 逐条校验、丢弃坏条目而不是让整份文件读失败：一条被手工编辑坏的草稿不该连累其余全部草稿。
function parseDraftsByTaskId(value: unknown): Record<string, RuntimeTaskEditDraft> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const drafts: Record<string, RuntimeTaskEditDraft> = {};
	for (const [taskId, candidate] of Object.entries(value as Record<string, unknown>)) {
		const parsed = runtimeTaskEditDraftSchema.safeParse(candidate);
		if (parsed.success) {
			drafts[taskId] = parsed.data;
		}
	}
	return drafts;
}

function parseSupersededDraftCopies(value: unknown): RuntimeSupersededTaskEditDraftCopy[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((candidate) => {
		const parsed = runtimeSupersededTaskEditDraftCopySchema.safeParse(candidate);
		return parsed.success ? [parsed.data] : [];
	});
}

// 「文件不存在」与「文件在那儿但这次读不出来」对读路径同样是空草稿集，对**写**路径则天差地别：
// 拿降级出来的空快照去原子覆盖那份损坏文件，等于把一个还能人工修复的状态变成不可逆的草稿丢失。
type TaskEditDraftsFileReadOutcome =
	| { status: "absent" }
	| { status: "parsed"; parsedContent: unknown }
	| { status: "present_but_unreadable" };

function isFileNotFoundFailure(failure: unknown): boolean {
	return (
		typeof failure === "object" &&
		failure !== null &&
		"code" in failure &&
		(failure as NodeJS.ErrnoException).code === "ENOENT"
	);
}

async function readTaskEditDraftsFileDistinguishingAbsentFromUnreadable(
	path: string,
): Promise<TaskEditDraftsFileReadOutcome> {
	let fileText: string;
	try {
		fileText = await readFile(path, "utf8");
	} catch (readFailure) {
		// 只有 ENOENT 才是「首次使用」。EACCES / EISDIR / EIO 等都意味着文件就在那儿、只是这次读不到。
		return isFileNotFoundFailure(readFailure) ? { status: "absent" } : { status: "present_but_unreadable" };
	}
	try {
		return { status: "parsed", parsedContent: JSON.parse(fileText) };
	} catch {
		return { status: "present_but_unreadable" };
	}
}

interface TaskEditDraftsReadResult {
	snapshot: WorkspaceTaskEditDraftsSnapshot;
	filePresentButUnreadable: boolean;
}

async function readWorkspaceTaskEditDraftsWithFileReadability(workspaceId: string): Promise<TaskEditDraftsReadResult> {
	const outcome = await readTaskEditDraftsFileDistinguishingAbsentFromUnreadable(
		getWorkspaceTaskEditDraftsPath(workspaceId),
	);
	const record =
		outcome.status === "parsed" && typeof outcome.parsedContent === "object" && outcome.parsedContent !== null
			? (outcome.parsedContent as Record<string, unknown>)
			: {};
	return {
		snapshot: {
			draftsByTaskId: parseDraftsByTaskId(record.draftsByTaskId),
			supersededDraftCopies: parseSupersededDraftCopies(record.supersededDraftCopies),
		},
		filePresentButUnreadable: outcome.status === "present_but_unreadable",
	};
}

// 读路径把「不存在」与「读坏了」一起降级成空集：空集是安全默认值，而把「读不出来」抛给调用方只会让
// 编辑对话框整个打不开。只有写路径需要分辨两者。
export async function readWorkspaceTaskEditDraftsSnapshot(
	workspaceId: string,
): Promise<WorkspaceTaskEditDraftsSnapshot> {
	return (await readWorkspaceTaskEditDraftsWithFileReadability(workspaceId)).snapshot;
}

function withDraftRemoved(snapshot: WorkspaceTaskEditDraftsSnapshot, taskId: string): WorkspaceTaskEditDraftsSnapshot {
	if (snapshot.draftsByTaskId[taskId] === undefined) {
		return snapshot;
	}
	const { [taskId]: _removed, ...remainingDrafts } = snapshot.draftsByTaskId;
	return { ...snapshot, draftsByTaskId: remainingDrafts };
}

/**
 * 这份落败草稿是不是之前某次迁移已经存过的那一份。
 *
 * 认定标准与合并本身保持一致：同一个 taskId + 同一个 `savedAt` 就是同一次编辑（见下面那条「savedAt
 * 完全相等视为同一次编辑」）。不逐字段深比正文：草稿带内联 base64 图片，每次迁移都做一遍深比较不
 * 划算，而「同 taskId 同 savedAt 却是两次不同编辑」在这个模块的语义里本来就不成立。
 */
function hasAlreadyStoredSupersededDraftCopy(
	supersededDraftCopies: RuntimeSupersededTaskEditDraftCopy[],
	losingDraft: RuntimeTaskEditDraft,
): boolean {
	return supersededDraftCopies.some(
		(copy) => copy.draft.taskId === losingDraft.taskId && copy.draft.savedAt === losingDraft.savedAt,
	);
}

/**
 * 把一份来自浏览器 localStorage 的草稿合并进快照。
 *
 * 按 taskId 比对，`savedAt` 新的胜出——但**落败的那份不丢**，而是连同「什么时候、被谁顶下来的」一起
 * 存进 `supersededDraftCopies`。草稿是原创内容，比较 savedAt 只是启发式（两个 origin 的系统时钟可能
 * 有偏差、用户也可能在旧的那份里写了更重要的东西），凭一个时间戳就静默销毁另一半不可接受。
 *
 * 两份 `savedAt` 完全相等时视为同一次编辑的两个副本，保留现有那份、不产生落败副本——否则每打开一个
 * 新 origin 就会凭空多出一份一模一样的「落败草稿」。
 *
 * 同理，**同一份落败草稿只存一次**。浏览器那边刻意不删本地镜像（它是草稿的回退备份），于是每次页面
 * 加载都会把同一份旧镜像重新作为迁移载荷送上来；只要服务端此刻的草稿比它新，不去重就会每加载一次
 * 追加一份一模一样的落败副本，草稿文件随刷新次数线性膨胀，而这些副本目前在界面上还看不到，用户既
 * 发现不了也清不掉。去重放在服务端而不是靠浏览器加个「已迁移」标记：标记是 per-origin 的，挡不住
 * 另一个 origin／另一台浏览器重发同一份镜像；而且一旦让标记来兜正确性，标记还在但服务端草稿文件被
 * 换掉／清掉时，镜像里那份无法重建的内容就再也送不上去了。
 */
function withBrowserLocalStorageDraftMerged(
	snapshot: WorkspaceTaskEditDraftsSnapshot,
	incomingDraft: RuntimeTaskEditDraft,
	nowEpochMs: number,
): WorkspaceTaskEditDraftsSnapshot {
	const existingDraft = snapshot.draftsByTaskId[incomingDraft.taskId];
	if (!existingDraft) {
		return {
			...snapshot,
			draftsByTaskId: { ...snapshot.draftsByTaskId, [incomingDraft.taskId]: incomingDraft },
		};
	}
	if (existingDraft.savedAt === incomingDraft.savedAt) {
		return snapshot;
	}
	const winningDraft = incomingDraft.savedAt > existingDraft.savedAt ? incomingDraft : existingDraft;
	const losingDraft = winningDraft === incomingDraft ? existingDraft : incomingDraft;
	if (hasAlreadyStoredSupersededDraftCopy(snapshot.supersededDraftCopies, losingDraft)) {
		// 这份落败草稿早就留存过了。若胜出的还是服务端现有那份，整份快照一个字节都没变——原样返回，
		// 让上层跳过写盘，别让每次页面加载都白写一遍草稿文件。
		return winningDraft === existingDraft
			? snapshot
			: { ...snapshot, draftsByTaskId: { ...snapshot.draftsByTaskId, [incomingDraft.taskId]: winningDraft } };
	}
	return {
		draftsByTaskId: { ...snapshot.draftsByTaskId, [incomingDraft.taskId]: winningDraft },
		supersededDraftCopies: [
			...snapshot.supersededDraftCopies,
			{ draft: losingDraft, supersededAt: nowEpochMs, supersededBySavedAt: winningDraft.savedAt },
		],
	};
}

/** 把一条意图应用到快照上。纯函数——并发合并的正确性来自调用方持锁重读，这里只负责语义。 */
export function applyWorkspaceTaskEditDraftMutation(
	snapshot: WorkspaceTaskEditDraftsSnapshot,
	mutation: WorkspaceTaskEditDraftMutation,
	nowEpochMs: number,
): WorkspaceTaskEditDraftsSnapshot {
	if (mutation.kind === "save_task_edit_draft") {
		return {
			...snapshot,
			draftsByTaskId: { ...snapshot.draftsByTaskId, [mutation.draft.taskId]: mutation.draft },
		};
	}
	if (mutation.kind === "clear_task_edit_draft") {
		// 只清当前草稿，**不动**落败副本：用户保存了这次编辑，不代表他放弃了另一个 origin 里那份还没
		// 看过的内容。副本要由用户自己认领或丢弃。
		return withDraftRemoved(snapshot, mutation.taskId);
	}
	if (mutation.kind === "discard_all_task_edit_drafts_for_deleted_task") {
		// 任务被删除：草稿与落败副本都再无认领的可能，一起清掉。
		const withoutDraft = withDraftRemoved(snapshot, mutation.taskId);
		const remainingCopies = withoutDraft.supersededDraftCopies.filter(
			(copy) => copy.draft.taskId !== mutation.taskId,
		);
		if (remainingCopies.length === withoutDraft.supersededDraftCopies.length) {
			return withoutDraft;
		}
		return { ...withoutDraft, supersededDraftCopies: remainingCopies };
	}
	let merged = snapshot;
	for (const incomingDraft of mutation.drafts) {
		merged = withBrowserLocalStorageDraftMerged(merged, incomingDraft, nowEpochMs);
	}
	return merged;
}

// 覆盖一份读不出来的草稿文件之前，先把原始字节整体搬到旁路留存。理由与 prompt-library-store 相同：
// 损坏的文件里通常一个字节的正文都没少，人工还救得回来，被空快照盖掉就真没了。搬移失败则让错误抛出去、
// 这次写入告吹——宁可写失败（用户还能重试），也不在没留下副本时覆盖损坏文件。
async function quarantineUnreadableTaskEditDraftsFileBeforeOverwrite(path: string, nowEpochMs: number): Promise<void> {
	// 带 uuid 后缀，避免同一毫秒内的第二次隔离把上一份留存覆盖掉——留存文件本身也是用户资产。
	await rename(path, `${path}.unreadable-quarantined-before-overwrite-${nowEpochMs}-${randomUUID()}.json`);
}

/**
 * 在文件锁内读-改-写地应用一条意图。
 *
 * 只涉及**一份**文件，所以不像 prompt library 那样有跨文件写序问题：单份 writeJsonFileAtomic 天然原子。
 */
export async function mutateWorkspaceTaskEditDrafts(
	workspaceId: string,
	mutation: WorkspaceTaskEditDraftMutation,
	nowEpochMs: number = Date.now(),
): Promise<WorkspaceTaskEditDraftsSnapshot> {
	const draftsPath = getWorkspaceTaskEditDraftsPath(workspaceId);
	return await lockedFileSystem.withLocks([{ path: draftsPath, type: "file" }], async () => {
		// 必须在锁内重读：锁外读到的快照可能已被另一个标签页改过，基于它写回就是静默覆盖。
		const currentRead = await readWorkspaceTaskEditDraftsWithFileReadability(workspaceId);
		const next = applyWorkspaceTaskEditDraftMutation(currentRead.snapshot, mutation, nowEpochMs);
		if (next === currentRead.snapshot) {
			return next;
		}
		if (currentRead.filePresentButUnreadable) {
			await quarantineUnreadableTaskEditDraftsFileBeforeOverwrite(draftsPath, nowEpochMs);
		}
		await lockedFileSystem.writeJsonFileAtomic(draftsPath, next, { lock: null });
		return next;
	});
}
