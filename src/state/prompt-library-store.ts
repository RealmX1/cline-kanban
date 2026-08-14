// Prompt Library 的**服务端**真相源。
//
// 为什么要搬到服务端（原先只活在浏览器 localStorage 里）：
//   - localStorage 是 per-origin 的。`npm run web:dev` 在 4173、`npm run dev:full` 每次挑一个空闲端口，
//     换一个端口就是全新的一份库——这比「换浏览器」频繁得多，是现实中最主要的分叉轴。
//   - W2 的 Ctrl+S 暂存与 W1 争用抢占时的「无损暂存人类输入」都由**运行时**发起。浏览器侧的库
//     接不住运行时发起的写入，这两条特性因此必须先有服务端库才能落地。
//
// ## 落点：独立文件，board.json 一个字节都不加
//
// `use-prompt-library.ts` 的旧注释建议「per-task → 新的 RuntimeBoardCard 字段写进 board.json」，
// **不采纳**：实测最大的一份 board.json 已达 1,029,751 字节 / 258 张卡，其中 73% 是 prompt 正文；
// 而 board.json 是每次看板改动都整体读写 + 广播的最热路径。把易膨胀数据塞进去等于把膨胀直接打在
// 那条最热的链上，且日后想搬出来还得再迁一次。
//
//   全局 scope   ~/.cline/kanban/prompt-library.json                        （跨项目共用）
//   repo / task  ~/.cline/kanban/workspaces/<workspaceId>/prompt-library.json（project.id 即 workspaceId）
//
// ## 为什么写操作是「意图」而不是整份 PUT
//
// 同一个库会被多个标签页、以及运行时自己（Ctrl+S 暂存 / 争用抢占）同时写。整份 PUT 的
// last-write-wins 会让「另一个标签页刚加的条目」被静默抹掉。这里改成把意图（新增/改文/删除/换 scope）
// 送到服务端，在**文件锁内**读-改-写，于是并发写自然合并而不是互相覆盖。
//
// 生命周期代价（明知并接受）：卡片删除时不再自动带走这些数据。任务删除路径按 taskId 清理草稿，
// 但 prompt library 条目**不随任务删除而删**——它是用户资产，只把 scope:task 的条目标记为孤儿供回收，
// 绝不「删任务顺手毁掉用户攒的模板」。

import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
	type PromptLibraryScope,
	type StoredPromptLibraryEntry,
	storedPromptLibraryEntrySchema,
	type WorkspacePromptLibraryMutation,
	type WorkspacePromptLibrarySnapshot,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath, getWorkspaceDirectoryPath } from "./workspace-state";

const PROMPT_LIBRARY_FILENAME = "prompt-library.json";

// 「scope:task 但调用方漏了 taskId」的条目落在这个键下。真实 taskId 不会长这样，于是没有任何任务的
// 可见集合会把它捞出来——内容留着，可见性不外泄。详见 withEntryAppended 里的取舍说明。
export const TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID =
	"__task_scoped_prompts_quarantined_for_missing_task_id__";

// 全局 scope 的条目跨项目共用，故落在 kanban 根目录而不是任何一个 workspace 下。
export function getGlobalPromptLibraryPath(): string {
	return join(getRuntimeHomePath(), PROMPT_LIBRARY_FILENAME);
}

export function getWorkspacePromptLibraryPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), PROMPT_LIBRARY_FILENAME);
}

interface GlobalPromptLibraryFileContent {
	globalScopedPrompts: StoredPromptLibraryEntry[];
}

interface WorkspacePromptLibraryFileContent {
	repoScopedPrompts: StoredPromptLibraryEntry[];
	taskScopedPromptsByTaskId: Record<string, StoredPromptLibraryEntry[]>;
}

// 逐条校验、丢弃坏条目而不是让整份库读失败：一条被手工编辑坏的记录不该连累其余全部模板。
function parsePromptEntryList(value: unknown): StoredPromptLibraryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const entries: StoredPromptLibraryEntry[] = [];
	for (const candidate of value) {
		const parsed = storedPromptLibraryEntrySchema.safeParse(candidate);
		if (parsed.success) {
			entries.push(parsed.data);
		}
	}
	return entries;
}

function parsePromptEntryListsByKey(value: unknown): Record<string, StoredPromptLibraryEntry[]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const listsByKey: Record<string, StoredPromptLibraryEntry[]> = {};
	for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
		const entries = parsePromptEntryList(candidate);
		if (entries.length > 0) {
			listsByKey[key] = entries;
		}
	}
	return listsByKey;
}

// 「文件不存在」与「文件在那儿但这次读不出来」对**读**路径同样是空库，对**写**路径则天差地别：
// 拿「读坏了 → 空库」这份降级快照去原子覆盖那份损坏文件，等于把一个还能人工修复的状态变成不可逆的
// 用户资产丢失。所以读取结果必须把两者分开，由调用方决定怎么用。
type PromptLibraryFileReadOutcome =
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

async function readPromptLibraryFileDistinguishingAbsentFromUnreadable(
	path: string,
): Promise<PromptLibraryFileReadOutcome> {
	let fileText: string;
	try {
		fileText = await readFile(path, "utf8");
	} catch (readFailure) {
		// 只有 ENOENT 才是「首次使用」。EACCES / EISDIR / EIO 等都意味着文件就在那儿、只是这次读不到，
		// 一律按损坏对待——把它们当成空库正是「拿空库盖掉用户资产」的入口。
		return isFileNotFoundFailure(readFailure) ? { status: "absent" } : { status: "present_but_unreadable" };
	}
	try {
		return { status: "parsed", parsedContent: JSON.parse(fileText) };
	} catch {
		return { status: "present_but_unreadable" };
	}
}

interface PromptLibraryFileReadResult<TContent> {
	content: TContent;
	filePresentButUnreadable: boolean;
}

function asParsedRecord(outcome: PromptLibraryFileReadOutcome): Record<string, unknown> {
	if (outcome.status !== "parsed" || typeof outcome.parsedContent !== "object" || outcome.parsedContent === null) {
		return {};
	}
	return outcome.parsedContent as Record<string, unknown>;
}

async function readGlobalPromptLibraryFile(): Promise<PromptLibraryFileReadResult<GlobalPromptLibraryFileContent>> {
	const outcome = await readPromptLibraryFileDistinguishingAbsentFromUnreadable(getGlobalPromptLibraryPath());
	const record = asParsedRecord(outcome);
	return {
		content: { globalScopedPrompts: parsePromptEntryList(record.globalScopedPrompts) },
		filePresentButUnreadable: outcome.status === "present_but_unreadable",
	};
}

async function readWorkspacePromptLibraryFile(
	workspaceId: string,
): Promise<PromptLibraryFileReadResult<WorkspacePromptLibraryFileContent>> {
	const outcome = await readPromptLibraryFileDistinguishingAbsentFromUnreadable(
		getWorkspacePromptLibraryPath(workspaceId),
	);
	const record = asParsedRecord(outcome);
	return {
		content: {
			repoScopedPrompts: parsePromptEntryList(record.repoScopedPrompts),
			taskScopedPromptsByTaskId: parsePromptEntryListsByKey(record.taskScopedPromptsByTaskId),
		},
		filePresentButUnreadable: outcome.status === "present_but_unreadable",
	};
}

interface WorkspacePromptLibrarySnapshotWithFileReadability {
	snapshot: WorkspacePromptLibrarySnapshot;
	globalFilePresentButUnreadable: boolean;
	workspaceFilePresentButUnreadable: boolean;
}

async function readWorkspacePromptLibrarySnapshotWithFileReadability(
	workspaceId: string,
): Promise<WorkspacePromptLibrarySnapshotWithFileReadability> {
	const [globalFile, workspaceFile] = await Promise.all([
		readGlobalPromptLibraryFile(),
		readWorkspacePromptLibraryFile(workspaceId),
	]);
	return {
		snapshot: {
			globalScopedPrompts: globalFile.content.globalScopedPrompts,
			repoScopedPrompts: workspaceFile.content.repoScopedPrompts,
			taskScopedPromptsByTaskId: workspaceFile.content.taskScopedPromptsByTaskId,
		},
		globalFilePresentButUnreadable: globalFile.filePresentButUnreadable,
		workspaceFilePresentButUnreadable: workspaceFile.filePresentButUnreadable,
	};
}

// 读路径继续把「不存在」与「读坏了」一起降级成空库：空库是安全默认值，而把「读不出来」抛给调用方
// 只会让面板整个打不开。只有写路径需要分辨两者。
export async function readWorkspacePromptLibrarySnapshot(workspaceId: string): Promise<WorkspacePromptLibrarySnapshot> {
	return (await readWorkspacePromptLibrarySnapshotWithFileReadability(workspaceId)).snapshot;
}

// 在三个桶里按 id 找条目，并连同「它此刻落在哪个桶」一起返回——换 scope 要先知道它现在在哪儿。
function locateEntry(
	snapshot: WorkspacePromptLibrarySnapshot,
	promptId: string,
): { entry: StoredPromptLibraryEntry; scope: PromptLibraryScope; taskId: string | null } | null {
	const globalEntry = snapshot.globalScopedPrompts.find((prompt) => prompt.id === promptId);
	if (globalEntry) {
		return { entry: globalEntry, scope: "global", taskId: null };
	}
	const repoEntry = snapshot.repoScopedPrompts.find((prompt) => prompt.id === promptId);
	if (repoEntry) {
		return { entry: repoEntry, scope: "repo", taskId: null };
	}
	for (const [taskId, prompts] of Object.entries(snapshot.taskScopedPromptsByTaskId)) {
		const taskEntry = prompts.find((prompt) => prompt.id === promptId);
		if (taskEntry) {
			return { entry: taskEntry, scope: "task", taskId };
		}
	}
	return null;
}

function withEntryRemoved(snapshot: WorkspacePromptLibrarySnapshot, promptId: string): WorkspacePromptLibrarySnapshot {
	const taskScopedPromptsByTaskId: Record<string, StoredPromptLibraryEntry[]> = {};
	for (const [taskId, prompts] of Object.entries(snapshot.taskScopedPromptsByTaskId)) {
		const remaining = prompts.filter((prompt) => prompt.id !== promptId);
		if (remaining.length > 0) {
			taskScopedPromptsByTaskId[taskId] = remaining;
		}
	}
	return {
		globalScopedPrompts: snapshot.globalScopedPrompts.filter((prompt) => prompt.id !== promptId),
		repoScopedPrompts: snapshot.repoScopedPrompts.filter((prompt) => prompt.id !== promptId),
		taskScopedPromptsByTaskId,
	};
}

function withEntryAppended(
	snapshot: WorkspacePromptLibrarySnapshot,
	entry: StoredPromptLibraryEntry,
	taskId: string | null,
): WorkspacePromptLibrarySnapshot {
	if (entry.scope === "global") {
		return { ...snapshot, globalScopedPrompts: [...snapshot.globalScopedPrompts, entry] };
	}
	if (entry.scope === "repo") {
		return { ...snapshot, repoScopedPrompts: [...snapshot.repoScopedPrompts, entry] };
	}
	// scope:task 却没有 taskId 是调用方的错，契约层（workspacePromptLibraryMutationSchema）已经把它挡在
	// 边界外，这里只是纵深防御——in-process 调用方（终端 Ctrl+S 暂存、争用抢占）不过 zod，仍可能漏传。
	//
	// 取舍（两条都不能违反）：
	//   - 不丢内容：直接丢弃会毁掉用户刚打的字，暂存路径丢了就真没了；
	//   - 不泄漏可见性：曾经的做法是降级进 repo 桶，那会把「本该只给某个任务看」的文字变成整仓库可见，
	//     这是可见性事故，比分类不整洁严重得多。
	// 折中：存进一个**没有任何真实 taskId 能等于**的隔离桶键。文字原样留在磁盘上、可人工找回或日后由
	// 回收路径认领，但对所有任务都不可见——宁可让该看的人暂时看不到，也不让不该看的人看到。
	if (taskId === null) {
		const alreadyQuarantinedPrompts =
			snapshot.taskScopedPromptsByTaskId[TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID] ?? [];
		return {
			...snapshot,
			taskScopedPromptsByTaskId: {
				...snapshot.taskScopedPromptsByTaskId,
				[TASK_SCOPED_PROMPT_BUCKET_KEY_FOR_MUTATIONS_MISSING_TASK_ID]: [...alreadyQuarantinedPrompts, entry],
			},
		};
	}
	return {
		...snapshot,
		taskScopedPromptsByTaskId: {
			...snapshot.taskScopedPromptsByTaskId,
			[taskId]: [...(snapshot.taskScopedPromptsByTaskId[taskId] ?? []), entry],
		},
	};
}

// 把一条意图应用到快照上。纯函数——并发合并的正确性来自调用方持锁重读，这里只负责语义。
export function applyWorkspacePromptLibraryMutation(
	snapshot: WorkspacePromptLibrarySnapshot,
	mutation: WorkspacePromptLibraryMutation,
	nowEpochMs: number,
): WorkspacePromptLibrarySnapshot {
	if (mutation.kind === "remove_prompt") {
		return withEntryRemoved(snapshot, mutation.promptId);
	}
	if (mutation.kind === "set_prompt_scope") {
		const located = locateEntry(snapshot, mutation.promptId);
		if (!located) {
			return snapshot;
		}
		// 条目落在哪个桶由 (scope, taskId) 一起决定；scope 不是 task 时没有任务维度，归一成 null 再比。
		const requestedTaskIdForTaskScope = mutation.scope === "task" ? (mutation.taskId ?? null) : null;
		// 只有「连桶都没换」才是无操作。只比 scope 会把「同为 task scope 但从 task-A 搬到 task-B」误判成
		// 无操作——那是意图 schema 明确支持的跨任务搬移，被吞掉的表现就是条目仍留在原任务下。
		if (located.scope === mutation.scope && located.taskId === requestedTaskIdForTaskScope) {
			return snapshot;
		}
		const moved: StoredPromptLibraryEntry = { ...located.entry, scope: mutation.scope, updatedAt: nowEpochMs };
		return withEntryAppended(withEntryRemoved(snapshot, mutation.promptId), moved, requestedTaskIdForTaskScope);
	}
	const located = locateEntry(snapshot, mutation.promptId);
	if (located) {
		// 已存在：只改正文，**不**动它当前所在的桶。换 scope 是另一条意图，混在改文里做会让
		// 「两个标签页一个在改文、一个在换 scope」互相把对方的操作撤销掉。
		const updated: StoredPromptLibraryEntry = { ...located.entry, text: mutation.text, updatedAt: nowEpochMs };
		return withEntryAppended(withEntryRemoved(snapshot, mutation.promptId), updated, located.taskId);
	}
	const created: StoredPromptLibraryEntry = {
		id: mutation.promptId,
		text: mutation.text,
		scope: mutation.scope,
		origin: mutation.origin,
		createdAt: nowEpochMs,
		updatedAt: nowEpochMs,
	};
	return withEntryAppended(snapshot, created, mutation.taskId ?? null);
}

// 覆盖一份读不出来的库文件之前，先把原始字节整体搬到旁路留存——损坏的文件里通常一个字节的正文都没少，
// 人工（或日后的回收路径）还救得回来，被空快照盖掉就真没了。
//
// 为什么是「搬走再写」而不是「拒绝写入」：拒绝会让终端 Ctrl+S 暂存、争用抢占这些运行时发起的写入直接失败，
// 用户刚打的字同样没了——那是用另一种资产丢失去换这一种。搬走既保住旧资产，也不挡住新写入。
// 搬移失败则让错误抛出去、这次写入告吹：宁可写失败（用户还能重试），也不在没留下副本时覆盖损坏文件。
function buildUnreadablePromptLibraryQuarantinePath(libraryPath: string, nowEpochMs: number): string {
	// 带 uuid 后缀，避免同一毫秒内的第二次隔离把上一份留存覆盖掉——留存文件本身也是用户资产。
	return `${libraryPath}.unreadable-quarantined-before-overwrite-${nowEpochMs}-${randomUUID()}.json`;
}

async function quarantineUnreadablePromptLibraryFileBeforeOverwrite(
	libraryPath: string,
	nowEpochMs: number,
): Promise<void> {
	await rename(libraryPath, buildUnreadablePromptLibraryQuarantinePath(libraryPath, nowEpochMs));
}

function collectPromptIdsHeldByWorkspaceFile(snapshot: WorkspacePromptLibrarySnapshot): Set<string> {
	const promptIds = new Set<string>();
	for (const prompt of snapshot.repoScopedPrompts) {
		promptIds.add(prompt.id);
	}
	for (const prompts of Object.values(snapshot.taskScopedPromptsByTaskId)) {
		for (const prompt of prompts) {
			promptIds.add(prompt.id);
		}
	}
	return promptIds;
}

// 一次 mutation 至多把一条条目从一份文件搬到另一份，所以「接收方」至多一份。返回 true 表示这次搬移的
// 目的地是 workspace 文件（global → repo/task），它必须先于 global 文件落盘；见写序一节。
// 不涉及跨文件搬移时（纯新增 / 纯改文 / 纯删除）只有一份文件会被写，两个分支等价，返回值无所谓。
function isWorkspaceFileTheDestinationOfThisMutation(
	current: WorkspacePromptLibrarySnapshot,
	next: WorkspacePromptLibrarySnapshot,
): boolean {
	const promptIdsHeldBefore = collectPromptIdsHeldByWorkspaceFile(current);
	for (const promptId of collectPromptIdsHeldByWorkspaceFile(next)) {
		if (!promptIdsHeldBefore.has(promptId)) {
			return true;
		}
	}
	return false;
}

// 三个桶分居两份文件（global 一份，repo/task 一份），而换 scope 会把条目从任意一个桶搬到任意另一个桶。
// 两份文件各有各的锁，故两把锁一起拿——lockedFileSystem 会按路径排序获取，避免「A 先拿全局、B 先拿
// workspace」互等的死锁。
//
// ## 两把锁只串行化 writer，**不**提供跨文件原子性（明知并接受）
//
// 拿住两把锁只保证「同一时刻只有一个 writer 在动这两份文件」。落盘仍是两次彼此独立的
// writeJsonFileAtomic，原子性只在**单份文件内部**成立，跨两份文件没有任何事务语义。已知窗口三条：
//
//   1. 撕裂读：两次写之间的并发**读**会看到中间态。readWorkspacePromptLibrarySnapshot 自身不加锁
//      （本仓读路径一律裸读），搬移中的条目可能在三个桶里都查不到；
//   2. `global → repo/task` 若在两次写之间崩溃：写序错的话条目已从 global 删掉、还没写进 workspace，
//      **永久丢失**；
//   3. `repo/task → global` 若在两次写之间崩溃：写序错的话条目在两份文件里**同时存在**，永久重复。
//
// ## 写序是刻意的：先写条目要**进入**的那份文件，再写它要**离开**的那份文件
//
// 别按字母序、也别按代码里字段出现的顺序重排下面两次写——写序是这里唯一拿得到的保护，它把窗口 2、3
// 的坏结果统一压成同一种：
//   - 先写目的地：崩在窗口里 → 条目在新旧两处**同时存在**（暂时重复，用户看得见、能自己删掉）；
//   - 先写来源地：崩在窗口里 → 条目已从旧处删除、还没写进新处（**永久丢失**，用户无从恢复）。
// 两种坏结果只有前者可逆，所以固定「目的地在前」。
//
// ## 为什么不上更强的手段（按仓内惯例定案）
//
// 本仓已有两处结构完全相同的实现接受同一个窗口：src/config/runtime-config.ts 的 saveRuntimeConfig /
// updateRuntimeConfig（两份 config 文件、两把锁、两次独立原子写），以及 src/state/workspace-state.ts 的
// saveWorkspaceState（board / sessions / meta 三次顺序原子写、一把目录锁）；而
// src/deployment/post-deploy-verification-state.ts 的 runAutomaticCleanupForVerifiedTask 正是「固定写序 +
// 容忍中间态 + 只守住危险的那一侧」的既有写法。已排除的三条更强方案及其理由：
//   - 给读路径加跨进程锁：本仓读路径（board.json / sessions.json / config / 本文件）一律裸读，且
//     AGENTS.md 记录过一次 proper-lockfile 锁放大把整个 server 拖死的事故；
//   - journal / 两阶段提交 / 崩溃自愈日志：locked-file-system.ts 全无此类原语，本仓既有的崩溃自愈一律是
//     **单文件内**的状态机自愈，跨文件日志会是头一份；
//   - 读端按 updatedAt 互相校对去重：本仓没有「两份对等文件互校取新」的先例，那会改变读语义。
// 真正的跨文件持久化原子性，留到这份存储接上 UI 消费者的那一轮（W3b 合并迁移）再统一设计。
export async function mutateWorkspacePromptLibrary(
	workspaceId: string,
	mutation: WorkspacePromptLibraryMutation,
	nowEpochMs: number = Date.now(),
): Promise<WorkspacePromptLibrarySnapshot> {
	const globalPath = getGlobalPromptLibraryPath();
	const workspacePath = getWorkspacePromptLibraryPath(workspaceId);
	return await lockedFileSystem.withLocks(
		[
			{ path: globalPath, type: "file" },
			{ path: workspacePath, type: "file" },
		],
		async () => {
			// 必须在锁内重读：锁外读到的快照可能已被另一个进程 / 标签页改过，基于它写回就是静默覆盖。
			// 这里要的是带「每份文件是否读坏了」的重读——写路径不能像读路径那样把损坏当空库。
			const currentRead = await readWorkspacePromptLibrarySnapshotWithFileReadability(workspaceId);
			const current = currentRead.snapshot;
			const next = applyWorkspacePromptLibraryMutation(current, mutation, nowEpochMs);
			// 两个写步骤都自带「没变就不写」：改一条 task prompt 不该顺手重写全局库（也就不会与另一个
			// workspace 的并发全局写产生无谓的争用）。落盘顺序由下面的写序决定，不是这里的书写顺序。
			const writeGlobalPromptLibraryFileIfItChanged = async (): Promise<void> => {
				if (next.globalScopedPrompts === current.globalScopedPrompts) {
					return;
				}
				if (currentRead.globalFilePresentButUnreadable) {
					await quarantineUnreadablePromptLibraryFileBeforeOverwrite(globalPath, nowEpochMs);
				}
				await lockedFileSystem.writeJsonFileAtomic(
					globalPath,
					{ globalScopedPrompts: next.globalScopedPrompts } satisfies GlobalPromptLibraryFileContent,
					{ lock: null },
				);
			};
			const writeWorkspacePromptLibraryFileIfItChanged = async (): Promise<void> => {
				if (
					next.repoScopedPrompts === current.repoScopedPrompts &&
					next.taskScopedPromptsByTaskId === current.taskScopedPromptsByTaskId
				) {
					return;
				}
				if (currentRead.workspaceFilePresentButUnreadable) {
					await quarantineUnreadablePromptLibraryFileBeforeOverwrite(workspacePath, nowEpochMs);
				}
				await lockedFileSystem.writeJsonFileAtomic(
					workspacePath,
					{
						repoScopedPrompts: next.repoScopedPrompts,
						taskScopedPromptsByTaskId: next.taskScopedPromptsByTaskId,
					} satisfies WorkspacePromptLibraryFileContent,
					{ lock: null },
				);
			};
			// 刻意的写序：目的地文件在前、来源文件在后。理由见函数上方「写序是刻意的」一节，别重排。
			if (isWorkspaceFileTheDestinationOfThisMutation(current, next)) {
				await writeWorkspacePromptLibraryFileIfItChanged();
				await writeGlobalPromptLibraryFileIfItChanged();
			} else {
				await writeGlobalPromptLibraryFileIfItChanged();
				await writeWorkspacePromptLibraryFileIfItChanged();
			}
			return next;
		},
	);
}
