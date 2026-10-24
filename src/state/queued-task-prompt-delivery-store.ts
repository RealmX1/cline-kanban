// 排队 Prompt 投递的 durable 真相源。
//
// 整套特性的语义（状态机、三条触发源、门控、失败路由、重启跨越）的单一出处是
// .plan/docs/queued-task-prompt-delivery-semantics.md；本文件头注只讲持久化这一段。
//
// ## 落点：每个 workspace 一份独立文件
//
//   ~/.cline/kanban/workspaces/<workspaceId>/queued-task-prompt-deliveries.json
//
// 三个已排除的落点，各有硬理由：
//
//   - **board.json** —— prompt-library-store 的头注已经裁定过同一件事：实测最大的一份 board.json 已达
//     1,029,751 字节 / 258 张卡，其中 73% 是 prompt 正文，而它是每次看板改动都整体读写 + 广播的最热路径。
//     队列条目同样携带完整正文，且以**机器节拍**变更（认领 / 交付 / 落定），比看板改动频繁得多。
//   - **sessions.json** —— 只在 graceful shutdown 与客户端 saveState 落盘，崩溃即丢；而「活过重启」正是
//     本特性的核心承诺。何况每次边沿往上面写要重写 1.6 MB 并抢全局锁。
//   - **task-message-injections.json** —— 那是**已发布的跨仓契约**（RVF），核心不变量是「唯一非终态必然
//     有界收敛」。一条排队 prompt 可以合法地等几个小时，写进去等于亲手打破该不变量，RVF 的启动清扫会
//     把它当成失败记录扫掉。两者分开，只用 dispatchIdempotencyKey 关联。
//
// ## 例外：程序化排队投递在账本里**另有**一条回执
//
// `kanban task message --deliver-when-agent-idle`（例：RVF 决策点边界标记）的调用方要的是跨仓契约那套四态回执，
// 所以这种条目除了住在本文件，还在注入账本里有一条同 key 的 pending 记录（programmaticInjectionLedgerReceiptLink）。
// 上面那条「不变量会被打破」靠两件事守住：调用方必须给等待上限（账本的有界收敛上界随之变成「截止 + 终端投递
// 最坏预算」，启动清扫按它判超期），以及条目落定时把结论镜像回账本——镜像挂在下面唯一的持锁读-改-写上
// （updateWorkspaceQueuedTaskPromptDeliveriesUnderLock），任何一条落定路径都逃不掉。镜像的 IO 在
// mirror-queued-programmatic-injection-outcomes-into-injection-ledger.ts，程序化入队在
// enqueue-agent-idle-gated-programmatic-injection-into-prompt-delivery-queue.ts（复用这里导出的变换与写盘咽喉）。
//
// ## 写操作是「意图」而不是整份 PUT
//
// 同一份队列会被多个标签页与运行时自己（dispatcher）并发写。整份 PUT 的 last-write-wins 会让
// 「另一个标签页刚排的那条」被静默抹掉。意图送到服务端、在**文件锁内**读-改-写，并发写自然合并。
//
// ## 生命周期：任务离开看板即丢弃
//
// 与 prompt library 相反（那是用户资产，不随任务删除而删）。队列条目是**待执行的机器动作**，
// 目标任务都不在了还留着它没有任何意义，只会在任务被恢复时突然发射。清理接线在
// src/server/queued-task-prompt-delivery-dispatcher.ts 的 discardQueuesForTasksRemovedFromBoard。

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	type QueuedTaskPromptDeliveryEntry,
	type QueuedTaskPromptDeliveryMutation,
	queuedTaskPromptDeliveryEntrySchema,
	type RuntimeTaskSessionSummary,
	type WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import {
	isQueuedTaskPromptDeliveryAwaitingDispatch,
	QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
} from "../core/queued-task-prompt-delivery-dispatch-eligibility";
import { collectQueuedTaskPromptDeliveryChainFromHead } from "../core/queued-task-prompt-delivery-merge";
import type { QueuedTaskPromptDeliverySettlement } from "../core/queued-task-prompt-delivery-outcome-routing";
import { resolveNativeIndependentUserTurnPreflightRestartRecovery } from "../core/queued-task-prompt-native-independent-user-turn-query-recovery";
import {
	resolveRvfCloseoutCompactionAwareQueuedPromptRecovery,
	settleQueuedRvfCloseoutFromExistingSubmission,
} from "../core/rvf-closeout-compaction-aware-queued-prompt-recovery";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	type TaskMessageInjectionRecord,
} from "../core/task-message-injection-ledger";
import { lockedFileSystem } from "../fs/locked-file-system";
import { mirrorProgrammaticInjectionQueueTransitionsIntoInjectionLedger } from "./mirror-queued-programmatic-injection-outcomes-into-injection-ledger";
import { getThisRuntimeProcessInstanceId } from "./runtime-process-instance-heartbeat-registry";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "./workspace-state";

const QUEUED_TASK_PROMPT_DELIVERIES_FILENAME = "queued-task-prompt-deliveries.json";

// 上限。超出时从**队尾**裁而不是队首：队首是马上要发的那条，裁掉它等于把用户最先排的意图丢了。
export const MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK = 20;
export const MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE = 200;

// 终态条目（delivered / failed / cancelled / expired）保留多久供 UI 展示后再裁掉。
// 与排队意图的保质期同为 24h 不是巧合：两者都是「隔夜还想看见、隔周不必再看」这一条直觉。
export const SETTLED_QUEUED_TASK_PROMPT_DELIVERY_RETENTION_MS = QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS;

// 有界重试：同一条意图最多真正交给 transport 三次。上限不是防抖，是防「一条注定发不出去的 prompt
// 在每一个 turn 边沿都试一次」——那会把用户的队列变成一台每轮报一次错的机器。
export const MAX_QUEUED_TASK_PROMPT_DELIVERY_ATTEMPTS = 3;

const NON_TERMINAL_QUEUED_TASK_PROMPT_DELIVERY_STATES = new Set<QueuedTaskPromptDeliveryEntry["deliveryState"]>([
	"queued",
	"claimed_for_dispatch",
	"handed_to_transport",
]);

export function isNonTerminalQueuedTaskPromptDeliveryState(
	state: QueuedTaskPromptDeliveryEntry["deliveryState"],
): boolean {
	return NON_TERMINAL_QUEUED_TASK_PROMPT_DELIVERY_STATES.has(state);
}

// 程序化排队投递（带注入账本回执）。与人排的条目三处语义不同，见 api-contract.ts 该字段的注释。
export function isQueuedTaskPromptDeliveryProgrammaticInjection(entry: QueuedTaskPromptDeliveryEntry): boolean {
	return entry.programmaticInjectionLedgerReceiptLink != null;
}

// 路径守卫：workspaceId 会一路走到 join()，一个 "../.." 就能把写操作带出 workspaces 根。
// 形态抄 restoration-deferred-harness-generated-prompt-store.ts。
export function getWorkspaceQueuedTaskPromptDeliveriesPath(workspaceId: string): string {
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing queued task prompt delivery access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, QUEUED_TASK_PROMPT_DELIVERIES_FILENAME);
}

// 「文件不存在」与「文件在那儿但这次读不出来」对**读**路径同样是空队列，对**写**路径则天差地别：
// 拿降级空快照去原子覆盖那份损坏文件，等于把一个还能人工修复的状态变成不可逆的丢失。
type QueuedTaskPromptDeliveryFileReadOutcome =
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

async function readQueuedTaskPromptDeliveryFileDistinguishingAbsentFromUnreadable(
	path: string,
): Promise<QueuedTaskPromptDeliveryFileReadOutcome> {
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

// 逐条 safeParse、丢弃坏条目而不是让整份队列读失败：一条被手工编辑坏的记录不该连累其余全部排队意图。
// 这也是契约里「v1 之后新增字段一律 optional」那条规约的成因——加一个必填字段会让所有旧条目在这里
// 集体消失，表现就是用户排好的队被静默清空。
function parseQueuedTaskPromptDeliveryEntryList(value: unknown): QueuedTaskPromptDeliveryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const entries: QueuedTaskPromptDeliveryEntry[] = [];
	for (const candidate of value) {
		const parsed = queuedTaskPromptDeliveryEntrySchema.safeParse(candidate);
		if (parsed.success) {
			entries.push(parsed.data);
		}
	}
	return entries;
}

interface QueuedTaskPromptDeliveryFileReadResult {
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	filePresentButUnreadable: boolean;
}

async function readWorkspaceQueuedTaskPromptDeliveryFile(
	workspaceId: string,
): Promise<QueuedTaskPromptDeliveryFileReadResult> {
	const outcome = await readQueuedTaskPromptDeliveryFileDistinguishingAbsentFromUnreadable(
		getWorkspaceQueuedTaskPromptDeliveriesPath(workspaceId),
	);
	const record =
		outcome.status === "parsed" && typeof outcome.parsedContent === "object" && outcome.parsedContent !== null
			? (outcome.parsedContent as Record<string, unknown>)
			: {};
	const entriesByTaskIdRaw = record.entriesByTaskId;
	const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
	if (typeof entriesByTaskIdRaw === "object" && entriesByTaskIdRaw !== null && !Array.isArray(entriesByTaskIdRaw)) {
		for (const [taskId, candidate] of Object.entries(entriesByTaskIdRaw as Record<string, unknown>)) {
			const entries = parseQueuedTaskPromptDeliveryEntryList(candidate);
			if (entries.length > 0) {
				entriesByTaskId[taskId] = entries;
			}
		}
	}
	return {
		snapshot: { entriesByTaskId },
		filePresentButUnreadable: outcome.status === "present_but_unreadable",
	};
}

// 读路径把「不存在」与「读坏了」一起降级成空队列：空队列是安全默认值（什么都不会发出去），
// 而把「读不出来」抛给调用方只会让面板整个打不开。只有写路径需要分辨两者。
export async function readWorkspaceQueuedTaskPromptDeliverySnapshot(
	workspaceId: string,
): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	return (await readWorkspaceQueuedTaskPromptDeliveryFile(workspaceId)).snapshot;
}

// ── 纯变换层：以下全部是纯函数，并发正确性来自调用方持锁重读 ────────────────────────────────

export function withTaskEntries(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	taskId: string,
	nextEntries: QueuedTaskPromptDeliveryEntry[],
): WorkspaceQueuedTaskPromptDeliverySnapshot {
	const entriesByTaskId = { ...snapshot.entriesByTaskId };
	if (nextEntries.length === 0) {
		delete entriesByTaskId[taskId];
	} else {
		entriesByTaskId[taskId] = nextEntries;
	}
	return { entriesByTaskId };
}

export function getTaskEntries(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	taskId: string,
): QueuedTaskPromptDeliveryEntry[] {
	return snapshot.entriesByTaskId[taskId] ?? [];
}

// 「这个任务的队列还能不能再排一条」。只数**非终态**条目：终态条目是留着给 UI 看的历史，
// 不占队列容量（把它们算进来，就等于一天内发过 20 条 prompt 的任务从此再也排不了队）。
//
// 导出是给调用方分辨「入队被拒（满了）」与「入队幂等（重发）」用的——两者都表现为快照原样返回，
// 而给用户的话完全不同。
export function isQueuedTaskPromptDeliveryQueueFullForTask(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	taskId: string,
): boolean {
	return (
		getTaskEntries(snapshot, taskId).filter((entry) =>
			isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState),
		).length >= MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK
	);
}

function countNonTerminalQueuedTaskPromptDeliveriesInWorkspace(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
): number {
	let count = 0;
	for (const entries of Object.values(snapshot.entriesByTaskId)) {
		for (const entry of entries) {
			if (isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState)) {
				count += 1;
			}
		}
	}
	return count;
}

// 整个 workspace 的非终态条目是否已到上限。per-workspace 上限只靠裁剪是约束不住的——裁剪只丢终态条目，
// 于是 10 个任务各排满 20 条之后，第 11 个任务照样能入队、文件与全量推流无界增长。所以它和 per-task 上限
// 一样，由入队处显式拒绝承担。
export function isQueuedTaskPromptDeliveryWorkspaceQueueFull(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
): boolean {
	return (
		countNonTerminalQueuedTaskPromptDeliveriesInWorkspace(snapshot) >= MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE
	);
}

// 入队 / 重排之前的唯一容量判据：任务满或 workspace 满都拒绝。
export function isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	taskId: string,
): boolean {
	return (
		isQueuedTaskPromptDeliveryQueueFullForTask(snapshot, taskId) ||
		isQueuedTaskPromptDeliveryWorkspaceQueueFull(snapshot)
	);
}

function settleExpiredQueuedTaskPromptDeliveryEntry(
	entry: QueuedTaskPromptDeliveryEntry,
	nowEpochMs: number,
): QueuedTaskPromptDeliveryEntry {
	return {
		...entry,
		deliveryState: "expired",
		settledAt: nowEpochMs,
		...(entry.nativeIndependentUserTurnPreflightQueryRecovery?.recoveredAtEpochMs === null
			? {
					lastDeliveryFailureNote: `原生回合查询在原截止时间内仍未恢复，尚未发送：${entry.nativeIndependentUserTurnPreflightQueryRecovery.lastQueryFailureReason}`,
				}
			: {}),
	};
}

// 把已过保质期、却还标着 queued 的条目就地收敛成 expired。没有任何条目过期时**原样返回同一个对象**——
// 调用方靠引用相等判断「这次有没有改动、要不要写盘」。
//
// 每一次意图 mutation 都先过它，再做幂等 / 容量 / dismiss / retry 判断。否则 durable 状态与投影会分裂：
// 投影把过期条目显示成 expired（UI 给出 Dismiss），底层却仍是非终态的 queued——Dismiss 无操作，
// 20 条这样的条目还会占满容量、永久拒绝新入队。
export function withExpiredQueuedEntriesSettled(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	nowEpochMs: number,
): WorkspaceQueuedTaskPromptDeliverySnapshot {
	let changed = false;
	const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
	for (const [taskId, entries] of Object.entries(snapshot.entriesByTaskId)) {
		entriesByTaskId[taskId] = entries.map((entry) => {
			if (entry.deliveryState === "queued" && nowEpochMs >= entry.expiresAt) {
				changed = true;
				return settleExpiredQueuedTaskPromptDeliveryEntry(entry, nowEpochMs);
			}
			return entry;
		});
	}
	return changed ? { entriesByTaskId } : snapshot;
}

// 把一份条目列表压到上限之内，**只丢终态条目、最老的先走**，非终态条目一条都不动。
// 结果里非终态条目仍可能让长度超过 cap——那是刻意的：宁可超限，也不静默丢掉用户还在等的东西。
function withOldestTerminalEntriesDroppedDownToCap(
	entries: readonly QueuedTaskPromptDeliveryEntry[],
	cap: number,
): QueuedTaskPromptDeliveryEntry[] {
	if (entries.length <= cap) {
		return [...entries];
	}
	const terminalEntriesOldestFirst = entries
		.filter((entry) => !isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState))
		.map((entry) => ({ queueEntryId: entry.queueEntryId, settledAt: entry.settledAt ?? entry.enqueuedAt }))
		.sort((left, right) => left.settledAt - right.settledAt);
	const droppedQueueEntryIds = new Set(
		terminalEntriesOldestFirst.slice(0, entries.length - cap).map((candidate) => candidate.queueEntryId),
	);
	return entries.filter((entry) => !droppedQueueEntryIds.has(entry.queueEntryId));
}

// 裁剪：先把过期的排队条目转 expired，再裁掉已展示够久的终态条目，最后压 per-task / per-workspace 上限。
//
// 过期转写放在这里而不是靠定时器：状态改写是副作用，而「过没过期」是时间的纯函数。让每次读-改-写
// 顺手收敛，就不存在「定时器还没跑到、于是一条早该过期的条目被发了出去」这种窗口。
export function withExpiredAndOverflowingEntriesPruned(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	nowEpochMs: number,
): WorkspaceQueuedTaskPromptDeliverySnapshot {
	const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
	let retainedWorkspaceEntryCount = 0;
	for (const [taskId, expiryResolved] of Object.entries(
		withExpiredQueuedEntriesSettled(snapshot, nowEpochMs).entriesByTaskId,
	)) {
		const retainedForTask = expiryResolved.filter((entry) => {
			if (isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState)) {
				return true;
			}
			const settledAt = entry.settledAt ?? entry.enqueuedAt;
			return nowEpochMs - settledAt < SETTLED_QUEUED_TASK_PROMPT_DELIVERY_RETENTION_MS;
		});
		// per-task 上限**只裁终态条目，最老的先走**。
		//
		// 曾经写成 `retainedForTask.slice(0, MAX)`，注释是「上限从队尾裁：队首是马上要发的那条」。
		// 那句话只在「整条队列全是 queued」时才成立，而终态条目落定后要原地保留 24h 供 UI 展示——
		// 于是一个任务在一天内正常发过 20 条 prompt 之后，队首起就摆着 20 条终态记录，用户新排的任何
		// 一条都被追加到队尾、当场被 slice 裁掉，**没有任何错误、没有任何痕迹**。这不是边角情况：
		// 24h 内发 20 条完全是正常用量，而「静默丢掉用户排的 prompt」恰是本特性最该防的坏结果。
		// 它同时和下面 workspace 级裁剪「非终态条目任何情况下都不裁」自相矛盾。
		//
		// 现在两级裁剪口径一致：非终态条目（用户还在等的东西）任何情况下都不裁；上限对**队列本身**的
		// 约束改由入队处显式拒绝承担（见 applyQueuedTaskPromptDeliveryMutation 的 enqueue 分支），
		// 拒绝是可被调用方看见的，静默丢弃不是。
		const cappedForTask = withOldestTerminalEntriesDroppedDownToCap(
			retainedForTask,
			MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK,
		);
		if (cappedForTask.length === 0) {
			continue;
		}
		retainedWorkspaceEntryCount += cappedForTask.length;
		entriesByTaskId[taskId] = cappedForTask;
	}
	if (retainedWorkspaceEntryCount <= MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE) {
		return { entriesByTaskId };
	}
	// workspace 级溢出按「最老的终态条目先走」裁——非终态条目是用户还在等的东西，任何情况下都不裁。
	const terminalEntryAges: { taskId: string; queueEntryId: string; settledAt: number }[] = [];
	for (const [taskId, entries] of Object.entries(entriesByTaskId)) {
		for (const entry of entries) {
			if (!isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState)) {
				terminalEntryAges.push({
					taskId,
					queueEntryId: entry.queueEntryId,
					settledAt: entry.settledAt ?? entry.enqueuedAt,
				});
			}
		}
	}
	terminalEntryAges.sort((left, right) => left.settledAt - right.settledAt);
	const dropCount = retainedWorkspaceEntryCount - MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE;
	const droppedEntryKeys = new Set(
		terminalEntryAges.slice(0, dropCount).map((candidate) => `${candidate.taskId} ${candidate.queueEntryId}`),
	);
	const prunedEntriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
	for (const [taskId, entries] of Object.entries(entriesByTaskId)) {
		const kept = entries.filter((entry) => !droppedEntryKeys.has(`${taskId} ${entry.queueEntryId}`));
		if (kept.length > 0) {
			prunedEntriesByTaskId[taskId] = kept;
		}
	}
	return { entriesByTaskId: prunedEntriesByTaskId };
}

// 与 `kanban task message` 的 promptSha256 同一口径（src/commands/task.ts 的 hashPrompt）：utf8 字节的 sha256 hex。
export function computeQueuedTaskPromptDeliveryTextSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildEnqueuedEntry(
	mutation: Extract<QueuedTaskPromptDeliveryMutation, { kind: "enqueue_prompt_for_delivery_after_current_turn" }>,
	nowEpochMs: number,
): QueuedTaskPromptDeliveryEntry {
	const sourcePromptLibraryEntryId = mutation.sourcePromptLibraryEntryId ?? null;
	return {
		queueEntryId: mutation.queueEntryId,
		taskId: mutation.taskId,
		text: mutation.text,
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId,
		// 客户端没给就由服务端按**冻结正文**算：「库里那条后来被改过没有」比对的就是入队这一刻的正文，
		// 让浏览器去做 SHA 只是多一处可能算错的地方。没有来源条目时不算——没有东西可比。
		sourcePromptLibraryEntryTextSha256:
			mutation.sourcePromptLibraryEntryTextSha256 ??
			(sourcePromptLibraryEntryId === null ? null : computeQueuedTaskPromptDeliveryTextSha256(mutation.text)),
		workspaceTaskId: mutation.workspaceTaskId ?? mutation.taskId,
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: nowEpochMs,
		expiresAt: nowEpochMs + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		// 托管者由**服务端**盖，不从 mutation 里取：mutation 可能来自浏览器，而「此刻谁托管这条队」
		// 是运行时自己的事实，让客户端提供等于让它自称身份。
		custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
	};
}

// 把一条意图应用到快照上。纯函数——并发合并的正确性来自调用方持锁重读，这里只负责语义。
export function applyQueuedTaskPromptDeliveryMutation(
	snapshotAsRead: WorkspaceQueuedTaskPromptDeliverySnapshot,
	mutation: QueuedTaskPromptDeliveryMutation,
	nowEpochMs: number,
): WorkspaceQueuedTaskPromptDeliverySnapshot {
	// 先把过期收敛进 durable 状态，后面每一条判断看到的都是与投影一致的状态（见 withExpiredQueuedEntriesSettled）。
	const snapshot = withExpiredQueuedEntriesSettled(snapshotAsRead, nowEpochMs);
	const entries = getTaskEntries(snapshot, mutation.taskId);

	if (mutation.kind === "enqueue_prompt_for_delivery_after_current_turn") {
		// 幂等：同一个 queueEntryId 重发（网络重试 / 双击）不该排出两条。
		if (entries.some((entry) => entry.queueEntryId === mutation.queueEntryId)) {
			return snapshot;
		}
		// 队列已满即**拒绝**，绝不「先收下再裁掉」。裁剪层只丢终态条目（见
		// withOldestTerminalEntriesDroppedDownToCap），所以真正约束队列长度的就是这里这一条。
		// 拒绝表现为快照原样返回：调用方拿 isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask 就能分辨
		// 「满了」与「幂等重发」，从而给用户一句真话，而不是让他以为排上了。
		if (isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(snapshot, mutation.taskId)) {
			return snapshot;
		}
		return withExpiredAndOverflowingEntriesPruned(
			withTaskEntries(snapshot, mutation.taskId, [...entries, buildEnqueuedEntry(mutation, nowEpochMs)]),
			nowEpochMs,
		);
	}

	if (mutation.kind === "cancel_queued_prompt_delivery") {
		// 只有还没交给 transport 的条目能就地取消。已经 handed_to_transport 的由 dispatcher 走既有
		// cancelTaskChatDelivery，回执可能是 already_delivered——那条路径不经过这里。
		return withTaskEntries(
			snapshot,
			mutation.taskId,
			entries.map((entry) =>
				entry.queueEntryId === mutation.queueEntryId &&
				(entry.deliveryState === "queued" || entry.deliveryState === "claimed_for_dispatch")
					? { ...entry, deliveryState: "cancelled" as const, settledAt: nowEpochMs }
					: entry,
			),
		);
	}

	if (mutation.kind === "reorder_queued_prompt_deliveries") {
		// 「取交集 + 未知 id 追加到尾」：客户端算这份顺序时看到的列表，可能已经被另一个标签页或
		// dispatcher 改过。按交集重排保证不凭空造出条目，追加到尾保证不吞掉客户端还没见过的新条目。
		const entryById = new Map(entries.map((entry) => [entry.queueEntryId, entry]));
		const reordered: QueuedTaskPromptDeliveryEntry[] = [];
		const consumedQueueEntryIds = new Set<string>();
		for (const queueEntryId of mutation.orderedQueueEntryIds) {
			const entry = entryById.get(queueEntryId);
			if (entry && !consumedQueueEntryIds.has(queueEntryId)) {
				reordered.push(entry);
				consumedQueueEntryIds.add(queueEntryId);
			}
		}
		for (const entry of entries) {
			if (!consumedQueueEntryIds.has(entry.queueEntryId)) {
				reordered.push(entry);
			}
		}
		return withTaskEntries(snapshot, mutation.taskId, reordered);
	}

	if (mutation.kind === "set_queued_prompt_delivery_merge_with_next") {
		// 只允许改还在排队的条目。已认领 / 已交付的那一串在认领那一刻就冻结了（dispatcher 发的是认领时的
		// claimedEntries），此时改开关只会让磁盘与 UI 显示一条「将合并 / 已拆开」、实际发出去的却是另一回事。
		return withTaskEntries(
			snapshot,
			mutation.taskId,
			entries.map((entry) =>
				entry.queueEntryId === mutation.queueEntryId &&
				entry.deliveryState === "queued" &&
				// 程序化条目的正文必须逐字发出（调用方按 hash 认它），它自己的开关不许点亮。它**前一条**的开关
				// 点亮了也无效——链在它前面就断（collectQueuedTaskPromptDeliveryChainFromHead）。
				!isQueuedTaskPromptDeliveryProgrammaticInjection(entry)
					? { ...entry, deliverTogetherWithNextQueuedEntry: mutation.deliverTogetherWithNextQueuedEntry }
					: entry,
			),
		);
	}

	if (mutation.kind === "dismiss_settled_queued_prompt_delivery") {
		// 只丢终态条目。误传一个仍在排队的 id 不该把它从队列里抹掉——那是「取消」的语义，得走取消。
		return withTaskEntries(
			snapshot,
			mutation.taskId,
			entries.filter(
				(entry) =>
					entry.queueEntryId !== mutation.queueEntryId ||
					isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState),
			),
		);
	}

	if (mutation.kind === "retry_settled_failed_queued_prompt_delivery") {
		const failedEntry = entries.find(
			(entry) => entry.queueEntryId === mutation.queueEntryId && entry.deliveryState === "settled_failed",
		);
		if (!failedEntry) {
			return snapshot;
		}
		// 与 enqueue 同一条幂等判据，缺一不可：原条目重排之后仍是 settled_failed（刻意保留供对照），
		// 所以上面那个 find 对第二次重发照样命中——只查原条目不查替身，双击就会排出两条同 id 的
		// queued 条目，而按 id 认领会把它们一起认领，同一段话发两遍。
		if (entries.some((entry) => entry.queueEntryId === mutation.replacementQueueEntryId)) {
			return snapshot;
		}
		if (isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(snapshot, mutation.taskId)) {
			return snapshot;
		}
		// 换新 queueEntryId、清空全部尝试痕迹、重新起算保质期：这是一条**新的意图**，不是旧那条的续命。
		// 保留原条目（已 settled）供用户对照「上次为什么失败」。
		const requeued: QueuedTaskPromptDeliveryEntry = {
			...failedEntry,
			queueEntryId: mutation.replacementQueueEntryId,
			deliveryState: "queued",
			deliveryAttemptCount: 0,
			lastAttemptedAt: null,
			settledAt: null,
			dispatchIdempotencyKey: null,
			claimedForSessionIncarnationId: null,
			claimedAtTurnSequence: null,
			enqueuedAt: nowEpochMs,
			expiresAt: nowEpochMs + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
			lastDeliveryFailureNote: null,
			// 人手动重排的这一刻就是「人看见了」，不该再要求他为这条新条目确认一次。
			survivedRuntimeRestartAtEpochMs: null,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
			// 这是一条**新**意图，托管权归重排它的这个实例，而不是当初排下原条目的那个。
			custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			// 人从 Queue tab 重排一条失败的程序化条目：那是**人**的新意图，不再是调用方那次投递——调用方的账本记录
			// 已经落定（写一次即定），它要重投自会换新 key。于是新条目是一条普通的人排条目。
			programmaticInjectionLedgerReceiptLink: null,
		};
		return withExpiredAndOverflowingEntriesPruned(
			withTaskEntries(snapshot, mutation.taskId, [...entries, requeued]),
			nowEpochMs,
		);
	}

	// reconfirm_queued_prompt_deliveries_after_runtime_restart
	// 幂等，且**只写确认时间戳**：不动顺序、不动正文、不动状态。已确认过的不重复盖章（保留人第一次
	// 看见它的时刻，那才是这个字段的意义）。
	const reconfirmedQueueEntryIds = new Set(mutation.queueEntryIds);
	return withTaskEntries(
		snapshot,
		mutation.taskId,
		entries.map((entry) =>
			reconfirmedQueueEntryIds.has(entry.queueEntryId) &&
			entry.survivedRuntimeRestartAtEpochMs !== null &&
			entry.humanReconfirmedAfterRuntimeRestartAtEpochMs === null
				? { ...entry, humanReconfirmedAfterRuntimeRestartAtEpochMs: nowEpochMs }
				: entry,
		),
	);
}

// ── IO 层 ──────────────────────────────────────────────────────────────────

function buildUnreadableQueueQuarantinePath(queuePath: string, nowEpochMs: number, discriminator: string): string {
	return `${queuePath}.unreadable-quarantined-before-overwrite-${nowEpochMs}-${discriminator}.json`;
}

// 覆盖一份读不出来的队列文件之前先把原始字节搬到旁路留存——损坏的文件里通常一个字节的正文都没少。
// 搬移失败则让错误抛出去、这次写入告吹：宁可写失败（用户还能重试），也不在没留下副本时覆盖。
async function quarantineUnreadableQueueFileBeforeOverwrite(
	queuePath: string,
	nowEpochMs: number,
	discriminator: string,
): Promise<void> {
	await rename(queuePath, buildUnreadableQueueQuarantinePath(queuePath, nowEpochMs, discriminator));
}

// 持锁读-改-写的唯一实现。所有写入口（意图 mutation、dispatcher 三原子、启动清扫）都经它，
// 于是「锁内重读」这条不变量只需在一处成立——程序化条目的账本镜像也因此只需挂在这一处。
export async function updateWorkspaceQueuedTaskPromptDeliveriesUnderLock<TResult>(
	workspaceId: string,
	transform: (
		current: WorkspaceQueuedTaskPromptDeliverySnapshot,
		compactionAwareCloseoutLedgerRecords: readonly TaskMessageInjectionRecord[],
	) => {
		next: WorkspaceQueuedTaskPromptDeliverySnapshot;
		result: TResult;
	},
	nowEpochMs: number,
	quarantineDiscriminator: string,
	options: { requireCompactionAwareCloseoutLedgerConsistency?: boolean } = {},
): Promise<{ snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot; result: TResult }> {
	const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(workspaceId);
	const applyTransformAndPersistQueue = async (
		currentRead: QueuedTaskPromptDeliveryFileReadResult,
		ledgerRecords: readonly TaskMessageInjectionRecord[],
	) => {
		const { next, result } = transform(currentRead.snapshot, ledgerRecords);
		if (next === currentRead.snapshot) {
			return { before: currentRead.snapshot, after: currentRead.snapshot, result };
		}
		if (currentRead.filePresentButUnreadable) {
			await quarantineUnreadableQueueFileBeforeOverwrite(queuePath, nowEpochMs, quarantineDiscriminator);
		}
		await lockedFileSystem.writeJsonFileAtomic(queuePath, next satisfies WorkspaceQueuedTaskPromptDeliverySnapshot, {
			lock: null,
		});
		return { before: currentRead.snapshot, after: next, result };
	};
	const queueOnlyRewrite = await lockedFileSystem.withLock({ path: queuePath, type: "file" }, async () => {
		// 必须在锁内判断是否需要账本：等待队列锁期间，dispatcher 可能刚加入一条已提交的自动收尾。
		const currentRead = await readWorkspaceQueuedTaskPromptDeliveryFile(workspaceId);
		if (
			options.requireCompactionAwareCloseoutLedgerConsistency &&
			hasSubmittedRvfCloseoutQueuedPromptDeliveries(currentRead.snapshot)
		)
			return null;
		return applyTransformAndPersistQueue(currentRead, []);
	});
	// 先释放单独队列锁，再按统一路径顺序取得两把锁；不能持队列锁后临时追加账本锁。
	// 普通队列仍只用上面的单锁路径。跨存储清扫在联合锁内重读两份最新事实，并持锁到队列终态落盘，
	// 防止已接受回执或合法截止在读取后被并发更新，旧快照却不可逆地写成失败。
	const { before, after, result } =
		queueOnlyRewrite ??
		(await lockedFileSystem.withLocks(
			[
				{ path: queuePath, type: "file" },
				{ path: getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId)), type: "file" },
			],
			async () => {
				const currentRead = await readWorkspaceQueuedTaskPromptDeliveryFile(workspaceId);
				const ledgerRecords = hasSubmittedRvfCloseoutQueuedPromptDeliveries(currentRead.snapshot)
					? await readTaskMessageInjectionLedger(
							getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId)),
						)
					: [];
				return applyTransformAndPersistQueue(currentRead, ledgerRecords);
			},
		));
	// 程序化条目的落定镜像进注入账本——挂在这个唯一的写盘咽喉上，任何落定路径都逃不掉。锁释放之后做。
	await mirrorProgrammaticInjectionQueueTransitionsIntoInjectionLedger({ workspaceId, before, after, nowEpochMs });
	return { snapshot: after, result };
}

export async function mutateWorkspaceQueuedTaskPromptDeliveries(
	workspaceId: string,
	mutation: QueuedTaskPromptDeliveryMutation,
	nowEpochMs: number = Date.now(),
): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const { snapshot } = await mutateWorkspaceQueuedTaskPromptDeliveriesAndReportNewlyCreatedQueueEntries(
		workspaceId,
		mutation,
		nowEpochMs,
	);
	return snapshot;
}

// 同上，另报出本次变更**在锁内**新建的条目（入队、失败重排）。同 id 重发、满额被拒都原样返回快照，这里就是空数组——
// 调用方据此判断「这次是不是一条新的投递意图」，不必事后拿快照猜（同毫秒的重发会骗过按时间戳猜的判据）。
export async function mutateWorkspaceQueuedTaskPromptDeliveriesAndReportNewlyCreatedQueueEntries(
	workspaceId: string,
	mutation: QueuedTaskPromptDeliveryMutation,
	nowEpochMs: number = Date.now(),
): Promise<{
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	newlyCreatedQueueEntries: QueuedTaskPromptDeliveryEntry[];
}> {
	const { snapshot, result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		workspaceId,
		(current) => {
			const next = applyQueuedTaskPromptDeliveryMutation(current, mutation, nowEpochMs);
			const queueEntryIdsBeforeMutation = new Set(
				(current.entriesByTaskId[mutation.taskId] ?? []).map((entry) => entry.queueEntryId),
			);
			return {
				next,
				result: (next.entriesByTaskId[mutation.taskId] ?? []).filter(
					(entry) => !queueEntryIdsBeforeMutation.has(entry.queueEntryId),
				),
			};
		},
		nowEpochMs,
		mutation.kind,
	);
	return { snapshot, newlyCreatedQueueEntries: result };
}

// ── dispatcher 专用原子操作 ────────────────────────────────────────────────

export interface ClaimedQueuedTaskPromptDeliveryRun {
	// head + 被 deliverTogetherWithNextQueuedEntry 链住的连续串。默认串长恒为 1。
	claimedEntries: QueuedTaskPromptDeliveryEntry[];
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
}

// 在**文件锁内**把队首（及其链）从 queued 翻成 claimed_for_dispatch，并快照会话身份双判据。
// 第二个认领者进来时找不到可认领项，于是「同一条边沿被两处观察到」不会发两遍。
//
// 此刻**不写** dispatchIdempotencyKey：认领只是占位，一个字节都还没写出去。key 在
// markQueuedTaskPromptDeliveryHandedToTransport 那一步随「即将 send」一起落盘，于是崩溃后
// claimed_for_dispatch 恒等于「什么都没发生，安全释放」。
export async function claimNextQueuedTaskPromptDeliveryRunForDispatch(input: {
	workspaceId: string;
	taskId: string;
	sessionIncarnationId: string;
	turnSequence: number;
	nowEpochMs?: number;
	expectedQueueHeadEntryId?: string;
}): Promise<ClaimedQueuedTaskPromptDeliveryRun | null> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const { snapshot, result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const pruned = withExpiredAndOverflowingEntriesPruned(current, nowEpochMs);
			const entries = getTaskEntries(pruned, input.taskId);
			// 已经有在途投递（claimed_for_dispatch / handed_to_transport）⇒ 本次不认领。
			// durable 层的互斥，与 dispatcher 的内存互斥并联——后者拦得住同进程重入，拦不住第二个 runtime。
			if (
				entries.some(
					(entry) =>
						entry.deliveryState !== "queued" && isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState),
				)
			) {
				return { next: pruned, result: null };
			}
			const dispatchable = entries.filter((entry) => isQueuedTaskPromptDeliveryAwaitingDispatch(entry, nowEpochMs));
			if (
				dispatchable.length === 0 ||
				(input.expectedQueueHeadEntryId !== undefined &&
					dispatchable[0]?.queueEntryId !== input.expectedQueueHeadEntryId)
			) {
				return { next: pruned, result: null };
			}
			const chain = collectQueuedTaskPromptDeliveryChainFromHead(dispatchable);
			const chainQueueEntryIds = new Set(chain.map((entry) => entry.queueEntryId));
			const claimedEntries: QueuedTaskPromptDeliveryEntry[] = [];
			const nextEntries = entries.map((entry) => {
				if (!chainQueueEntryIds.has(entry.queueEntryId)) {
					return entry;
				}
				const claimed: QueuedTaskPromptDeliveryEntry = {
					...entry,
					deliveryState: "claimed_for_dispatch",
					claimedForSessionIncarnationId: input.sessionIncarnationId,
					claimedAtTurnSequence: input.turnSequence,
				};
				claimedEntries.push(claimed);
				return claimed;
			});
			return { next: withTaskEntries(pruned, input.taskId, nextEntries), result: claimedEntries };
		},
		nowEpochMs,
		"claim",
	);
	return result === null ? null : { claimedEntries: result, snapshot };
}

// 认领 → 即将 send。这一步的写盘**必须发生在 send 之前**：崩溃后 claimed_for_dispatch 与
// handed_to_transport 的区别正是「一个字节都没写出去（安全释放）」与「语义暧昧（绝不自动重投）」。
export async function markQueuedTaskPromptDeliveryHandedToTransport(input: {
	workspaceId: string;
	taskId: string;
	queueEntryIds: readonly string[];
	dispatchIdempotencyKey: string;
	nowEpochMs?: number;
}): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const targetQueueEntryIds = new Set(input.queueEntryIds);
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => ({
			next: withTaskEntries(
				current,
				input.taskId,
				getTaskEntries(current, input.taskId).map((entry) =>
					targetQueueEntryIds.has(entry.queueEntryId) && entry.deliveryState === "claimed_for_dispatch"
						? {
								...entry,
								deliveryState: "handed_to_transport" as const,
								dispatchIdempotencyKey: input.dispatchIdempotencyKey,
								deliveryAttemptCount: entry.deliveryAttemptCount + 1,
								lastAttemptedAt: nowEpochMs,
							}
						: entry,
				),
			),
			result: null,
		}),
		nowEpochMs,
		"hand-to-transport",
	);
	return snapshot;
}

// 释放认领回 queued。用于「陈旧双判据不符」与「启动清扫捡到 claimed_for_dispatch」两条路径。
// **不计一次尝试**：什么都没发生过，不该消耗重试预算。
export async function releaseQueuedTaskPromptDeliveryClaim(input: {
	workspaceId: string;
	taskId: string;
	queueEntryIds: readonly string[];
	nowEpochMs?: number;
}): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const targetQueueEntryIds = new Set(input.queueEntryIds);
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => ({
			next: withTaskEntries(
				current,
				input.taskId,
				getTaskEntries(current, input.taskId).map((entry) =>
					targetQueueEntryIds.has(entry.queueEntryId) && entry.deliveryState === "claimed_for_dispatch"
						? {
								...entry,
								deliveryState: "queued" as const,
								claimedForSessionIncarnationId: null,
								claimedAtTurnSequence: null,
							}
						: entry,
				),
			),
			result: null,
		}),
		nowEpochMs,
		"release-claim",
	);
	return snapshot;
}

// 结算形状的真相在 src/core/queued-task-prompt-delivery-outcome-routing.ts（回执 → 去向的路由表就在它旁边）。
export type { QueuedTaskPromptDeliverySettlement };

// 终态写一次即定。已经落定的条目不会被第二次回执改写——回执可能来自一条早已被取代的在途投递。
export async function settleQueuedTaskPromptDelivery(input: {
	workspaceId: string;
	taskId: string;
	queueEntryIds: readonly string[];
	settlement: QueuedTaskPromptDeliverySettlement;
	nowEpochMs?: number;
}): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const targetQueueEntryIds = new Set(input.queueEntryIds);
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => ({
			next: withTaskEntries(
				current,
				input.taskId,
				getTaskEntries(current, input.taskId).map((entry) => {
					if (
						!targetQueueEntryIds.has(entry.queueEntryId) ||
						!isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState)
					) {
						return entry;
					}
					const link = entry.programmaticInjectionLedgerReceiptLink ?? null;
					// 程序化条目把真实终端回执存下来，落定后的账本镜像原样用它（确认 vs 排在回合后面、哪种失败）。
					const withReceipt: QueuedTaskPromptDeliveryEntry =
						link !== null && input.settlement.terminalDeliveryReceiptForInjectionLedger !== undefined
							? {
									...entry,
									programmaticInjectionLedgerReceiptLink: {
										...link,
										settledTerminalDeliveryReceipt:
											input.settlement.terminalDeliveryReceiptForInjectionLedger,
									},
								}
							: entry;
					if (input.settlement.outcome === "delivered") {
						return {
							...withReceipt,
							deliveryState: "settled_delivered" as const,
							settledAt: nowEpochMs,
							lastDeliveryFailureNote: null,
						};
					}
					if (input.settlement.outcome === "cancelled") {
						return {
							...withReceipt,
							deliveryState: "cancelled" as const,
							settledAt: nowEpochMs,
							lastDeliveryFailureNote: null,
						};
					}
					const retryBudgetExhausted = entry.deliveryAttemptCount >= MAX_QUEUED_TASK_PROMPT_DELIVERY_ATTEMPTS;
					// 程序化条目一次定终身：已经交给终端投递了，就绝不回头再等 agent（与 RVF 的分工约定第 3 条）。
					// 调用方有自己的重试策略与新 key；这里再重投一次，等于替它多送一遍、还用着它已经认定落定的 key。
					if (input.settlement.outcome === "retryable_failure" && !retryBudgetExhausted && link === null) {
						return {
							...entry,
							deliveryState: "queued" as const,
							dispatchIdempotencyKey: null,
							claimedForSessionIncarnationId: null,
							claimedAtTurnSequence: null,
							lastDeliveryFailureNote: input.settlement.failureNote,
						};
					}
					return {
						...withReceipt,
						deliveryState: "settled_failed" as const,
						settledAt: nowEpochMs,
						lastDeliveryFailureNote: input.settlement.failureNote,
					};
				}),
			),
			result: null,
		}),
		nowEpochMs,
		"settle",
	);
	return snapshot;
}

// 启动清扫用：给所有**在本进程启动之前入队**、且仍非终态的条目盖 restart-crossing 章。
//
// ## 「已盖过章的不重复盖」必须限定在**本进程**内，否则第二次真实重启会被绕过
//
// 这里曾经写成 `entry.survivedRuntimeRestartAtEpochMs !== null` 即跳过——一辈子只盖一次。后果是
// 确定性的：重启 #1 盖章 → 用户确认（写 humanReconfirmed…）→ 重启 #2 时该条目仍带着上次的章，
// 于是跳过盖章、humanReconfirmed 又还留着，门控 0 直接放行 —— 用户**第二次重启后一次提醒都没有**，
// 队列照发。而「重启后先提醒人」正是这套机制存在的全部理由。
//
// 现在的判据是「本进程已经盖过的不重复盖」（`survivedRuntimeRestartAtEpochMs >= 本进程启动时刻`），
// 于是：同一进程内重复清扫仍然幂等（原意保住了），而跨进程的下一次重启会**重新盖章并清掉上一次的
// 人工确认**——确认属于它确认的那一次重启，不能跨重启沿用。
//
// ## 判据是「归属实例此刻不活着」，不是「条目比本进程老」
//
// 一台机器上会同时跑多个 runtime（常驻实例 / dev:full / dogfood / 集成测试），它们共享同一个
// workspaces 根。「条目比本进程老」这条判据分不清两件完全不同的事——
//   ① 这条队伍是上一次生命周期留下的，中间真的断过（该盖章）；
//   ② 这条队伍属于**另一个此刻正活着**的实例，只是它比我先启动（不该盖章）。
// 按它判，第二个实例一启动就会把常驻实例正常排着的队全部盖章 + 清掉人工确认。
//
// 顺带更正一处曾经写错的出处：这条口径**不是**抄自 pending-task-message-injection-startup-sweep.ts
// ——恰恰相反，那个文件专门**拒绝**了「按本进程刚起来」的口径（理由正是全机共享根下的多实例误伤），
// 改用「超期」判据。它能那么做是因为注入契约给了 pending 一个有界收敛预算；排队 prompt 可以合法地
// 等几个小时，借不到那个预算。
//
// 现在的判据用 runtime-process-instance-heartbeat-registry 的心跳：条目记着**此刻谁托管它**
// （custodianRuntimeProcessInstanceId），清扫只盖那些托管者已经不在心跳里的条目。
//
// ## 盖章必须同时**转移托管权**，否则误标换个触发条件就卷土重来
//
// 托管权是可转移的责任，不是出身记录。盖完章不转移的话，条目会永久指向那个最初排队、后来死掉的实例，
// 于是**任何**一个启动时刻晚于上次盖章的并存实例（下一个 dev:full、下一次集成测试）都会再判一次
// 「托管者不活跃」，重新盖章并清空用户刚做的确认——正是这套心跳被引入来消除的那件事。
// 所以：判定「确实跨过了重启」并盖章的同时，把托管权交给做这次清扫的实例。
//
// 五种排列都对：
//   A 排队后死掉，B 启动清扫   → A 的心跳过期 → 盖章，托管权 → B ✓
//   C 在 B 活着时启动并清扫    → 托管者 B 心跳新鲜 → 跳过，确认保住 ✓
//   B 也死掉，D 启动清扫       → 托管者 B 心跳过期 → 盖章并清确认，托管权 → D ✓（真实重启不漏）
//   同一进程内重复清扫（复扫） → alreadyStampedByThisRuntimeProcess 短路 → 幂等 ✓
//   条目没有托管者（升级前存量）→ 退回按年龄的保守口径，盖完同样接管，于是只退化这一次 ✓
//
// 为什么不按 workspace 发租约（更省事、条目不必记归属）：那有一个 **fail-unsafe** 的洞——A 常驻持
// 新鲜租约，B 启动跳过盖章（对），但 B 随后也续了租约；此时 A 真的重启，看到 B 的租约新鲜就**跳过
// 盖章、漏掉一次真实重启**。漏盖 = 重启后不提醒直接发，正是这套机制要防的那件事。
// 身份挂在条目上、活性挂在实例上，两者分开，才没有任何排列能推出漏盖。
//
// ## 没有归属实例的旧条目
//
// 升级前存下的条目缺这个字段。对它们退回「enqueuedAt 早于本进程启动」的老口径：它会在多实例下过度
// 盖章，但那是 fail-safe 方向（多让人确认一次，绝不漏盖），而这批条目至多存活 24h 就会自然消失。
//
// ## 程序化条目不盖章，直接落定
//
// 「等人确认」是给人排的 prompt 设计的：人在重启后看一眼、决定还要不要。程序化条目（例：RVF 决策点）背后没有
// 人在看 Queue tab，它的调用方要的是一条诚实的账本回执。托管实例一死，agent 进程也已经不在了，那份决策点的
// 上下文随之过时——所以同一判据命中时它落 settled_failed，账本镜像为 runtime_restarted_before_confirmation，
// 由调用方自己决定要不要重新排。判据（托管者是否还活着）与人排的条目完全相同，并存实例因此同样不会误伤它。
// 唯一例外是已经持久提交、绑定正确的 Codex RVF 压缩确认：原生宿主可能仍活着，只读沿用单条截止；
// 真实账本终态再收敛队列。它不回到 queued，也不转成人工重确认。
export const PROGRAMMATIC_INJECTION_SETTLED_BY_RUNTIME_RESTART_FAILURE_NOTE =
	"Kanban restarted while this automated delivery was waiting for the agent to become idle. Automated deliveries do not survive a restart.";

// 只在最新队列确有已提交自动收尾时，才让清扫取得账本锁；普通队列不增加账本 IO。
function hasSubmittedRvfCloseoutQueuedPromptDeliveries(snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot): boolean {
	return Object.values(snapshot.entriesByTaskId).some((entries) =>
		entries.some(
			(entry) =>
				entry.deliveryState === "handed_to_transport" &&
				entry.programmaticInjectionLedgerReceiptLink?.injectionSource === "rvf_automatic_closeout",
		),
	);
}

export async function stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart(input: {
	workspaceId: string;
	runtimeProcessStartedAtEpochMs: number;
	// 做这次清扫的实例。盖章时托管权转移给它——理由见上方「盖章必须同时转移托管权」。
	// 显式传入而不是在这里读 getThisRuntimeProcessInstanceId()：与 liveRuntimeProcessInstanceIds 同一个
	// 道理，让这套判据可被表格化单测（否则「B 盖章、C 跳过、D 再盖章」这条序列根本构造不出来）。
	sweepingRuntimeProcessInstanceId: string;
	// 此刻还活着的 runtime 进程实例 id。由调用方（启动清扫）从心跳注册表读来传入而不是这里自己读：
	// 心跳观测不参与队列/账本的结算锁，且传入让它可被表格化单测。
	liveRuntimeProcessInstanceIds: ReadonlySet<string>;
	custodianLivenessObservationAvailable?: boolean;
	currentTaskSessionSummariesByTaskId?: ReadonlyMap<string, RuntimeTaskSessionSummary | null>;
	nowEpochMs?: number;
}): Promise<{
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	stampedCount: number;
	settledProgrammaticInjectionCount: number;
	recoveredPreflightQueryCustodyCount: number;
}> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const { snapshot, result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current, ledgerRecords) => {
			let stampedCount = 0;
			let settledProgrammaticInjectionCount = 0;
			let recoveredPreflightQueryCustodyCount = 0;
			const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
			for (const [taskId, entries] of Object.entries(current.entriesByTaskId)) {
				entriesByTaskId[taskId] = entries.map((entry) => {
					const recovery = resolveRvfCloseoutCompactionAwareQueuedPromptRecovery({
						workspaceId: input.workspaceId,
						entry,
						ledgerRecords,
						nowEpochMs,
					});
					if (recovery?.kind === "waiting_for_existing_submission") return entry;
					if (recovery?.kind === "settled_existing_submission") {
						settledProgrammaticInjectionCount += 1;
						return settleQueuedRvfCloseoutFromExistingSubmission(entry, recovery);
					}
					const alreadyStampedByThisRuntimeProcess =
						entry.survivedRuntimeRestartAtEpochMs !== null &&
						entry.survivedRuntimeRestartAtEpochMs >= input.runtimeProcessStartedAtEpochMs;
					if (
						alreadyStampedByThisRuntimeProcess ||
						!isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState)
					) {
						return entry;
					}
					const custodianRuntimeProcessInstanceId = entry.custodianRuntimeProcessInstanceId ?? null;
					const survivedARuntimeRestart =
						custodianRuntimeProcessInstanceId === null
							? // 旧条目没有托管者：退回按年龄的保守口径（多盖章，不漏盖）。
								entry.enqueuedAt < input.runtimeProcessStartedAtEpochMs
							: // 托管它的那个实例还在心跳里 ⇒ 这条队伍没断过，别动它。
								!input.liveRuntimeProcessInstanceIds.has(custodianRuntimeProcessInstanceId);
					if (!survivedARuntimeRestart) {
						return entry;
					}
					if (isQueuedTaskPromptDeliveryProgrammaticInjection(entry)) {
						// 原截止时间先于重启恢复判据收口，避免把查询失败改写成通用重启失败。
						if (entry.deliveryState === "queued" && nowEpochMs >= entry.expiresAt) {
							settledProgrammaticInjectionCount += 1;
							return settleExpiredQueuedTaskPromptDeliveryEntry(entry, nowEpochMs);
						}
						const recovery = resolveNativeIndependentUserTurnPreflightRestartRecovery({
							entry,
							summary: input.currentTaskSessionSummariesByTaskId?.get(taskId),
							workspaceId: input.workspaceId,
							nowEpochMs,
						});
						if (
							recovery === "awaiting_session_evidence" ||
							(recovery === "same_session_verified" && input.custodianLivenessObservationAvailable === false)
						)
							return entry;
						if (recovery === "same_session_verified") {
							recoveredPreflightQueryCustodyCount += 1;
							return { ...entry, custodianRuntimeProcessInstanceId: input.sweepingRuntimeProcessInstanceId };
						}
						settledProgrammaticInjectionCount += 1;
						return {
							...entry,
							deliveryState: "settled_failed" as const,
							settledAt: nowEpochMs,
							lastDeliveryFailureNote: PROGRAMMATIC_INJECTION_SETTLED_BY_RUNTIME_RESTART_FAILURE_NOTE,
							...(recovery === "session_replaced" && entry.programmaticInjectionLedgerReceiptLink
								? {
										lastDeliveryFailureNote: "runtime 重启后所需原生会话或代次已改变，未投递。",
										programmaticInjectionLedgerReceiptLink: {
											...entry.programmaticInjectionLedgerReceiptLink,
											settledTerminalDeliveryReceipt: {
												status: "delivery_failed" as const,
												reason: "native_independent_user_turn_session_replaced" as const,
											},
										},
									}
								: {}),
							custodianRuntimeProcessInstanceId: input.sweepingRuntimeProcessInstanceId,
						};
					}
					stampedCount += 1;
					// 确认属于它确认的那一次重启：新一次重启重新盖章时必须把上一次的确认清掉，
					// 否则门控 0 会拿着上一轮的确认放行这一轮。
					return {
						...entry,
						survivedRuntimeRestartAtEpochMs: nowEpochMs,
						humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
						// 托管权交给做这次清扫的实例——见上方「盖章必须同时转移托管权」。
						custodianRuntimeProcessInstanceId: input.sweepingRuntimeProcessInstanceId,
					};
				});
			}
			const changed =
				stampedCount > 0 || settledProgrammaticInjectionCount > 0 || recoveredPreflightQueryCustodyCount > 0;
			return {
				next: changed ? { entriesByTaskId } : current,
				result: { stampedCount, settledProgrammaticInjectionCount, recoveredPreflightQueryCustodyCount },
			};
		},
		nowEpochMs,
		"restart-stamp",
		{ requireCompactionAwareCloseoutLedgerConsistency: true },
	);
	return { snapshot, ...result };
}

// 启动清扫用：收敛被 runtime 重启撂在半路的在途投递。**没有这一步，一次崩溃就能把某个 task 的
// 队列永久卡死**——认领门（见 claimNextQueuedTaskPromptDeliveryRunForDispatch）会被一条
// claimed_for_dispatch / handed_to_transport 的僵尸条目永远挡住，而用户侧三条出路对它全部无效：
// cancel 只覆盖 queued/claimed、dismiss 只覆盖终态、reconfirm 只写时间戳。唯一能动它的是
// settleQueuedTaskPromptDelivery，那是 dispatcher 专用的。所以逃逸口必须由存储层自己给出。
//
// 两种在途条目的归宿**刻意不同**，这正是把认领与交付拆成两步写盘的全部意义：
//   - claimed_for_dispatch —— 一个字节都还没写出去，安全**释放回 queued**，不计一次尝试。
//   - handed_to_transport  —— 语义暧昧（可能已经发出去了），落 settled_failed 并保留可见，
//     由**人**决定要不要重排。绝不自动重投：那会把同一段话送两次。
//
// staleness 判据由调用方传入而不是这里写死，有两个理由：① 预算的真相在 PTY 投递侧
// （TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS），而 src/state → src/terminal 目前
// 是零依赖，不该为一个常量把它掰成双向；② 用「超期」而不是「本进程刚起来」，同机多实例才不会互相
// 把对方**此刻真正在途**的投递判成失败——这正是 pending-task-message-injection-startup-sweep.ts
// 的既有判据，而在途投递恰好有它需要的那个有界预算（排队条目没有，见上面盖章函数的说明）。
export async function settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart(input: {
	workspaceId: string;
	inFlightSettlementBudgetMs: number;
	strandedDeliveryFailureNote: string;
	nowEpochMs?: number;
}): Promise<{
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	releasedClaimCount: number;
	failedStrandedDeliveryCount: number;
	reconciledProgrammaticInjectionCount: number;
	earliestYoungInFlightDeliveryBecomesStaleAtEpochMs: number | null;
}> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const { snapshot, result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current, ledgerRecords) => {
			let releasedClaimCount = 0;
			let failedStrandedDeliveryCount = 0;
			let reconciledProgrammaticInjectionCount = 0;
			let earliestYoungInFlightDeliveryBecomesStaleAtEpochMs: number | null = null;
			const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
			for (const [taskId, entries] of Object.entries(current.entriesByTaskId)) {
				entriesByTaskId[taskId] = entries.map((entry) => {
					const recovery = resolveRvfCloseoutCompactionAwareQueuedPromptRecovery({
						workspaceId: input.workspaceId,
						entry,
						ledgerRecords,
						nowEpochMs,
					});
					if (recovery?.kind === "settled_existing_submission") {
						reconciledProgrammaticInjectionCount += 1;
						return settleQueuedRvfCloseoutFromExistingSubmission(entry, recovery);
					}
					if (entry.deliveryState !== "claimed_for_dispatch" && entry.deliveryState !== "handed_to_transport")
						return entry;
					// 认领没有时间戳（认领刻意不写任何时间字段），所以拿 lastAttemptedAt 兜不住它；
					// 用 enqueuedAt 作为它的年龄下界——一条认领了却超过预算还没交付的条目必然已被撂下。
					const inFlightSinceEpochMs = entry.lastAttemptedAt ?? entry.enqueuedAt;
					const becomesStaleAtEpochMs =
						recovery?.kind === "waiting_for_existing_submission"
							? recovery.becomesStaleAtEpochMs
							: inFlightSinceEpochMs + input.inFlightSettlementBudgetMs;
					if (nowEpochMs < becomesStaleAtEpochMs) {
						earliestYoungInFlightDeliveryBecomesStaleAtEpochMs =
							earliestYoungInFlightDeliveryBecomesStaleAtEpochMs === null
								? becomesStaleAtEpochMs
								: Math.min(earliestYoungInFlightDeliveryBecomesStaleAtEpochMs, becomesStaleAtEpochMs);
						return entry;
					}
					if (entry.deliveryState === "claimed_for_dispatch") {
						releasedClaimCount += 1;
						return {
							...entry,
							deliveryState: "queued" as const,
							claimedForSessionIncarnationId: null,
							claimedAtTurnSequence: null,
						};
					}
					if (entry.deliveryState === "handed_to_transport") {
						failedStrandedDeliveryCount += 1;
						return {
							...entry,
							deliveryState: "settled_failed" as const,
							settledAt: nowEpochMs,
							lastDeliveryFailureNote: input.strandedDeliveryFailureNote,
						};
					}
					return entry;
				});
			}
			const changed =
				releasedClaimCount > 0 || failedStrandedDeliveryCount > 0 || reconciledProgrammaticInjectionCount > 0;
			return {
				next: changed ? { entriesByTaskId } : current,
				result: {
					releasedClaimCount,
					failedStrandedDeliveryCount,
					reconciledProgrammaticInjectionCount,
					earliestYoungInFlightDeliveryBecomesStaleAtEpochMs,
				},
			};
		},
		nowEpochMs,
		"stranded-in-flight-sweep",
		{ requireCompactionAwareCloseoutLedgerConsistency: true },
	);
	return { snapshot, ...result };
}

// 把已过截止时刻、仍标着 queued 的条目**写盘**收敛成 expired。
//
// 平时过期是读-改-写顺手收敛的（见 withExpiredQueuedEntriesSettled），对人排的条目这就够了：没人碰它，它在
// 投影里照样显示 expired、也照样不会被发出去。程序化条目不够——它的调用方在等账本回执，而账本镜像只在
// **写盘**时发生。没有人主动写一次，那条 pending 就会一直挂到下一次有人碰这个队列。出队引擎在截止时刻
// （精确定时器）与每次兜底 sweep 调它。
export async function settleExpiredQueuedTaskPromptDeliveries(input: {
	workspaceId: string;
	nowEpochMs?: number;
}): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => ({ next: withExpiredQueuedEntriesSettled(current, nowEpochMs), result: null }),
		nowEpochMs,
		"settle-expired",
	);
	return snapshot;
}

// 任务离开看板时丢弃它的整条队列（见文件头「生命周期」一节）。
export async function discardQueuedTaskPromptDeliveriesForTasks(input: {
	workspaceId: string;
	taskIds: readonly string[];
	nowEpochMs?: number;
}): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const discardedTaskIds = new Set(input.taskIds);
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
			let removedAny = false;
			for (const [taskId, entries] of Object.entries(current.entriesByTaskId)) {
				// 按会话 id 精确匹配，**或**按条目记下的看板任务 id 匹配——后者把 by-the-way 子会话的队列
				// 一并带走（删除路径手上只有看板任务 id）。旧条目没有 workspaceTaskId，只能精确匹配。
				const retained = discardedTaskIds.has(taskId)
					? []
					: entries.filter((entry) => !discardedTaskIds.has(entry.workspaceTaskId ?? taskId));
				if (retained.length !== entries.length) {
					removedAny = true;
				}
				if (retained.length > 0) {
					entriesByTaskId[taskId] = retained;
				}
			}
			return { next: removedAny ? { entriesByTaskId } : current, result: null };
		},
		nowEpochMs,
		"discard-for-removed-tasks",
	);
	return snapshot;
}
