// 把宿主的会话 summary 翻译成核心包要的 `ConversationSessionRef[]`（B.2 宿主胶水）。
//
// 一个 exploration（= 一张 Kanban 卡片）物理上是一组会话：主会话，加上从它分叉出来的
// by-the-way 会话。核心包不认识 Kanban 的任何概念，它只要一个数组，且**主会话必须在 `[0]`**
// ——fork 的就是它。本模块负责这次翻译，纯函数，无 IO。
//
// 判据不是「agentId === claude」这样的硬编码，而是**两个 sidecar 都在、且指向同一个 harness**：
//   - `agentNativeConversationSessionIdentity`（N0a）给出原生 session id 与 transcript 路径；
//   - `agentSessionForkReplayLaunchArguments` 给出启动那一刻的 argv 快照（fork 要逐字回传）。
// 两者都只在已接入的 harness 上盖章，所以「有没有它们」本身就是能力谓词。**还必须校验两者的
// `sourceAgentId` 彼此一致、且等于会话当前的 `agentId`**：同一张卡片换过 agent 时，旧活体留下的
// sidecar 可能还在 summary 里，照着它 fork 就是拿 A 会话的身份去跑 B 会话的参数。
//
// 任何一项缺失都只是「这条会话进不了本次作业」，绝不抛错——老会话本来就没有这些 sidecar，
// 它们要等下一次启动才补上。但**主会话不可用时整体放弃**：没有它就没有可 fork 的对象。

import type { ConversationSessionRef } from "agent-conversation-exploration-thread-graph/core";
import { CLAUDE_CODE_HARNESS_KIND } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isTaskConversationSessionWithoutTaskLifecycleAuthority } from "../core/session-activity";

// 会话被排除的原因。只用于诊断与测试断言——调用方不据此分支，缺就是缺。
export type ExplorationThreadGraphSessionRefExclusionReason =
	| "missing_native_conversation_session_identity"
	| "missing_fork_replay_launch_arguments"
	| "missing_transcript_path"
	| "missing_working_directory"
	| "sidecar_agent_mismatch"
	| "unsupported_harness";

export interface ExplorationThreadGraphExcludedSession {
	taskId: string;
	reason: ExplorationThreadGraphSessionRefExclusionReason;
}

export interface ExplorationThreadGraphSessionRefAssembly {
	// 主会话恒在 [0]；主会话不可用时整个数组为空。
	sessionRefs: ConversationSessionRef[];
	excludedSessions: ExplorationThreadGraphExcludedSession[];
	// 原生 session id → 宿主 taskId 的反查表。
	//
	// 核心包全程只认原生 session id（图里的每个 turnRef 都用它），而宿主这边的 findings provenance
	// 链接要的是 **taskId**。两个 id 空间必须显式桥接：从 taskId 推不出 session id，反过来也一样。
	hostTaskIdByNativeSessionId: Record<string, string>;
}

// 目前唯一已核实 fork 语义的 harness。sidecar 的 sourceAgentId 用的是宿主的 agentId 口径
// （见 api-contract 的 runtimeAgentNativeConversationSessionIdentitySchema 注释），与核心包的
// harnessKind 不是同一个词表，所以这里显式做一次映射而不是直接透传。
const FORK_CAPABLE_HOST_AGENT_ID = "claude";

// 单条会话的翻译。返回 null 表示这条进不了本次作业（原因写进 excluded）。
function buildConversationSessionRefFromSummary(
	summary: RuntimeTaskSessionSummary,
	excludedSessions: ExplorationThreadGraphExcludedSession[],
): ConversationSessionRef | null {
	const exclude = (reason: ExplorationThreadGraphSessionRefExclusionReason): null => {
		excludedSessions.push({ taskId: summary.taskId, reason });
		return null;
	};

	const nativeIdentity = summary.agentNativeConversationSessionIdentity;
	if (!nativeIdentity) {
		return exclude("missing_native_conversation_session_identity");
	}
	const forkReplayLaunchArguments = summary.agentSessionForkReplayLaunchArguments;
	if (!forkReplayLaunchArguments) {
		return exclude("missing_fork_replay_launch_arguments");
	}

	// 两个 sidecar 必须同源，且就是这个会话当前跑着的 agent。任一不符都说明手里的是换 agent 之前
	// 留下的陈旧快照——宁可这一轮不判，也绝不拿错身份去 fork。
	if (nativeIdentity.sourceAgentId !== forkReplayLaunchArguments.sourceAgentId) {
		return exclude("sidecar_agent_mismatch");
	}
	// `agentId === null`（session-manager 的空壳 summary、会话被回收后残留 sidecar 的记录）同样算不一致：
	// 「确认不了当前身份」时放行，等于拿一份无从核对的旧身份去 fork，方向与本模块的边界相反。
	if (summary.agentId !== nativeIdentity.sourceAgentId) {
		return exclude("sidecar_agent_mismatch");
	}
	if (nativeIdentity.sourceAgentId !== FORK_CAPABLE_HOST_AGENT_ID) {
		return exclude("unsupported_harness");
	}

	// transcript 路径是 turn 序列的唯一来源；工作目录决定 fork 出的分身在哪里跑。
	// 两者都不可推导（绝不从 ~/.claude/projects 反推），缺了就是缺。
	if (nativeIdentity.transcriptPath === null) {
		return exclude("missing_transcript_path");
	}
	if (summary.workspacePath === null) {
		return exclude("missing_working_directory");
	}

	const conversationSessionMetadata = summary.taskConversationSessionMetadata;
	const forkedFromParentSessionTurnNumber =
		conversationSessionMetadata?.taskConversationSessionRole === "by_the_way" &&
		conversationSessionMetadata.mainSessionOriginTurnNumber !== null
			? conversationSessionMetadata.mainSessionOriginTurnNumber
			: undefined;

	return {
		harnessKind: CLAUDE_CODE_HARNESS_KIND,
		nativeSessionId: nativeIdentity.nativeSessionId,
		transcriptPath: nativeIdentity.transcriptPath,
		workingDirectory: summary.workspacePath,
		launchArgvTemplate: {
			// model 是 argv 字面值（通常是浮动别名 `default`），原样回传；绝不解析。
			model: forkReplayLaunchArguments.modelArgumentLiteral ?? "",
			appendSystemPrompt: forkReplayLaunchArguments.appendSystemPromptText,
			settingsPath: forkReplayLaunchArguments.settingsFilePath,
			// 宿主不额外追加 argv：分身的参数面必须与主会话一致，多给一个就是多一处分歧。
			extraArgs: [],
		},
		...(forkedFromParentSessionTurnNumber === undefined ? {} : { forkedFromParentSessionTurnNumber }),
	};
}

/**
 * 判断某条会话 summary 是否属于给定 exploration（= 主任务卡片）。
 *
 * 主会话的 `taskId` 就是 explorationId；by-the-way 会话有自己的 taskId，经
 * `taskConversationSessionMetadata.workspaceTaskId` 指回主任务。
 */
export function isSessionBelongingToExploration(summary: RuntimeTaskSessionSummary, explorationId: string): boolean {
	if (summary.taskId === explorationId) {
		return true;
	}
	return summary.taskConversationSessionMetadata?.workspaceTaskId === explorationId;
}

/**
 * 组装本次作业的 `sessions[]`。主会话恒在 `[0]`，by-the-way 会话按 taskId 排在其后
 * （稳定序：作业的 prompt 里会逐条列出它们，序抖动会让 prompt 前缀无谓变化）。
 *
 * 主会话缺席或不可用 ⇒ 返回空数组：fork 的对象就是主会话，没有它这次作业无从谈起。
 */
export function assembleExplorationThreadGraphSessionRefs(input: {
	explorationId: string;
	sessionSummaries: readonly RuntimeTaskSessionSummary[];
}): ExplorationThreadGraphSessionRefAssembly {
	const excludedSessions: ExplorationThreadGraphExcludedSession[] = [];
	const belongingSummaries = input.sessionSummaries.filter((summary) =>
		isSessionBelongingToExploration(summary, input.explorationId),
	);

	const hostTaskIdByNativeSessionId: Record<string, string> = {};
	const mainSummary = belongingSummaries.find(
		(summary) => !isTaskConversationSessionWithoutTaskLifecycleAuthority(summary),
	);
	if (mainSummary === undefined) {
		return { sessionRefs: [], excludedSessions, hostTaskIdByNativeSessionId };
	}
	const mainSessionRef = buildConversationSessionRefFromSummary(mainSummary, excludedSessions);
	if (mainSessionRef === null) {
		return { sessionRefs: [], excludedSessions, hostTaskIdByNativeSessionId };
	}
	hostTaskIdByNativeSessionId[mainSessionRef.nativeSessionId] = mainSummary.taskId;

	const byTheWaySessionRefs: ConversationSessionRef[] = [];
	const byTheWaySummaries = belongingSummaries
		.filter((summary) => summary.taskId !== mainSummary.taskId)
		.sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
	for (const summary of byTheWaySummaries) {
		const sessionRef = buildConversationSessionRefFromSummary(summary, excludedSessions);
		if (sessionRef !== null) {
			byTheWaySessionRefs.push(sessionRef);
			hostTaskIdByNativeSessionId[sessionRef.nativeSessionId] = summary.taskId;
		}
	}

	return {
		sessionRefs: [mainSessionRef, ...byTheWaySessionRefs],
		excludedSessions,
		hostTaskIdByNativeSessionId,
	};
}
