// 「续跑一个 Claude 会话时，它会接上哪一个转录文件」——以及读那个文件尾部的完整 JSONL 行。
//
// 续跑路径上有不止一个问题要问转录：最后一回合用的是什么模型（persisted-agent-transcript-last-conversation-model-probe.ts）、
// 会话死前是不是还停在 plan 里（persisted-agent-transcript-plan-mode-still-open-probe.ts）。它们问的都是**同一个**
// 文件——待会儿 CLI 真正会接上的那一个——所以定位规则只能有一份，否则两个探针各自挑出不同的文件。
//
// 只覆盖 claude：只有它的转录目录名由工作目录直接编码而成，一次目录列举就能定位，便宜到可以放进会话启动路径。

import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { encodeClaudeProjectDirectoryName, splitCompleteJsonLines } from "./bounded-agent-transcript-reader";

// Claude Code 自己的候选规则（实测 2.1.227 反编译）：文件名必须是 `<session-id>.jsonl`，
// 且后缀判定是**大小写敏感**的 `endsWith(".jsonl")`。这里照抄，理由见
// resolveClaudeTranscriptFileThatContinueWouldResume 的注释。
const CLAUDE_TRANSCRIPT_FILE_NAME_SUFFIX = ".jsonl";
const CLAUDE_SESSION_IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ClaudeTranscriptFileCandidateForResume {
	filePath: string;
	sessionIdentity: string;
	// **整毫秒**。Claude Code 用 `stat.mtime.getTime()` 排序，精度就是整毫秒；这里若保留 mtimeMs 的亚毫秒
	// 小数，两个落在同一毫秒的候选就会按小数分出胜负，而 CLI 那边是并列、转而用 sessionId 决胜——
	// 于是同一目录下两边挑出不同的文件。实测本机 305 个 project 目录里有 3 组同毫秒并列。
	wholeMillisecondMtime: number;
	size: number;
}

async function resolveClaudeProjectDirectoryPathForWorkspace(
	workspacePath: string,
	homeDirectoryPath: string | undefined,
): Promise<string> {
	// 注意用的是 encodeClaudeProjectDirectoryName（**保留**前导短横），不是那个会把前导短横去掉的
	// encodedAgentProjectPath——用错编码会静默查不到、不报错也没结果。
	return join(
		homeDirectoryPath ?? homedir(),
		".claude",
		"projects",
		encodeClaudeProjectDirectoryName(await resolveRealWorkspacePathForProjectDirectoryEncoding(workspacePath)),
	);
}

// 复刻 `claude --continue` 会恢复**哪一个**转录文件，而不是「哪个文件内容最新」。
//
// 这与同目录「对话上次推进」探针的判据刻意相反：那边求的是内容上最新的一条 agent 产出，必须跨文件比对
// （mtime 会被「重开旧会话只重放不推进」骗到）；这边求的是「待会儿 `--continue` 会恢复哪段对话」，
// 那是 CLI 自己挑的那一个，故**复刻它的挑法**才对，哪怕那个文件的内容并非全目录最新。
//
// 以下四条与 Claude Code 2.1.227 的实现对齐（反编译核对）：
//   1. cwd 先 realpath（CLI：`try{realpath(cwd)}catch{cwd}`），再编码成目录名。macOS 的 `/tmp`→`/private/tmp`
//      这类符号链接不处理就会算出一个根本不存在的目录名。
//   2. 后缀判定大小写敏感（CLI：`name.endsWith(".jsonl")`）。
//   3. 文件名去掉后缀必须是合法 session id（CLI 会校验后才收作候选）。
//   4. 排序：整毫秒 mtime 降序，并列时 sessionId **降序**（CLI 的比较器就是这两级）。
//
// 已知未复刻的一条：CLI 对超长 project key 会截断加哈希（`enc.length>FZ ? enc.slice(0,FZ)+"-"+hash(path)`），
// FZ 与哈希函数都不可从外部得知（实测本机 305 个目录最长 155 字符、无一带哈希后缀）。命中该分支时会查不到
// 目录并返回 null ⇒ 调用方退回各自的原有规则，属安全降级而非错误结论。
export async function resolveClaudeTranscriptFileThatContinueWouldResume(
	workspacePath: string,
	homeDirectoryPath: string | undefined,
): Promise<ClaudeTranscriptFileCandidateForResume | null> {
	const projectDirectoryPath = await resolveClaudeProjectDirectoryPathForWorkspace(workspacePath, homeDirectoryPath);
	let entries: string[];
	try {
		entries = await readdir(projectDirectoryPath);
	} catch {
		// 目录不存在 = 这个工作目录还没跑过 claude 会话。属正常情形，不是错误。
		return null;
	}
	const candidates = await Promise.all(
		entries.map(async (entryName): Promise<ClaudeTranscriptFileCandidateForResume | null> => {
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
	let resumeCandidate: ClaudeTranscriptFileCandidateForResume | null = null;
	for (const candidate of candidates) {
		if (candidate && (resumeCandidate === null || comparesAheadOfResumeCandidate(candidate, resumeCandidate))) {
			resumeCandidate = candidate;
		}
	}
	return resumeCandidate;
}

// 按**会话自己的原生 session id** 定位转录（`--resume <id>` 续的就是它），而不是复刻 `--continue` 的挑法：
// 主会话与它的 By the way 侧问、以及同仓库下多个 inplace 任务共用同一个 cwd，那时 cwd-latest 会挑到别人的对话。
//
// 刻意**不**给 resolveClaudeTranscriptFileThatContinueWouldResume 加一个可选参数：那个函数的全部价值在于
// 忠实复刻 CLI 的挑法，掺进 by-id 分支会毁掉它的单一答案性。
export async function resolveClaudeTranscriptFileForAgentNativeConversationSession(input: {
	// 会话真正的工作目录（任务 worktree）——转录目录名仍由它编码而成，只是目录里挑哪个文件改由 id 决定。
	workspacePath: string;
	// harness 自己的 session id（summary sidecar agentNativeConversationSessionIdentity.nativeSessionId）。
	agentNativeConversationSessionId: string;
	homeDirectoryPath?: string;
}): Promise<ClaudeTranscriptFileCandidateForResume | null> {
	const sessionIdentity = input.agentNativeConversationSessionId.trim();
	if (!CLAUDE_SESSION_IDENTITY_PATTERN.test(sessionIdentity)) {
		return null;
	}
	const filePath = join(
		await resolveClaudeProjectDirectoryPathForWorkspace(input.workspacePath, input.homeDirectoryPath),
		`${sessionIdentity}${CLAUDE_TRANSCRIPT_FILE_NAME_SUFFIX}`,
	);
	try {
		const fileStats = await stat(filePath);
		if (!fileStats.isFile()) {
			return null;
		}
		// 排序字段在按-id 定位里用不到；给出真实值以外的任何东西都只会误导读者，故直接取 0 并说明。
		return { filePath, sessionIdentity, wholeMillisecondMtime: 0, size: fileStats.size };
	} catch {
		// 这条会话在这个工作目录下还没有转录（刚建、或 harness 把它落在别处）。属正常情形。
		return null;
	}
}

// 只读**尾部**一段连续字节，切出其中的完整 JSONL 行（尾窗起点落在半行上时丢掉那半行）。读失败返回 null。
export async function readCompleteJsonLinesFromClaudeTranscriptTail(
	candidate: ClaudeTranscriptFileCandidateForResume,
	maximumTailByteCount: number,
): Promise<string[] | null> {
	const tailByteCount = Math.min(candidate.size, maximumTailByteCount);
	if (tailByteCount <= 0) {
		return null;
	}
	const tailStartOffset = candidate.size - tailByteCount;
	try {
		const fileHandle = await open(candidate.filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(tailByteCount);
			const { bytesRead } = await fileHandle.read(buffer, 0, tailByteCount, tailStartOffset);
			const readBuffer = buffer.subarray(0, bytesRead);
			return tailStartOffset === 0
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
}

// CLI 的比较器：整毫秒 mtime 降序，并列时 sessionId 降序。这里取「排在最前的那一个」。
function comparesAheadOfResumeCandidate(
	candidate: ClaudeTranscriptFileCandidateForResume,
	incumbent: ClaudeTranscriptFileCandidateForResume,
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
