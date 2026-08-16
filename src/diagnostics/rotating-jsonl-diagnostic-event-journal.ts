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
const DIAGNOSTIC_EVENT_JOURNAL_RETAINED_ROTATED_FILE_COUNT = 4;

// 通道名同时是文件名，故一律用这里声明的 kebab-case 字面量联合（而非任意字符串），
// 既是单一声明点，也从类型上杜绝路径注入。
export type DiagnosticEventJournalChannel =
	| "event-loop-delay-window-sample"
	| "git-command-failure"
	// 以下三个通道属本次 fd 泄漏调查的临时探针（build-probing 分支），定案后随探针一并摘除。
	| "pty-session-spawn"
	| "task-session-auto-restart-scheduled"
	| "process-file-descriptor-count-sample";

// `recordedAtIso` / `channel` 由本模块权威写入，故在类型上禁止 payload 覆盖它们。
export type DiagnosticEventJournalPayload = Record<string, unknown> & {
	recordedAtIso?: never;
	channel?: never;
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

// 序列化失败（循环引用、BigInt 等）不得让调用方崩溃：降级成一条自述失败原因的记录，
// 保住「这一刻确实发生过一个事件」这个事实，而不是整条丢掉。
export function serializeDiagnosticEventJournalLine(
	channel: DiagnosticEventJournalChannel,
	payload: DiagnosticEventJournalPayload,
	recordedAtIso: string,
): string {
	try {
		return `${JSON.stringify({ recordedAtIso, channel, ...payload })}\n`;
	} catch (error) {
		const serializationError = error instanceof Error ? error.message : String(error);
		return `${JSON.stringify({ recordedAtIso, channel, journalPayloadSerializationError: serializationError })}\n`;
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
	const oldestRotatedFilePath = getDiagnosticEventJournalRotatedFilePath(
		channel,
		DIAGNOSTIC_EVENT_JOURNAL_RETAINED_ROTATED_FILE_COUNT,
	);
	await rm(oldestRotatedFilePath, { force: true });
	for (
		let rotationIndex = DIAGNOSTIC_EVENT_JOURNAL_RETAINED_ROTATED_FILE_COUNT - 1;
		rotationIndex >= 1;
		rotationIndex--
	) {
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
