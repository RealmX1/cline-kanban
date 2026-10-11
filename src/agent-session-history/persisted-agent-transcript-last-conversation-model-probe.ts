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
// claude-transcript-file-location-for-resume.ts 的 resolveClaudeTranscriptFileThatContinueWouldResume，并同步放宽 supports… 谓词。

import type { RuntimeAgentId } from "../core/api-contract";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import {
	type ClaudeTranscriptFileCandidateForResume,
	readCompleteJsonLinesFromClaudeTranscriptTail,
	resolveClaudeTranscriptFileForAgentNativeConversationSession,
	resolveClaudeTranscriptFileThatContinueWouldResume,
} from "./claude-transcript-file-location-for-resume";

// 单个转录文件的**尾部**读取预算。见 readLastAgentOutputModelIdentityFromTranscriptTail：本探针只读尾部，
// 刻意不读头部，故这是一段连续的尾窗，不是「头 1/4 + 尾 3/4」那种分段预算。
export const MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE = 256 * 1024;

// Claude Code 用来表示「这条记录不是真的模型产出」的占位 model id（本地合成的提示/中断消息）。
// 采信它就会把对话钉到一个 CLI 根本无法解析的名字上。
const SYNTHETIC_TRANSCRIPT_MODEL_IDENTITY = "<synthetic>";

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
// 选中的文件（`--continue` 会恢复的那一个）里若读不出模型，正确答案也是 null 而不是去翻别的文件：那种会话
// `--continue` 本来也无从重建模型，会落到 CLI 自身默认，看板这边保持原有规则即可。
export async function probePersistedAgentTranscriptLastConversationModelIdentity(
	input: PersistedAgentTranscriptLastConversationModelProbeInput,
): Promise<string | null> {
	const workspacePath = input.workspacePath?.trim();
	if (!workspacePath || !supportsPersistedAgentTranscriptLastConversationModelProbe(input.agentId)) {
		return null;
	}
	const transcriptFile = await resolveClaudeTranscriptFileThatContinueWouldResume(
		workspacePath,
		input.homeDirectoryPath,
	);
	if (!transcriptFile) {
		return null;
	}
	return await readLastAgentOutputModelIdentityFromTranscriptTail(transcriptFile);
}

// 按**会话自己的原生 session id** 定位转录，而不是复刻 `--continue` 的挑法。
//
// 为什么必须另开一个入口：`--continue` 那条路问的是「这个工作目录里最近那段对话用了什么模型」，而主会话与
// 它的 By the way 侧问、以及同仓库下多个 inplace 任务共用同一个 cwd —— 那时它会把**别人**的模型套到本会话
// 头上，还会顺手写回卡片固化下来。会话按 id 续跑时，模型也必须按同一个 id 取。
//
// 刻意**不**给 resolveClaudeTranscriptFileThatContinueWouldResume 加一个可选参数：那个函数的全部价值在于
// 忠实复刻 CLI 的挑法（模块头与它自己的注释都立了这条规矩），掺进 by-id 分支会毁掉它的单一答案性。
//
// 返回 null 的含义与 cwd 版完全一致：「这次问不出结论」，调用方按原有规则决定模型。
export async function probePersistedAgentTranscriptModelIdentityForAgentNativeConversationSession(input: {
	agentId: RuntimeAgentId | null | undefined;
	// 会话真正的工作目录（任务 worktree）——转录目录名仍由它编码而成，只是目录里挑哪个文件改由 id 决定。
	workspacePath: string | null | undefined;
	// harness 自己的 session id（summary sidecar agentNativeConversationSessionIdentity.nativeSessionId）。
	agentNativeConversationSessionId: string | null | undefined;
	homeDirectoryPath?: string;
}): Promise<string | null> {
	const workspacePath = input.workspacePath?.trim();
	const sessionIdentity = input.agentNativeConversationSessionId?.trim();
	if (
		!workspacePath ||
		!sessionIdentity ||
		!supportsPersistedAgentTranscriptLastConversationModelProbe(input.agentId)
	) {
		return null;
	}
	const transcriptFile = await resolveClaudeTranscriptFileForAgentNativeConversationSession({
		workspacePath,
		agentNativeConversationSessionId: sessionIdentity,
		homeDirectoryPath: input.homeDirectoryPath,
	});
	if (!transcriptFile) {
		return null;
	}
	return await readLastAgentOutputModelIdentityFromTranscriptTail(transcriptFile);
}

// 只读**尾部**一段连续字节，读不出结论就返回 null——刻意不像同目录的进度探针那样在超预算时兼读头段。
//
// 头段兜底在这里是**错的**：尾窗若整段都是超大 attachment / tool_result 记录、一条 assistant 都没有，
// 头段命中的是**对话开头**的模型。那个陈旧模型会经 `--model` 真的启动，还会被写回卡片永久固化——
// 正好复现本模块要修的那类「恢复后跑错模型」，且比原 bug 更难察觉。实测本机 475 个超预算转录中有 1 个
// （69MB）确实命中该形状：全文件真值是 claude-opus-4-8，而头段给出的是更早的 claude-opus-4-7。
// 返回 null 只是让调用方回落原有规则，是安全的一侧。
async function readLastAgentOutputModelIdentityFromTranscriptTail(
	candidate: ClaudeTranscriptFileCandidateForResume,
): Promise<string | null> {
	const lines = await readCompleteJsonLinesFromClaudeTranscriptTail(
		candidate,
		MAX_TRANSCRIPT_TAIL_BYTES_PER_MODEL_PROBE_FILE,
	);
	if (!lines) {
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
