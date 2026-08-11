// 「对话上次推进」的**权威**来源：直接读 agent 自己落盘的转录，取最后一条 agent 产出记录的时刻。
//
// 为什么非要有它：其余三档证据都活在运行时进程里，跨不过「会话重开」这道坎。
// 实测（168 个可对账的 claude 任务）：卡片时间比转录真相**新**的占 26%，偏差中位数 26.8 小时、p95 12.4 天；
// 其中虚假推进的案例 **100%** 都是「转录被重开过」——旧对话被重播进一个全新 TUI，而实质分类器的行签名
// 记忆是空的，整段旧内容被判成新产出。转录是唯一不受重播影响的东西：它记的是对话本身，不是渲染。
//
// 本模块只回答一个问题、不做任何裁决：**这个工作目录的对话，最后一条 agent 产出发生在什么时刻。**
// 要不要采信、能不能把已存值往回拉，全部由 src/core/last-conversation-progress-observation.ts 的唯一
// 合并 reducer 决定（转录只被授权纠正低置信的 TUI 猜测，绝不回拉 hook / 结构化事件的推进）。
//
// ── 覆盖范围（有意的、按可寻址成本划的线）──────────────────────────────────────────────
// **claude**：转录目录名由工作目录直接编码而成 ⇒ 一次目录列举 + 有界尾读就能定位，成本与任务数成正比，
//   可以放进周期性探测。这也正好覆盖上面那 168 个实测样本的全部。
// **codex / cursor**：转录**不按工作目录寻址**——codex 按日期分桶（cwd 藏在 session_meta 里）、cursor 的
//   项目目录是数字 id。要找到「属于这个工作目录的转录」必须全盘扫描 + 逐个解析，正是
//   available-agent-session-index.ts 干的事（3s 截止 + 64MB 预算 + LRU）。那个成本可以为一次用户点击付，
//   不能为每个任务的周期性探测付。故本片**不覆盖**这两家，它们继续落到 hook 事件（codex 有）或低置信
//   TUI 兜底（并在卡片上以 `~` 标注）。要补的话扩展点就是下面的 resolveTranscriptFilesForWorkspace。
// **gemini / opencode / droid / kimi**：本就没有通用落盘转录，不在本模块的讨论范围。

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import type { RuntimeAgentId, RuntimeLastConversationProgressObservation } from "../core/api-contract";
import {
	encodeClaudeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
} from "./bounded-agent-transcript-reader";

// 单个转录文件的读取预算。只取「最后一条 agent 产出」，尾部就够，故比索引侧的 1MB 更小。
// 与下面的冷读总预算一并 export：成本上限那条用例要按它们算出「几个文件才撑爆预算」，写死数字会在
// 有人调预算后静默失去覆盖。
export const MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE = 256 * 1024;
// 一次探测最多为**未命中缓存**的文件读多少字节。命中缓存的文件不计入，故稳态下这份预算根本不会动用。
// 它取代了旧的「按 mtime 排序后只看前 4 个」——那条截断把 mtime 当成了内容新旧的判据，正是本模块
// 通篇否定的做法（见下面 readLastAgentOutputTimestamp 的注释）。这里改为纯粹的**成本上限**：
// 它决定「这一趟最多做多少冷读」，不决定「哪个文件的内容更新」。预算耗尽时按下面的规则返回 null，
// 且已读过的文件已进缓存，下一趟能免费越过它们继续往前推进——截断变成分摊，而不是永久看不到。
export const MAX_UNCACHED_TRANSCRIPT_READ_BYTES_PER_PROBE = 4 * 1024 * 1024;
// mtime 作为「内容时刻上界」时给时钟偏斜留的余量（见 scanTranscriptFilesForLastAgentOutput）。
// 实测 594 个真实转录文件，mtime 与其最新 assistant 时刻的反向差最大仅 47ms；取 1 分钟纯为吸收
// NTP 跳变与跨机器同步，宁可多读几个文件，也不能因为几十毫秒的偏斜把真相文件剪掉。
const TRANSCRIPT_MTIME_UPPER_BOUND_CLOCK_SKEW_TOLERANCE_MS = 60_000;
const PROBE_RESULT_CACHE_MAXIMUM_ENTRIES = 1_000;

interface CachedProbeResult {
	// mtime + size：文件没动过就直接复用上次的解析结果，周期性探测因此几乎不产生 IO。
	signature: string;
	lastAgentOutputAtMs: number | null;
}

const probeResultCacheByFilePath = new Map<string, CachedProbeResult>();

export function resetPersistedAgentTranscriptProbeStateForTests(): void {
	probeResultCacheByFilePath.clear();
}

export function getPersistedAgentTranscriptProbeCacheSizeForTests(): number {
	return probeResultCacheByFilePath.size;
}

// 这个 agent 的转录能不能按工作目录直接寻址（⇒ 便宜到可以周期性探测）。
// 调用方据此决定要不要发起探测，避免为不支持的 agent 白跑一趟。
export function supportsPersistedAgentTranscriptConversationProgressProbe(
	agentId: RuntimeAgentId | null | undefined,
): boolean {
	return agentId === "claude";
}

export interface PersistedAgentTranscriptProbeInput {
	agentId: RuntimeAgentId | null | undefined;
	workspacePath: string | null | undefined;
	// 覆盖 home 目录，供测试用真实文件系统夹具驱动（不 mock fs）。
	homeDirectoryPath?: string;
}

// 返回 null 的含义一律是「这次问不出结论」（agent 不支持 / 没有转录目录 / 读失败 / 尾部没有 agent 产出），
// **绝不是**「对话没推进过」。调用方必须把 null 当作「保持原值」，不得据此清空或回退已有观测。
export async function probePersistedAgentTranscriptLastConversationProgress(
	input: PersistedAgentTranscriptProbeInput,
): Promise<RuntimeLastConversationProgressObservation | null> {
	const workspacePath = input.workspacePath?.trim();
	if (!workspacePath || !supportsPersistedAgentTranscriptConversationProgressProbe(input.agentId)) {
		return null;
	}
	const transcriptFiles = await resolveTranscriptFilesForWorkspace(workspacePath, input.homeDirectoryPath);
	if (transcriptFiles.length === 0) {
		return null;
	}
	return await scanTranscriptFilesForLastAgentOutput(transcriptFiles);
}

// 跨文件求「最后一条 agent 产出」的最大时刻。
//
// 这里是本模块唯一被允许**看 mtime 的地方**，而且只用它成立的那一半语义：
//   ✅ mtime 是内容时刻的**上界**——一条 assistant 记录写进文件必然把 mtime 推到它自身时刻或更后。
//      故「候选的 mtime 已经比手上最大值还旧」⇒ 它不可能藏着更新的记录 ⇒ 剪掉它是**可证明安全**的。
//   ❌ mtime **不是**内容时刻的下界——会话重开只重放不推进，却会把 mtime 刷到当下（实测样本里
//      mtime 比内容新出 44 天）。故「mtime 新」绝不能推出「内容新」，据此排序取前 N 是错的：
//      只要有 N 个旧会话刚被重开过，真正含最新记录的那个文件就会被挤出候选集，探针于是给出一个偏旧
//      却带最高置信度的值，还可能据此把一个其实更准确的低置信观测错误地回拉。
//
// 于是 mtime 在这里降级为**读取顺序提示**：按它由新到旧扫，靠上面那条上界不等式尽早收敛。
// 稳态下第一个文件就把其余全部剪掉（实测各目录都只读 1 个，比旧的固定读 4 个还省）。
async function scanTranscriptFilesForLastAgentOutput(
	candidatesOrderedByDescendingMtime: TranscriptFileCandidate[],
): Promise<RuntimeLastConversationProgressObservation | null> {
	let observedAtMs: number | null = null;
	let remainingUncachedReadByteBudget = MAX_UNCACHED_TRANSCRIPT_READ_BYTES_PER_PROBE;
	for (const candidate of candidatesOrderedByDescendingMtime) {
		if (
			observedAtMs !== null &&
			candidate.mtimeMs + TRANSCRIPT_MTIME_UPPER_BOUND_CLOCK_SKEW_TOLERANCE_MS <= observedAtMs
		) {
			// 列表按 mtime 降序，后面只会更旧 ⇒ 整段一起剪，不是 continue。
			break;
		}
		if (!hasFreshCachedProbeResult(candidate)) {
			const uncachedReadByteCost = Math.min(candidate.size, MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE);
			if (uncachedReadByteCost > remainingUncachedReadByteBudget) {
				// 预算耗尽 ⇒ 还有候选没被证伪，手上这个最大值**没被证明是全局最大**。
				// 此时宁可返回 null（「这次问不出结论」，调用方保持原值），也不能把一个未经证明的值
				// 当成最高置信证据交出去：合并 reducer 授权 persisted_agent_transcript 无条件回拉低置信
				// 已存值，交一个偏旧的值出去就是把要修的 bug 换个罕见形状重犯。
				return null;
			}
			remainingUncachedReadByteBudget -= uncachedReadByteCost;
		}
		const candidateLastAgentOutputAtMs = await readLastAgentOutputTimestampWithCache(candidate);
		if (
			candidateLastAgentOutputAtMs !== null &&
			(observedAtMs === null || candidateLastAgentOutputAtMs > observedAtMs)
		) {
			observedAtMs = candidateLastAgentOutputAtMs;
		}
	}
	return observedAtMs === null ? null : { observedAtMs, evidenceKind: "persisted_agent_transcript" };
}

interface TranscriptFileCandidate {
	filePath: string;
	mtimeMs: number;
	size: number;
}

// 扩展点：新增一家可按工作目录寻址的 agent 时改这里（并同步放宽上面的 supports… 谓词）。
async function resolveTranscriptFilesForWorkspace(
	workspacePath: string,
	homeDirectoryPath: string | undefined,
): Promise<TranscriptFileCandidate[]> {
	// 注意用的是 encodeClaudeProjectDirectoryName（**保留**前导短横），不是索引侧那个会把前导短横去掉的
	// encodedAgentProjectPath——Claude Code 落盘的目录名形如 `-Users-me-repo`，用错编码会静默查不到、
	// 不报错也没结果。两者的区别见 bounded-agent-transcript-reader.ts 的告警注释。
	const projectDirectoryPath = join(
		homeDirectoryPath ?? homedir(),
		".claude",
		"projects",
		encodeClaudeProjectDirectoryName(workspacePath),
	);
	let entries: string[];
	try {
		entries = await readdir(projectDirectoryPath);
	} catch {
		// 目录不存在 = 这个工作目录还没跑过 claude 会话。属正常情形，不是错误。
		return [];
	}
	const candidates = await Promise.all(
		entries
			.filter((entryName) => extname(entryName).toLowerCase() === ".jsonl")
			.map(async (entryName): Promise<TranscriptFileCandidate | null> => {
				const filePath = join(projectDirectoryPath, entryName);
				try {
					const fileStats = await stat(filePath);
					return fileStats.isFile() ? { filePath, mtimeMs: fileStats.mtimeMs, size: fileStats.size } : null;
				} catch {
					return null;
				}
			}),
	);
	// 这里**不截断**：谁的内容更新只有读了才知道，按 mtime 砍掉尾巴就是拿一个已知不可靠的信号做正确性
	// 判断。排序在这里只是给下游 scanTranscriptFilesForLastAgentOutput 一个读取顺序，成本由那边的
	// 冷读字节预算与上界剪枝一起兜住。
	return candidates
		.filter((candidate): candidate is TranscriptFileCandidate => candidate !== null)
		.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function transcriptProbeResultSignature(candidate: TranscriptFileCandidate): string {
	return `${candidate.mtimeMs}:${candidate.size}`;
}

// 只探查、不触碰 LRU 顺序：调用方要先知道「这个文件读不读得起」才能决定要不要花冷读预算。
function hasFreshCachedProbeResult(candidate: TranscriptFileCandidate): boolean {
	return probeResultCacheByFilePath.get(candidate.filePath)?.signature === transcriptProbeResultSignature(candidate);
}

async function readLastAgentOutputTimestampWithCache(candidate: TranscriptFileCandidate): Promise<number | null> {
	const signature = transcriptProbeResultSignature(candidate);
	const cached = probeResultCacheByFilePath.get(candidate.filePath);
	if (cached?.signature === signature) {
		// LRU 触碰：重新插入使其排到队尾。
		probeResultCacheByFilePath.delete(candidate.filePath);
		probeResultCacheByFilePath.set(candidate.filePath, cached);
		return cached.lastAgentOutputAtMs;
	}
	const lastAgentOutputAtMs = await readLastAgentOutputTimestamp(candidate);
	probeResultCacheByFilePath.delete(candidate.filePath);
	probeResultCacheByFilePath.set(candidate.filePath, { signature, lastAgentOutputAtMs });
	while (probeResultCacheByFilePath.size > PROBE_RESULT_CACHE_MAXIMUM_ENTRIES) {
		const leastRecentlyUsedFilePath = probeResultCacheByFilePath.keys().next().value;
		if (typeof leastRecentlyUsedFilePath !== "string") break;
		probeResultCacheByFilePath.delete(leastRecentlyUsedFilePath);
	}
	return lastAgentOutputAtMs;
}

async function readLastAgentOutputTimestamp(candidate: TranscriptFileCandidate): Promise<number | null> {
	let lines: string[];
	try {
		({ lines } = await readBoundedJsonLines(candidate.filePath, candidate.size, MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE));
	} catch {
		return null;
	}
	let latest: number | null = null;
	for (const line of lines) {
		const record = parseTranscriptJsonRecord(line);
		// 只认 assistant 记录：它就是「agent 说了话」。刻意**不**退回文件 mtime——实测的病灶样本 ce120
		// 正是 mtime 是今天、内容却停在 7 天前（尾部那条 `last-prompt` 记录不带任何时间戳），
		// 用 mtime 会把「今天重开过这个会话」错读成「今天对话推进过」，等于把要修的 bug 换个地方重犯。
		if (!record || record.type !== "assistant" || typeof record.timestamp !== "string") {
			continue;
		}
		const timestampMs = Date.parse(record.timestamp);
		if (!Number.isFinite(timestampMs)) {
			continue;
		}
		if (latest === null || timestampMs > latest) {
			latest = timestampMs;
		}
	}
	// 超预算时读的是「头 1/4 + 尾 3/4」，若尾段恰好整段都是工具结果、一条 assistant 都没有，这里会返回
	// 一个偏旧的值甚至 null。那是**保守失败**（值暂时不前进），合并 reducer 的单调性保证它不会造成回退。
	return latest;
}
