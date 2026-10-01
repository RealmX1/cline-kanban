// 从 harness 原生会话记录里读出「截至此刻的累计模型 token 用量」（按 task 归因的资源占用采集，S5）。
//
//   - Claude Code：transcript 的每条 assistant 记录带 message.usage。同一个 message 的多个内容块会各写
//     一行、重复携带同一份 usage，所以按 message.id 去重（后写覆盖先写）。subagent 的记录在
//     `<transcript 去掉 .jsonl>/subagents/agent-*.jsonl`，一并计入；主 transcript 里没有 sidechain 行，不会重复。
//   - Codex：rollout 里的 event_msg.token_count 本身就是会话累计值，取最后一个即可（另带 rate_limits）。
//
// 读取用依赖包里的 readAppendedCompleteJsonLines 按偏移量增量读，每次读到追平为止：有界读取器
// （readBoundedJsonLines）超预算时会丢掉中间段，拿它做累计会少算。文件被截断 / 重写时清空状态从头读。
// transcript 格式不是公开契约：读不懂的行跳过，宁可少算，不可报错。
//
// 单行长过单次读取预算（窗口里一个换行都没有）时，依赖包不推进 offset、却仍报「预算外还有字节」，
// 照原样循环会原地重读、永不返回（监视器的单飞标志随之永久卡住）。这里的取舍是**整行跳过并前进**：
//   - 不放大窗口：预算本来就是为了挡住一次性分配超大 Buffer，为一行放大等于让它失效；
//   - 不「本轮放弃、下轮再试」：同一行下轮仍然超长，该文件此后的用量会永久停在这一行之前；
//   - 跳过的通常是巨型工具结果 / 用户内容这类不带 usage 的行；Claude Code 的同一 message 的每个内容块
//     各写一行、重复携带同一份 usage，只有「唯一内容块超长」才会真的丢掉那条 message 的用量。
// 跳过不是悄悄的：跳过行数随累计快照写进 journal（transcriptLinesSkippedForExceedingIncrementalReadBudgetCount），
// 读报告时能看出这份累计值是下界。

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	DEFAULT_MAX_INCREMENTAL_READ_BYTES,
	parseTranscriptJsonRecord,
	readAppendedCompleteJsonLines,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";

// 寻找超长行结尾换行时的单次读取块大小：跳过超长行只占常量内存。
const OVERSIZED_TRANSCRIPT_LINE_NEWLINE_SCAN_CHUNK_BYTES = 1024 * 1024;

export interface AgentConversationModelTokenUsageTotals {
	cumulativeInputTokens: number;
	cumulativeCacheCreationInputTokens: number;
	cumulativeCacheReadInputTokens: number;
	cumulativeOutputTokens: number;
	cumulativeReasoningOutputTokens: number | null;
	modelIds: string[];
	assistantMessageCount: number;
	// Codex 的额度占用（harness 自报），其余来源为 null。
	codexRateLimitPrimaryUsedPercent: number | null;
	contextWindowSizeTokens: number | null;
	// 因单行长过增量读取预算而整行跳过的行数（> 0 ⇒ 上面的累计值是下界）。
	transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: number;
}

interface ClaudeAssistantMessageUsage {
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	modelId: string | null;
}

// 「跳过行数」放在累积状态里：文件被截断重读时它与累积值一起清零，始终描述「当前这份累积缺了几行」。
interface TranscriptLinesSkippedForExceedingIncrementalReadBudgetTally {
	transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: number;
}

export interface ClaudeTranscriptTokenUsageAccumulatorState
	extends TranscriptLinesSkippedForExceedingIncrementalReadBudgetTally {
	usageByAssistantMessageId: Map<string, ClaudeAssistantMessageUsage>;
}

export function createClaudeTranscriptTokenUsageAccumulatorState(): ClaudeTranscriptTokenUsageAccumulatorState {
	return { usageByAssistantMessageId: new Map(), transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readTokenCount(record: Record<string, unknown> | null, key: string): number {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function accumulateClaudeTranscriptRecordsIntoTokenUsage(
	state: ClaudeTranscriptTokenUsageAccumulatorState,
	transcriptRecords: readonly Record<string, unknown>[],
): void {
	for (const transcriptRecord of transcriptRecords) {
		if (transcriptRecord.type !== "assistant") {
			continue;
		}
		const message = asRecord(transcriptRecord.message);
		const usage = asRecord(message?.usage);
		const messageId = typeof message?.id === "string" ? message.id : null;
		if (!message || !usage || messageId === null) {
			continue;
		}
		state.usageByAssistantMessageId.set(messageId, {
			inputTokens: readTokenCount(usage, "input_tokens"),
			cacheCreationInputTokens: readTokenCount(usage, "cache_creation_input_tokens"),
			cacheReadInputTokens: readTokenCount(usage, "cache_read_input_tokens"),
			outputTokens: readTokenCount(usage, "output_tokens"),
			modelId: typeof message.model === "string" ? message.model : null,
		});
	}
}

export function summarizeClaudeTranscriptTokenUsage(
	states: readonly ClaudeTranscriptTokenUsageAccumulatorState[],
): AgentConversationModelTokenUsageTotals {
	const totals: AgentConversationModelTokenUsageTotals = {
		cumulativeInputTokens: 0,
		cumulativeCacheCreationInputTokens: 0,
		cumulativeCacheReadInputTokens: 0,
		cumulativeOutputTokens: 0,
		cumulativeReasoningOutputTokens: null,
		modelIds: [],
		assistantMessageCount: 0,
		codexRateLimitPrimaryUsedPercent: null,
		contextWindowSizeTokens: null,
		transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0,
	};
	const modelIds = new Set<string>();
	for (const state of states) {
		totals.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount +=
			state.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount;
		for (const usage of state.usageByAssistantMessageId.values()) {
			totals.cumulativeInputTokens += usage.inputTokens;
			totals.cumulativeCacheCreationInputTokens += usage.cacheCreationInputTokens;
			totals.cumulativeCacheReadInputTokens += usage.cacheReadInputTokens;
			totals.cumulativeOutputTokens += usage.outputTokens;
			totals.assistantMessageCount += 1;
			if (usage.modelId !== null) {
				modelIds.add(usage.modelId);
			}
		}
	}
	totals.modelIds = Array.from(modelIds).sort();
	return totals;
}

export interface CodexRolloutTokenUsageAccumulatorState
	extends TranscriptLinesSkippedForExceedingIncrementalReadBudgetTally {
	latestTotals: AgentConversationModelTokenUsageTotals | null;
	modelIds: Set<string>;
}

export function createCodexRolloutTokenUsageAccumulatorState(): CodexRolloutTokenUsageAccumulatorState {
	return { latestTotals: null, modelIds: new Set(), transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0 };
}

export function accumulateCodexRolloutRecordsIntoTokenUsage(
	state: CodexRolloutTokenUsageAccumulatorState,
	rolloutRecords: readonly Record<string, unknown>[],
): void {
	for (const rolloutRecord of rolloutRecords) {
		const payload = asRecord(rolloutRecord.payload);
		if (rolloutRecord.type === "turn_context" && typeof payload?.model === "string") {
			state.modelIds.add(payload.model);
			continue;
		}
		if (rolloutRecord.type !== "event_msg" || payload?.type !== "token_count") {
			continue;
		}
		const info = asRecord(payload.info);
		const totalTokenUsage = asRecord(info?.total_token_usage);
		if (!totalTokenUsage) {
			continue;
		}
		const primaryRateLimit = asRecord(asRecord(payload.rate_limits)?.primary);
		const primaryUsedPercent = primaryRateLimit?.used_percent;
		const contextWindowSize = info?.model_context_window;
		// Codex 的 input_tokens 含已缓存部分；拆成「未缓存输入 + 缓存读」，与 Claude 的口径对齐。
		const inputTokensIncludingCached = readTokenCount(totalTokenUsage, "input_tokens");
		const cachedInputTokens = readTokenCount(totalTokenUsage, "cached_input_tokens");
		state.latestTotals = {
			cumulativeInputTokens: Math.max(0, inputTokensIncludingCached - cachedInputTokens),
			cumulativeCacheCreationInputTokens: readTokenCount(totalTokenUsage, "cache_write_input_tokens"),
			cumulativeCacheReadInputTokens: cachedInputTokens,
			cumulativeOutputTokens: readTokenCount(totalTokenUsage, "output_tokens"),
			cumulativeReasoningOutputTokens: readTokenCount(totalTokenUsage, "reasoning_output_tokens"),
			modelIds: [],
			assistantMessageCount: 0,
			codexRateLimitPrimaryUsedPercent: typeof primaryUsedPercent === "number" ? primaryUsedPercent : null,
			contextWindowSizeTokens: typeof contextWindowSize === "number" ? contextWindowSize : null,
			transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0,
		};
	}
}

export function summarizeCodexRolloutTokenUsage(
	state: CodexRolloutTokenUsageAccumulatorState,
): AgentConversationModelTokenUsageTotals | null {
	return state.latestTotals === null
		? null
		: {
				...state.latestTotals,
				modelIds: Array.from(state.modelIds).sort(),
				transcriptLinesSkippedForExceedingIncrementalReadBudgetCount:
					state.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount,
			};
}

interface IncrementallyReadTranscriptFileState<TAccumulatorState> {
	nextByteOffset: number;
	accumulatorState: TAccumulatorState;
}

// 从 scanStartByteOffset 起找第一个换行，返回它之后的偏移；读到（扫描开始时的）文件尾仍没有换行就返回 null。
async function findByteOffsetAfterNextNewline(filePath: string, scanStartByteOffset: number): Promise<number | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const fileSizeBytesWhenScanStarted = (await fileHandle.stat()).size;
		const scanChunkBuffer = Buffer.allocUnsafe(OVERSIZED_TRANSCRIPT_LINE_NEWLINE_SCAN_CHUNK_BYTES);
		let scanByteOffset = scanStartByteOffset;
		while (scanByteOffset < fileSizeBytesWhenScanStarted) {
			const { bytesRead } = await fileHandle.read(
				scanChunkBuffer,
				0,
				Math.min(OVERSIZED_TRANSCRIPT_LINE_NEWLINE_SCAN_CHUNK_BYTES, fileSizeBytesWhenScanStarted - scanByteOffset),
				scanByteOffset,
			);
			if (bytesRead === 0) {
				return null;
			}
			const newlineIndex = scanChunkBuffer.subarray(0, bytesRead).indexOf(0x0a);
			if (newlineIndex >= 0) {
				return scanByteOffset + newlineIndex + 1;
			}
			scanByteOffset += bytesRead;
		}
		return null;
	} finally {
		await fileHandle.close();
	}
}

// 读到追平为止；文件被截断 / 重写就清空累积从头读。每一轮要么 offset 前进、要么返回，绝不原地重读。
async function readTranscriptFileIncrementally<
	TAccumulatorState extends TranscriptLinesSkippedForExceedingIncrementalReadBudgetTally,
>(
	filePath: string,
	fileState: IncrementallyReadTranscriptFileState<TAccumulatorState>,
	createAccumulatorState: () => TAccumulatorState,
	accumulate: (state: TAccumulatorState, records: Record<string, unknown>[]) => void,
	maxIncrementalReadBytes: number,
): Promise<void> {
	for (;;) {
		const chunkStartByteOffset = fileState.nextByteOffset;
		const readResult = await readAppendedCompleteJsonLines(filePath, chunkStartByteOffset, maxIncrementalReadBytes);
		if (readResult.fileWasTruncated) {
			fileState.nextByteOffset = 0;
			fileState.accumulatorState = createAccumulatorState();
			continue;
		}
		const records = readResult.completeLines
			.map((line) => parseTranscriptJsonRecord(line))
			.filter((record): record is Record<string, unknown> => record !== null);
		accumulate(fileState.accumulatorState, records);
		fileState.nextByteOffset = readResult.nextByteOffset;
		if (!readResult.appendedBytesRemainBeyondIncrementalReadBudget) {
			return;
		}
		if (readResult.nextByteOffset > chunkStartByteOffset) {
			continue;
		}
		// 读了一整个预算窗口却没推进：从 chunkStartByteOffset 起的这一行长过预算（窗口内已确认没有换行，
		// 所以从窗口之后接着找）。取舍见文件头注释。
		const byteOffsetAfterOversizedLine = await findByteOffsetAfterNextNewline(
			filePath,
			chunkStartByteOffset + maxIncrementalReadBytes,
		);
		if (byteOffsetAfterOversizedLine === null) {
			// 这一行还没写完：本轮停在它的行首，等它写完（文件签名随之变化）下一轮再跳。
			return;
		}
		fileState.nextByteOffset = byteOffsetAfterOversizedLine;
		fileState.accumulatorState.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount += 1;
	}
}

export function resolveClaudeSubagentTranscriptDirectoryPath(transcriptPath: string): string {
	return join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
}

// 每个 transcript 文件各自保留读取偏移与累积状态：长寿会话每次只读新增的字节。
// maxIncrementalReadBytes 只为测试可调（默认沿用依赖包的单次读取预算）。
export function createAgentConversationModelTokenUsageIncrementalReader(
	options: { maxIncrementalReadBytes?: number } = {},
) {
	const maxIncrementalReadBytes = options.maxIncrementalReadBytes ?? DEFAULT_MAX_INCREMENTAL_READ_BYTES;
	const claudeFileStates = new Map<
		string,
		IncrementallyReadTranscriptFileState<ClaudeTranscriptTokenUsageAccumulatorState>
	>();
	const codexFileStates = new Map<
		string,
		IncrementallyReadTranscriptFileState<CodexRolloutTokenUsageAccumulatorState>
	>();

	const readClaudeFile = async (filePath: string): Promise<ClaudeTranscriptTokenUsageAccumulatorState> => {
		let fileState = claudeFileStates.get(filePath);
		if (!fileState) {
			fileState = { nextByteOffset: 0, accumulatorState: createClaudeTranscriptTokenUsageAccumulatorState() };
			claudeFileStates.set(filePath, fileState);
		}
		await readTranscriptFileIncrementally(
			filePath,
			fileState,
			createClaudeTranscriptTokenUsageAccumulatorState,
			accumulateClaudeTranscriptRecordsIntoTokenUsage,
			maxIncrementalReadBytes,
		);
		return fileState.accumulatorState;
	};

	return {
		readClaudeCodeCumulativeTokenUsage: async (
			transcriptPath: string,
		): Promise<{ totals: AgentConversationModelTokenUsageTotals; subagentTranscriptCount: number }> => {
			const states = [await readClaudeFile(transcriptPath)];
			const subagentDirectoryPath = resolveClaudeSubagentTranscriptDirectoryPath(transcriptPath);
			let subagentTranscriptFileNames: string[] = [];
			try {
				subagentTranscriptFileNames = (await readdir(subagentDirectoryPath)).filter(
					(fileName) => fileName.startsWith("agent-") && fileName.endsWith(".jsonl"),
				);
			} catch {
				// 没有 subagent 目录。
			}
			for (const fileName of subagentTranscriptFileNames) {
				states.push(await readClaudeFile(join(subagentDirectoryPath, fileName)));
			}
			return {
				totals: summarizeClaudeTranscriptTokenUsage(states),
				subagentTranscriptCount: subagentTranscriptFileNames.length,
			};
		},
		readCodexCumulativeTokenUsage: async (
			rolloutPath: string,
		): Promise<AgentConversationModelTokenUsageTotals | null> => {
			let fileState = codexFileStates.get(rolloutPath);
			if (!fileState) {
				fileState = { nextByteOffset: 0, accumulatorState: createCodexRolloutTokenUsageAccumulatorState() };
				codexFileStates.set(rolloutPath, fileState);
			}
			await readTranscriptFileIncrementally(
				rolloutPath,
				fileState,
				createCodexRolloutTokenUsageAccumulatorState,
				accumulateCodexRolloutRecordsIntoTokenUsage,
				maxIncrementalReadBytes,
			);
			return summarizeCodexRolloutTokenUsage(fileState.accumulatorState);
		},
		// 供调用方决定要不要重读（大小 / 修改时间没变就跳过）。
		readTranscriptFileSignature: async (filePath: string): Promise<string | null> => {
			try {
				const fileStats = await stat(filePath);
				return `${fileStats.size}:${fileStats.mtimeMs}`;
			} catch {
				return null;
			}
		},
	};
}

export type AgentConversationModelTokenUsageIncrementalReader = ReturnType<
	typeof createAgentConversationModelTokenUsageIncrementalReader
>;
