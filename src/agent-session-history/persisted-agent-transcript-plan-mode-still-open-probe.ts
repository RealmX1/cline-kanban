// 「这段 Claude 对话死掉时，是不是还停在一个没批准的 plan 里」——续跑前读 agent 自己落盘的转录来回答。
//
// 为什么非要有它：续跑（手动重启 / 打开任务时自动续跑 / 从 Done 恢复 / 为投递答案拉起已回收会话）一律不重放
// 「plan 起步」，却照样带上卡片的放权旗标（bypass 档是 `--dangerously-skip-permissions`）。Claude 自己本会在
// 交互式续跑时恢复 plan（存储的模式是 plan 且计划段落未退出），但命令行一旦显式指定权限模式就不再恢复。
// 于是会话死前若还在 plan 里，续跑出来就直接跳出了 plan——09-14 ～ 10-12 实测 18 次，其中 4 次 agent 没出计划
// 就开始改代码（最危险的形态：问题在 plan 里待答 → 会话被回收 → Kanban 补发答复 → 以 bypass 续跑）。
// 「起步意图」只回答开局那一刻；会话**此刻**在什么模式，只有转录记得。
//
// 转录里与此相关的记录（实测 Claude Code 2.1.x）：
//   - `{"type":"permission-mode","permissionMode":"plan"}`：每回合写一条当时的模式（无时间戳）；
//   - 人工提交的 user 记录自带 `permissionMode`；
//   - plan 期间每回合注入 `{"type":"attachment","attachment":{"type":"plan_mode"}}`，
//     退出后的下一回合注入 `attachment.type === "plan_mode_exit"`；
//   - agent 调 ExitPlanMode 后，获批的 tool_result 不带 `is_error`，被拒的 `is_error: true`。
// 「批准计划 → 立刻开工 → 还没到下一个人工回合就被回收」时，最后一条模式记录仍是 plan，只有其后获批的
// ExitPlanMode 结果能说明计划段落已经结束——故两类信号都要看。

import type { RuntimeAgentId } from "../core/api-contract";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import {
	readCompleteJsonLinesFromClaudeTranscriptTail,
	resolveClaudeTranscriptFileForAgentNativeConversationSession,
	resolveClaudeTranscriptFileThatContinueWouldResume,
} from "./claude-transcript-file-location-for-resume";

// 尾窗预算。plan 阶段的回合多是大块只读调研（Read / Grep 的大结果），最后一条模式记录可能离文件末尾不近，
// 故给得比模型探针（256KB）宽；续跑时只读一次，1MB 的顺序读成本可忽略。
export const MAX_TRANSCRIPT_TAIL_BYTES_PER_PLAN_MODE_PROBE_FILE = 1024 * 1024;

const CLAUDE_PLAN_PERMISSION_MODE = "plan";
const CLAUDE_EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

export type ClaudeConversationPlanModeStateBeforeResume = "plan_mode_still_open" | "plan_mode_not_open";

export function supportsPersistedAgentTranscriptPlanModeStillOpenProbe(
	agentId: RuntimeAgentId | null | undefined,
): boolean {
	return agentId === "claude";
}

// 返回 null 的含义一律是「这次问不出结论」（agent 不支持 / 没有转录 / 读失败 / 尾窗里没有任何模式记录），
// 调用方必须把 null 当作「维持原有规则」，不得据此推断会话不在 plan 里。
export async function probeClaudeConversationPlanModeStateBeforeResume(input: {
	agentId: RuntimeAgentId | null | undefined;
	// 会话真正的工作目录（任务 worktree）：转录目录名由它编码而成，传错不会报错，只会静默查不到。
	workspacePath: string | null | undefined;
	// 有原生 session id（`--resume <id>` 续跑）就按 id 取；没有（`--continue`）就取 CLI 会接上的那一个。
	agentNativeConversationSessionId: string | null | undefined;
	// 覆盖 home 目录，供测试用真实文件系统夹具驱动（不 mock fs）。
	homeDirectoryPath?: string;
}): Promise<ClaudeConversationPlanModeStateBeforeResume | null> {
	const workspacePath = input.workspacePath?.trim();
	if (!workspacePath || !supportsPersistedAgentTranscriptPlanModeStillOpenProbe(input.agentId)) {
		return null;
	}
	const agentNativeConversationSessionId = input.agentNativeConversationSessionId?.trim();
	const transcriptFile = agentNativeConversationSessionId
		? await resolveClaudeTranscriptFileForAgentNativeConversationSession({
				workspacePath,
				agentNativeConversationSessionId,
				homeDirectoryPath: input.homeDirectoryPath,
			})
		: await resolveClaudeTranscriptFileThatContinueWouldResume(workspacePath, input.homeDirectoryPath);
	if (!transcriptFile) {
		return null;
	}
	const lines = await readCompleteJsonLinesFromClaudeTranscriptTail(
		transcriptFile,
		MAX_TRANSCRIPT_TAIL_BYTES_PER_PLAN_MODE_PROBE_FILE,
	);
	if (!lines) {
		return null;
	}
	return deriveClaudeConversationPlanModeStateFromTranscriptLines(lines);
}

export function deriveClaudeConversationPlanModeStateFromTranscriptLines(
	lines: readonly string[],
): ClaudeConversationPlanModeStateBeforeResume | null {
	let lastObservedPermissionMode: string | null = null;
	let planModeExitObservedAfterLastPermissionModeObservation = false;
	const exitPlanModeToolUseIdentities = new Set<string>();
	for (const line of lines) {
		const record = parseTranscriptJsonRecord(line);
		// 侧链（subagent）有自己的模式语境，不代表主对话。
		if (!record || record.isSidechain === true) {
			continue;
		}
		if (record.type === "permission-mode" && typeof record.permissionMode === "string") {
			lastObservedPermissionMode = record.permissionMode;
			planModeExitObservedAfterLastPermissionModeObservation = false;
			continue;
		}
		if (record.type === "attachment") {
			const attachmentType = readTranscriptRecord(record.attachment)?.type;
			if (attachmentType === "plan_mode") {
				lastObservedPermissionMode = CLAUDE_PLAN_PERMISSION_MODE;
				planModeExitObservedAfterLastPermissionModeObservation = false;
			} else if (attachmentType === "plan_mode_exit") {
				planModeExitObservedAfterLastPermissionModeObservation = true;
			}
			continue;
		}
		const message = readTranscriptRecord(record.message);
		const contentBlocks = Array.isArray(message?.content) ? message.content : [];
		if (record.type === "assistant") {
			for (const contentBlock of contentBlocks) {
				const block = readTranscriptRecord(contentBlock);
				if (
					block?.type === "tool_use" &&
					block.name === CLAUDE_EXIT_PLAN_MODE_TOOL_NAME &&
					typeof block.id === "string"
				) {
					exitPlanModeToolUseIdentities.add(block.id);
				}
			}
			continue;
		}
		if (record.type === "user") {
			if (typeof record.permissionMode === "string") {
				lastObservedPermissionMode = record.permissionMode;
				planModeExitObservedAfterLastPermissionModeObservation = false;
			}
			for (const contentBlock of contentBlocks) {
				const block = readTranscriptRecord(contentBlock);
				if (
					block?.type === "tool_result" &&
					typeof block.tool_use_id === "string" &&
					exitPlanModeToolUseIdentities.has(block.tool_use_id) &&
					block.is_error !== true
				) {
					planModeExitObservedAfterLastPermissionModeObservation = true;
				}
			}
		}
	}
	if (lastObservedPermissionMode === null) {
		return null;
	}
	return lastObservedPermissionMode === CLAUDE_PLAN_PERMISSION_MODE &&
		!planModeExitObservedAfterLastPermissionModeObservation
		? "plan_mode_still_open"
		: "plan_mode_not_open";
}
