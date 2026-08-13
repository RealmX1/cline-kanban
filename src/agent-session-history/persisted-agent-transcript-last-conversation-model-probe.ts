// 「这段对话最后实际跑在哪个模型上」的来源：读 agent 自己落盘的转录，取最后一条 agent 产出记录的 model id。
//
// 为什么非要有它：`--continue` 恢复的是**同一段对话**，可看板在恢复时总要替它决定 `--model`——
// 要么用卡片上的 override（新建任务时由「记住上次选择」自动回填，常年停在某个模型），要么兜底注入
// `--model default`（一个随上游发版漂移的别名）。两条路都会把用户在 TUI 里 `/model` 切过去的模型
// 无声拽回来，恢复出来的会话于是与它自己的上一回合不是同一个模型。转录是唯一记得「上一回合真的用了什么」
// 的东西，故这里直接问它。
//
// 本模块只回答这一个问题、不做任何裁决：**这个工作目录的对话，最后一条 agent 产出用的是哪个 model id。**
// 读出来的是**裸 id**（转录物理上从不记录 `[1m]` 后缀），要把它翻译成能交给 CLI 的启动 id 是
// src/terminal/terminal-agent-model-selection.ts 的事；要不要采信、要不要回写卡片由 src/trpc/runtime-api.ts 决定。
//
// ── 覆盖范围 ────────────────────────────────────────────────────────────────────────
// 与同目录的「对话上次推进」探针同一条线：只有 **claude** 的转录目录名由工作目录直接编码而成，
// 一次目录列举就能定位。codex / cursor 的转录不按工作目录寻址（日期分桶 / 数字 id 项目目录），
// 要定位必须全盘扫描 + 逐个解析，那个成本不该压在会话启动路径上。扩展点是下面的
// resolveTranscriptFileClaudeContinueWouldResume，并同步放宽 supports… 谓词。

import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import {
	encodeClaudeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readTranscriptRecord,
	splitCompleteJsonLines,
} from "./bounded-agent-transcript-reader";

// 单个转录文件的**尾部**读取预算。见 readLastAgentOutputModelIdentityFromTranscriptTail：本探针只读尾部，
// 刻意不读头部，故这是一段连续的尾窗，不是「头 1/4 + 尾 3/4」那种分段预算。
export const MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE = 256 * 1024;

// Claude Code 用来表示「这条记录不是真的模型产出」的占位 model id（本地合成的提示/中断消息）。
// 采信它就会把对话钉到一个 CLI 根本无法解析的名字上。
const SYNTHETIC_TRANSCRIPT_MODEL_IDENTITY = "<synthetic>";

// Claude Code 自己的候选规则（实测 2.1.227 反编译）：文件名必须是 `<session-id>.jsonl`，
// 且后缀判定是**大小写敏感**的 `endsWith(".jsonl")`。这里照抄，理由见
// resolveTranscriptFileClaudeContinueWouldResume 的注释。
const CLAUDE_TRANSCRIPT_FILE_NAME_SUFFIX = ".jsonl";
const CLAUDE_SESSION_IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// 这个 agent 的转录能不能按工作目录直接寻址（⇒ 便宜到可以放进会话启动路径）。
// 调用方据此短路，避免为不支持的 agent 白跑一趟目录列举。
export function supportsPersistedAgentTranscriptLastConversationModelProbe(
	agentId: RuntimeAgentId | null | undefined,
): boolean {
	return agentId === "claude";
}

export interface PersistedAgentTranscriptLastConversationModelProbeInput {
	agentId: RuntimeAgentId | null | undefined;
	// 必须是**会话真正的工作目录**（任务 worktree），不是仓库根：Claude Code 的转录目录名由 cwd 编码而成，
	// 传错目录不会报错，只会静默查不到。
	workspacePath: string | null | undefined;
	// 覆盖 home 目录，供测试用真实文件系统夹具驱动（不 mock fs）。
	homeDirectoryPath?: string;
}

// 返回 null 的含义一律是「这次问不出结论」（agent 不支持 / 没有转录 / 读失败 / 尾窗里没有带 model 的 agent 产出），
// **绝不是**「这段对话没有模型」。调用方必须把 null 当作「按原有规则决定 model」，不得据此清空卡片上的选择。
export async function probePersistedAgentTranscriptLastConversationModelIdentity(
	input: PersistedAgentTranscriptLastConversationModelProbeInput,
): Promise<string | null> {
	const workspacePath = input.workspacePath?.trim();
	if (!workspacePath || !supportsPersistedAgentTranscriptLastConversationModelProbe(input.agentId)) {
		return null;
	}
	const transcriptFile = await resolveTranscriptFileClaudeContinueWouldResume(workspacePath, input.homeDirectoryPath);
	if (!transcriptFile) {
		return null;
	}
	return await readLastAgentOutputModelIdentityFromTranscriptTail(transcriptFile);
}

interface TranscriptFileCandidate {
	filePath: string;
	sessionIdentity: string;
	// **整毫秒**。Claude Code 用 `stat.mtime.getTime()` 排序，精度就是整毫秒；这里若保留 mtimeMs 的亚毫秒
	// 小数，两个落在同一毫秒的候选就会按小数分出胜负，而 CLI 那边是并列、转而用 sessionId 决胜——
	// 于是同一目录下两边挑出不同的文件。实测本机 305 个 project 目录里有 3 组同毫秒并列。
	wholeMillisecondMtime: number;
	size: number;
}

// 复刻 `claude --continue` 会恢复**哪一个**转录文件，而不是「哪个文件内容最新」。
//
// 这与同目录「对话上次推进」探针的判据刻意相反：那边求的是内容上最新的一条 agent 产出，必须跨文件比对
// （mtime 会被「重开旧会话只重放不推进」骗到）；这边求的是「待会儿 `--continue` 会恢复哪段对话、它会用
// 什么模型重建」，那是 CLI 自己挑的那一个，故**复刻它的挑法**才对，哪怕那个文件的内容并非全目录最新。
// 同理，选中的文件里若读不出模型，正确答案是 null 而不是去翻别的文件：那种会话 `--continue` 本来也无从
// 重建模型，会落到 CLI 自身默认，看板这边保持原有规则即可。
//
// 以下四条与 Claude Code 2.1.227 的实现对齐（反编译核对）：
//   1. cwd 先 realpath（CLI：`try{realpath(cwd)}catch{cwd}`），再编码成目录名。macOS 的 `/tmp`→`/private/tmp`
//      这类符号链接不处理就会算出一个根本不存在的目录名。
//   2. 后缀判定大小写敏感（CLI：`name.endsWith(".jsonl")`）。
//   3. 文件名去掉后缀必须是合法 session id（CLI 会校验后才收作候选）。
//   4. 排序：整毫秒 mtime 降序，并列时 sessionId **降序**（CLI 的比较器就是这两级）。
//
// 已知未复刻的一条：CLI 对超长 project key 会截断加哈希（`enc.length>FZ ? enc.slice(0,FZ)+"-"+hash(path)`），
// FZ 与哈希函数都不可从外部得知（实测本机 305 个目录最长 155 字符、无一带哈希后缀）。命中该分支时本探针
// 会查不到目录并返回 null ⇒ 退回原有的模型决策规则，属安全降级而非错误结论。
async function resolveTranscriptFileClaudeContinueWouldResume(
	workspacePath: string,
	homeDirectoryPath: string | undefined,
): Promise<TranscriptFileCandidate | null> {
	// 注意用的是 encodeClaudeProjectDirectoryName（**保留**前导短横），不是那个会把前导短横去掉的
	// encodedAgentProjectPath——用错编码会静默查不到、不报错也没结果。
	const projectDirectoryPath = join(
		homeDirectoryPath ?? homedir(),
		".claude",
		"projects",
		encodeClaudeProjectDirectoryName(await resolveRealWorkspacePathForProjectDirectoryEncoding(workspacePath)),
	);
	let entries: string[];
	try {
		entries = await readdir(projectDirectoryPath);
	} catch {
		// 目录不存在 = 这个工作目录还没跑过 claude 会话。属正常情形，不是错误。
		return null;
	}
	const candidates = await Promise.all(
		entries.map(async (entryName): Promise<TranscriptFileCandidate | null> => {
			const sessionIdentity = readClaudeSessionIdentityFromTranscriptFileName(entryName);
			if (!sessionIdentity) {
				return null;
			}
			const filePath = join(projectDirectoryPath, entryName);
			try {
				const fileStats = await stat(filePath);
				// subagent（侧链）转录落在 `<session-id>/subagents/` 子目录里，isFile() 这一关就把它们挡在外面。
				return fileStats.isFile()
					? {
							filePath,
							sessionIdentity,
							wholeMillisecondMtime: Math.trunc(fileStats.mtimeMs),
							size: fileStats.size,
						}
					: null;
			} catch {
				return null;
			}
		}),
	);
	let resumeCandidate: TranscriptFileCandidate | null = null;
	for (const candidate of candidates) {
		if (candidate && (resumeCandidate === null || comparesAheadOfResumeCandidate(candidate, resumeCandidate))) {
			resumeCandidate = candidate;
		}
	}
	return resumeCandidate;
}

// CLI 的比较器：整毫秒 mtime 降序，并列时 sessionId 降序。这里取「排在最前的那一个」。
function comparesAheadOfResumeCandidate(
	candidate: TranscriptFileCandidate,
	incumbent: TranscriptFileCandidate,
): boolean {
	if (candidate.wholeMillisecondMtime !== incumbent.wholeMillisecondMtime) {
		return candidate.wholeMillisecondMtime > incumbent.wholeMillisecondMtime;
	}
	return candidate.sessionIdentity > incumbent.sessionIdentity;
}

function readClaudeSessionIdentityFromTranscriptFileName(entryName: string): string | null {
	if (!entryName.endsWith(CLAUDE_TRANSCRIPT_FILE_NAME_SUFFIX)) {
		return null;
	}
	const sessionIdentity = entryName.slice(0, -CLAUDE_TRANSCRIPT_FILE_NAME_SUFFIX.length);
	return CLAUDE_SESSION_IDENTITY_PATTERN.test(sessionIdentity) ? sessionIdentity : null;
}

async function resolveRealWorkspacePathForProjectDirectoryEncoding(workspacePath: string): Promise<string> {
	try {
		return await realpath(workspacePath);
	} catch {
		// 目录不存在或不可读时退回原路径，与 CLI 的 `try{realpath}catch{原值}` 同语义。
		return workspacePath;
	}
}

// 只读**尾部**一段连续字节，读不出结论就返回 null——刻意不像同目录的进度探针那样在超预算时兼读头段。
//
// 头段兜底在这里是**错的**：尾窗若整段都是超大 attachment / tool_result 记录、一条 assistant 都没有，
// 头段命中的是**对话开头**的模型。那个陈旧模型会经 `--model` 真的启动，还会被写回卡片永久固化——
// 正好复现本模块要修的那类「恢复后跑错模型」，且比原 bug 更难察觉。实测本机 475 个超预算转录中有 1 个
// （69MB）确实命中该形状：全文件真值是 claude-opus-4-8，而头段给出的是更早的 claude-opus-4-7。
// 返回 null 只是让调用方回落原有规则，是安全的一侧。
async function readLastAgentOutputModelIdentityFromTranscriptTail(
	candidate: TranscriptFileCandidate,
): Promise<string | null> {
	const tailByteCount = Math.min(candidate.size, MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE);
	if (tailByteCount <= 0) {
		return null;
	}
	const tailStartOffset = candidate.size - tailByteCount;
	let lines: string[];
	try {
		const fileHandle = await open(candidate.filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(tailByteCount);
			const { bytesRead } = await fileHandle.read(buffer, 0, tailByteCount, tailStartOffset);
			const readBuffer = buffer.subarray(0, bytesRead);
			lines =
				tailStartOffset === 0
					? // 整个文件都读到了，没有半行可丢——用 "file_end" 反而会把真正的首行吃掉。
						readBuffer
							.toString("utf8")
							.split(/\r?\n/u)
							.filter(Boolean)
					: splitCompleteJsonLines(readBuffer, "file_end");
		} finally {
			await fileHandle.close();
		}
	} catch {
		return null;
	}
	let lastAgentOutputModelIdentity: string | null = null;
	for (const line of lines) {
		const modelIdentity = readAgentOutputModelIdentity(line);
		if (modelIdentity) {
			lastAgentOutputModelIdentity = modelIdentity;
		}
	}
	return lastAgentOutputModelIdentity;
}

function readAgentOutputModelIdentity(line: string): string | null {
	const record = parseTranscriptJsonRecord(line);
	if (!record || record.type !== "assistant") {
		return null;
	}
	// subagent（Task 工具起的侧链）完全可以跑在与主对话不同的模型上。当前版本的 Claude Code 把侧链写进
	// `<session-id>/subagents/` 子目录（已被上面的候选规则挡住），但历史版本把它们内联在主转录里，
	// 且这些记录同样带 isSidechain。不滤掉就会把 subagent 的模型钉到主对话头上——恰恰是本轮要修的那类问题。
	if (record.isSidechain === true) {
		return null;
	}
	const message = readTranscriptRecord(record.message);
	const modelIdentity = typeof message?.model === "string" ? message.model.trim() : "";
	if (!modelIdentity || modelIdentity === SYNTHETIC_TRANSCRIPT_MODEL_IDENTITY) {
		return null;
	}
	return modelIdentity;
}
