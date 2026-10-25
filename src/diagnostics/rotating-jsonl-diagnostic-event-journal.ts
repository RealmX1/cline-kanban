// 结构化诊断事件存储：一个通道一个 JSONL 文件，按大小轮转、按数量保留。
//
// 背景：本仓已有若干 `diagnostics/*-logger.ts`（task-session-start、agent-hook-delivery-failure 等）
// 各自实现「stderr + appendFile 双通道 best-effort」的持久化，但它们**都没有轮转、也没有大小上限**——
// 只适合低频事件；一旦某类诊断是高频的（每 30 秒一个采样窗口、每次 pty 启动一条），要么把磁盘写爆，
// 要么被迫降频而丢掉正是排障所需的细粒度。
//
// 于是这里把「细粒度机器可读记录」与「人读日志」拆成两层：
//   - 本模块（机器读）：细粒度事件**一条不丢**地进 JSONL，可 `jq` / `grep` 事后统计，自带轮转不撑爆磁盘；
//   - stderr（人读）：调用方只在**边沿**（进入/退出异常态）与**周期摘要**时输出，保证终端不被刷屏。
//
// 面向复用：任何新的高频 diagnostic 只需在 `DiagnosticEventJournalChannel` 加一个通道名，不必再各自造
// 一套持久化文件与轮转逻辑。
//
// 契约：**永不向调用方抛错、永不返回 Promise**。诊断记录失败绝不能影响被诊断的业务路径，也绝不能制造
// 未处理拒绝。写入按通道串行排队，因此同一通道的行不会交织。

import { existsSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const DIAGNOSTIC_EVENT_JOURNAL_DIR = "diagnostic-event-journals";

// 测试与离线验证用：把 journal 根目录挪出真实的 ~/.cline，避免污染用户运行目录。
export const DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR = "KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR";

// 8 MiB × (1 个活动文件 + 4 个轮转文件) = 每通道最多约 40 MiB 上限。
const DIAGNOSTIC_EVENT_JOURNAL_ACTIVE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_EVENT_JOURNAL_DEFAULT_RETAINED_ROTATED_FILE_COUNT = 4;

// 通道名同时是文件名，故一律用这里声明的 kebab-case 字面量联合（而非任意字符串），
// 既是单一声明点，也从类型上杜绝路径注入。
export type DiagnosticEventJournalChannel =
	| "rvf-late-native-closeout-prompt-acceptance-automatic-recovery"
	| "event-loop-delay-window-sample"
	| "runtime-state-broadcast-cost-window-sample"
	| "codex-native-control-socket-request-diagnostic"
	| "git-command-failure"
	// 以下四个通道原是 2026-08 那次 fd 耗尽调查的临时探针，现已转为常设绊线。转正的理由是根因修复
	// 本身会**抹掉症状而不抹掉成因**：node-pty 的 kqueue 泄漏一旦补上，「谁在高速创建 pty」就不再
	// 表现为 fd 增长，只剩安静的空转，届时这四条通道是仅存的抓手。四者互相印证，缺一条就断链：
	// 创建归因回答「谁在建」，退出记录回答「这些创建是先后还是重叠」（少了它，先后两次刷新与重叠两次
	// 刷新逐字同形），自动重启打点回答「是不是它在成环」，fd 计数回答「这次有没有真的漏」。
	| "pty-session-spawn"
	| "pty-session-exit"
	| "codex-remote-conversation-bootstrap-confirmed"
	| "task-session-auto-restart-scheduled"
	| "process-file-descriptor-count-sample"
	// Kanban 每次调用外部模型 provider 的一条用量记录（用途角色、provider、模型、结果、耗时、token）。
	// 与上面那些「排障绊线」不同，这一条是为**事后统计**而留的：哪些功能在烧钱、哪家 provider 在超时、
	// 某个用途的 token 量级是多少，事后 `jq` 就能算，不必再去翻各功能自己的日志。
	| "model-provider-usage"
	// 按 task 归因的资源占用采集（见 task-attributed-process-tree-resource-sampler.ts）。同属「事后统计」
	// 而非排障绊线：每个被归因的进程在消失时写一条生命周期记录（观测到的峰值 RSS、累计 CPU、存活
	// 时长、是否活过了会话根），每个活会话每 5 分钟写一条按分类聚合的快照。
	| "task-attributed-process-lifetime-episode"
	| "task-attributed-process-tree-periodic-resource-snapshot"
	// Kanban 运行时进程自身的内存 / CPU 基线：「固定服务器成本」的对照，也是进程内 Cline SDK 会话唯一
	// 可见的资源面（它与 Kanban 同进程，无法按 OS 进程拆分）。
	| "kanban-runtime-process-self-resource-sample"
	// 每次工具调用的执行结果（Claude 等经 hook 上报；Cline SDK 经事件流）：时长、成败、中断、截断脱敏后的
	// 命令文本、MCP server/tool。短命令的开销只能靠这里的 duration 看到——进程采样只看得见活过一个采样周期的进程。
	| "agent-tool-call-execution-outcome"
	// `kanban hooks` CLI 进程自身的开销（每次 hook 调用一条）：Kanban 注入到每个 agent 工具调用上的固定成本。
	| "kanban-hook-cli-invocation-resource-usage"
	// 模型 token 用量的「累计快照」：每条 = 截至此刻某个原生会话的累计用量（报告取每会话最后一条）。
	| "task-agent-conversation-model-token-usage-cumulative-snapshot"
	// task worktree 的实体磁盘体积（不跟随符号链接），低频测量。
	| "task-worktree-disk-usage-measurement";

// 默认保留深度对排障绊线足够（只需覆盖「上一次出事」），但资源占用通道要支持按 task / 时间窗回看
// 数周：单独放宽。读取侧必须经 listExistingDiagnosticEventJournalShardFilePathsOldestFirst 走同一个
// resolver，保证「轮转保留了什么」与「报告读到了什么」是同一个窗口。
const DIAGNOSTIC_EVENT_JOURNAL_RETAINED_ROTATED_FILE_COUNT_OVERRIDES_BY_CHANNEL: Partial<
	Record<DiagnosticEventJournalChannel, number>
> = {
	// 25 个活会话估算约 5 MB/天，12 个轮转分片 + 活动文件 ≈ 104 MiB ≈ 三周。
	"task-attributed-process-lifetime-episode": 12,
	"task-attributed-process-tree-periodic-resource-snapshot": 12,
	"agent-tool-call-execution-outcome": 12,
	"kanban-hook-cli-invocation-resource-usage": 12,
	"task-agent-conversation-model-token-usage-cumulative-snapshot": 12,
};

export function resolveDiagnosticEventJournalRetainedRotatedFileCount(channel: DiagnosticEventJournalChannel): number {
	return (
		DIAGNOSTIC_EVENT_JOURNAL_RETAINED_ROTATED_FILE_COUNT_OVERRIDES_BY_CHANNEL[channel] ??
		DIAGNOSTIC_EVENT_JOURNAL_DEFAULT_RETAINED_ROTATED_FILE_COUNT
	);
}

// 以下字段由本模块权威写入。类型上的 `never` 只能挡住对象字面量与已知形状的展开：一个声明为
// `Record<string, unknown>` 的变量传进来时 TS 不会拿索引签名去比对可选属性，编译期一个错都不报。
// 因此运行时另有一道无条件覆盖（见 serializeDiagnosticEventJournalLine），两道一起才真的杜绝覆盖。
export type DiagnosticEventJournalPayload = Record<string, unknown> & {
	recordedAtIso?: never;
	channel?: never;
	journalWriterProcessId?: never;
	journalWriterProcessStartedAtIso?: never;
};

interface DiagnosticEventJournalChannelWriteState {
	// 同通道写入串行化，避免多个 appendFile 并发导致行交织。
	pendingWriteChain: Promise<void>;
	// 活动文件当前字节数；null 表示本进程尚未探测过磁盘上的既有文件。
	activeFileByteSize: number | null;
}

// 以「活动文件绝对路径」而非通道名作键：根目录被 env 改写时（测试、离线验证）自然失效重建，
// 不会把上一份目录的尺寸缓存带到下一份。
const diagnosticEventJournalWriteStatesByActiveFilePath = new Map<string, DiagnosticEventJournalChannelWriteState>();

export function getDiagnosticEventJournalDirectoryPath(): string {
	const rootDirOverride = process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR];
	if (rootDirOverride) {
		return rootDirOverride;
	}
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR, DIAGNOSTIC_EVENT_JOURNAL_DIR);
}

export function getDiagnosticEventJournalActiveFilePath(channel: DiagnosticEventJournalChannel): string {
	return join(getDiagnosticEventJournalDirectoryPath(), `${channel}.jsonl`);
}

function getDiagnosticEventJournalRotatedFilePath(
	channel: DiagnosticEventJournalChannel,
	rotationIndex: number,
): string {
	return join(getDiagnosticEventJournalDirectoryPath(), `${channel}.${rotationIndex}.jsonl`);
}

// 读取侧入口：从最旧的轮转分片到活动文件，只列出实际存在的文件。按时间正序拼接即得到完整窗口。
// 读取途中发生轮转会让某个分片改名，调用方应容忍 ENOENT（跳过即可，丢的只是边界上的几行）。
export function listExistingDiagnosticEventJournalShardFilePathsOldestFirst(
	channel: DiagnosticEventJournalChannel,
): string[] {
	const shardFilePaths: string[] = [];
	for (
		let rotationIndex = resolveDiagnosticEventJournalRetainedRotatedFileCount(channel);
		rotationIndex >= 1;
		rotationIndex--
	) {
		const rotatedFilePath = getDiagnosticEventJournalRotatedFilePath(channel, rotationIndex);
		if (existsSync(rotatedFilePath)) {
			shardFilePaths.push(rotatedFilePath);
		}
	}
	const activeFilePath = getDiagnosticEventJournalActiveFilePath(channel);
	if (existsSync(activeFilePath)) {
		shardFilePaths.push(activeFilePath);
	}
	return shardFilePaths;
}

// journal 落点按用户固定（`~/.cline/kanban/…`），与运行实例无关：同一台机器上并行跑多个 Kanban
// 实例（例如一个监听 3484 端口、另一个监听 3485）时，两个进程写的是**同一组文件**，样本在同一份
// JSONL 里逐行交织。没有写入方标识就无法把任一通道拆回单进程视角，任何「A 通道的增量 ≈ B 通道的
// 增量」式对账都不成立。因此标识写在**序列化核心**而不是各调用点：所有通道一并覆盖，调用方无从遗漏。
//
// 名字带 `journalWriter` 前缀是必需的消歧：像 `git-command-failure` 这样的通道，整条记录讲的都是
// **另一个**进程（被 spawn 的 git 子进程）的事，一个光秃秃的 `processId` 摆在 `errorCode` / `args`
// 旁边，最自然的读法恰好是错的。
const DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_ID = process.pid;

// pid 会被操作系统回收复用，而单通道保留 5 个文件 × 8 MiB 可覆盖数十天：同一个 pid 在一份 journal
// 里既可能属于当前实例，也可能属于几周前那个早已退出的实例，只按 pid 分组会把两次运行的样本混成
// 一条时间线——恰好毁掉「拆回单进程视角」这个目的。配上进程启动时刻才构成真正唯一的键。
const DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_STARTED_AT_ISO = new Date(
	Date.now() - Math.round(process.uptime() * 1000),
).toISOString();

// 序列化失败（循环引用、BigInt 等）不得让调用方崩溃：降级成一条自述失败原因的记录，
// 保住「这一刻确实发生过一个事件」这个事实，而不是整条丢掉。
export function serializeDiagnosticEventJournalLine(
	channel: DiagnosticEventJournalChannel,
	payload: DiagnosticEventJournalPayload,
	recordedAtIso: string,
): string {
	// 权威字段先写一遍以固定 JSON 里的键序（时间戳与来源在最前，便于肉眼扫），payload 展开之后
	// 再无条件写回一遍以夺回所有权——绕过类型约束传进来的同名键只会被覆盖，绝不会污染记录。
	const record: Record<string, unknown> = {
		recordedAtIso,
		journalWriterProcessId: DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_ID,
		journalWriterProcessStartedAtIso: DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_STARTED_AT_ISO,
		channel,
		...payload,
	};
	record.recordedAtIso = recordedAtIso;
	record.journalWriterProcessId = DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_ID;
	record.journalWriterProcessStartedAtIso = DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_STARTED_AT_ISO;
	record.channel = channel;

	try {
		return `${JSON.stringify(record)}\n`;
	} catch (error) {
		const serializationError = error instanceof Error ? error.message : String(error);
		return `${JSON.stringify({
			recordedAtIso,
			journalWriterProcessId: DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_ID,
			journalWriterProcessStartedAtIso: DIAGNOSTIC_EVENT_JOURNAL_WRITER_PROCESS_STARTED_AT_ISO,
			channel,
			journalPayloadSerializationError: serializationError,
		})}\n`;
	}
}

function getOrCreateDiagnosticEventJournalWriteState(activeFilePath: string): DiagnosticEventJournalChannelWriteState {
	const existingState = diagnosticEventJournalWriteStatesByActiveFilePath.get(activeFilePath);
	if (existingState) {
		return existingState;
	}
	const createdState: DiagnosticEventJournalChannelWriteState = {
		pendingWriteChain: Promise.resolve(),
		activeFileByteSize: null,
	};
	diagnosticEventJournalWriteStatesByActiveFilePath.set(activeFilePath, createdState);
	return createdState;
}

async function probeExistingActiveFileByteSize(activeFilePath: string): Promise<number> {
	try {
		const activeFileStats = await stat(activeFilePath);
		return activeFileStats.size;
	} catch {
		// 文件不存在（首次写入）即视为 0 字节。
		return 0;
	}
}

async function renameDiagnosticEventJournalFileIfPresent(fromPath: string, toPath: string): Promise<void> {
	try {
		await rename(fromPath, toPath);
	} catch {
		// 轮转链上缺环（对应序号尚未产生）属正常，忽略。
	}
}

// 轮转：删掉最旧的一档，其余整体后移一位，活动文件降为 .1。
async function rotateDiagnosticEventJournalFiles(channel: DiagnosticEventJournalChannel): Promise<void> {
	const retainedRotatedFileCount = resolveDiagnosticEventJournalRetainedRotatedFileCount(channel);
	const oldestRotatedFilePath = getDiagnosticEventJournalRotatedFilePath(channel, retainedRotatedFileCount);
	await rm(oldestRotatedFilePath, { force: true });
	for (let rotationIndex = retainedRotatedFileCount - 1; rotationIndex >= 1; rotationIndex--) {
		await renameDiagnosticEventJournalFileIfPresent(
			getDiagnosticEventJournalRotatedFilePath(channel, rotationIndex),
			getDiagnosticEventJournalRotatedFilePath(channel, rotationIndex + 1),
		);
	}
	await renameDiagnosticEventJournalFileIfPresent(
		getDiagnosticEventJournalActiveFilePath(channel),
		getDiagnosticEventJournalRotatedFilePath(channel, 1),
	);
}

async function appendLineToDiagnosticEventJournalChannel(
	channel: DiagnosticEventJournalChannel,
	activeFilePath: string,
	writeState: DiagnosticEventJournalChannelWriteState,
	line: string,
): Promise<void> {
	await mkdir(getDiagnosticEventJournalDirectoryPath(), { recursive: true });
	if (writeState.activeFileByteSize === null) {
		writeState.activeFileByteSize = await probeExistingActiveFileByteSize(activeFilePath);
	}
	const lineByteSize = Buffer.byteLength(line, "utf8");
	// 空文件即便单行超限也不轮转，否则会退化成「每行一个文件」。
	if (
		writeState.activeFileByteSize > 0 &&
		writeState.activeFileByteSize + lineByteSize > DIAGNOSTIC_EVENT_JOURNAL_ACTIVE_FILE_MAX_BYTES
	) {
		await rotateDiagnosticEventJournalFiles(channel);
		writeState.activeFileByteSize = 0;
	}
	await appendFile(activeFilePath, line, "utf8");
	writeState.activeFileByteSize += lineByteSize;
}

// fire-and-forget：同步返回，写入排进本通道的串行队列。任何失败都在内部吞掉。
export function appendDiagnosticEventToRotatingJsonlJournal(
	channel: DiagnosticEventJournalChannel,
	payload: DiagnosticEventJournalPayload,
): void {
	const line = serializeDiagnosticEventJournalLine(channel, payload, new Date().toISOString());
	const activeFilePath = getDiagnosticEventJournalActiveFilePath(channel);
	const writeState = getOrCreateDiagnosticEventJournalWriteState(activeFilePath);
	writeState.pendingWriteChain = writeState.pendingWriteChain
		.then(() => appendLineToDiagnosticEventJournalChannel(channel, activeFilePath, writeState, line))
		.catch(() => {
			// Best-effort persistence only —— 写失败既不冒泡，也不得中断后续写入链。
			// 磁盘状态已不可信，清空尺寸缓存，下次写入重新探测。
			writeState.activeFileByteSize = null;
		});
}

// 供测试与优雅关停使用：等待所有通道当前排队的写入落盘。
export async function waitForPendingDiagnosticEventJournalWrites(): Promise<void> {
	await Promise.all(
		Array.from(
			diagnosticEventJournalWriteStatesByActiveFilePath.values(),
			(writeState) => writeState.pendingWriteChain,
		),
	);
}
