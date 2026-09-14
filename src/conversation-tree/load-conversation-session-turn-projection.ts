// 会话 turn 投影的运行时加载器：把「双廉价信号判定 Cline → 加载消息 → 枚举 checkpoint refs →
// 派生投影」这条链从 conversation-tree-api 的 query handler 抽出，供 exploratory 写回 apply
// 漏斗（apply 时刻的签名对账 / 锚点可解析性校验）复用。投影查询与写回校验必须共用同一条
// 加载链——各写一份就会各自漂移，正是姊妹蓝图风险 1 的三源对齐纪律要防的事。

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConversationTurnProjectionHarnessSource } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { listTaskTurnCheckpointRefs } from "../workspace/turn-checkpoints";
import { type ConversationTurnProjection, deriveConversationTurnProjection } from "./conversation-turn-projection";

// 源不可用时的占位签名（与空消息流的投影签名同形，见 buildConversationTurnProjectionSignature）。
export const UNAVAILABLE_PROJECTION_SIGNATURE = "0:none:0";

export interface ConversationSessionTurnProjectionScope {
	workspaceId: string;
	workspacePath: string;
}

export interface ConversationSessionTurnProjectionSnapshot {
	harnessSource: RuntimeConversationTurnProjectionHarnessSource;
	// 源不可用时 entries 为空、签名为 UNAVAILABLE_PROJECTION_SIGNATURE。
	projection: ConversationTurnProjection;
	// 该任务保留的 checkpoint commit 集合（apply 漏斗校验 agent 自报锚点 commit 的输入）。
	// best-effort：git 故障时为空集——投影条目照常如实降级 unaligned。
	retainedCheckpointCommits: ReadonlySet<string>;
}

export interface LoadConversationSessionTurnProjectionDependencies {
	getScopedClineTaskSessionService: (
		scope: ConversationSessionTurnProjectionScope,
	) => Promise<ClineTaskSessionService>;
	// 看板卡片上该 task 声明的 agentId（无卡片 / 未声明 → null）。廉价判定信号：绝不为
	// 终端任务触发 loadTaskSessionMessages——后者对非活会话会 boot Cline SDK session host
	// （deployment-api 的 loadTaskAgentResponsePreview 同款先例）。
	loadBoardCardAgentId: (scope: ConversationSessionTurnProjectionScope, taskId: string) => Promise<string | null>;
}

export async function loadConversationSessionTurnProjection(
	deps: LoadConversationSessionTurnProjectionDependencies,
	scope: ConversationSessionTurnProjectionScope,
	conversationSessionTaskId: string,
): Promise<ConversationSessionTurnProjectionSnapshot> {
	const clineTaskSessionService = await deps.getScopedClineTaskSessionService(scope);
	const liveSummary = clineTaskSessionService.getSummary(conversationSessionTaskId);
	// 双廉价信号判定（in-memory summary agentId + 看板卡片 agentId）：by-the-way 侧会话
	// 不是看板卡片、只能靠活 summary；重启后的主会话没有活 summary、只能靠卡片。
	// 两者都判不出 Cline 时不碰消息加载，直接按 session 粒度降级。
	const isClineSession =
		liveSummary?.agentId === "cline" ||
		(liveSummary == null && (await deps.loadBoardCardAgentId(scope, conversationSessionTaskId)) === "cline");
	if (!isClineSession) {
		return {
			harnessSource: "unavailable_live_terminal_pty",
			projection: { entries: [], signature: UNAVAILABLE_PROJECTION_SIGNATURE },
			retainedCheckpointCommits: new Set(),
		};
	}
	const messages = await clineTaskSessionService.loadTaskSessionMessages(conversationSessionTaskId);
	// checkpoint 对齐输入是 best-effort：git 故障不拖垮投影——锚点如实降级 unaligned。
	const checkpointRefs = await listTaskTurnCheckpointRefs({
		cwd: scope.workspacePath,
		taskId: conversationSessionTaskId,
	}).catch(() => []);
	const projection = deriveConversationTurnProjection(messages, {
		checkpointAlignment: {
			checkpointCommitsByTurnNumber: new Map(checkpointRefs.map((entry) => [entry.turn, entry.commit])),
			latestCheckpointTurnNumber: liveSummary?.latestTurnCheckpoint?.turn ?? null,
		},
		finalTurnIsInProgress: liveSummary !== null && resolveSessionFacets(liveSummary).turnOwner === "agent",
	});
	return {
		harnessSource: "exact_structured",
		projection,
		retainedCheckpointCommits: new Set(checkpointRefs.map((entry) => entry.commit)),
	};
}
