// Conversation Tree / turn 投影层的 tRPC handler 层（姊妹蓝图 §2.2 的 query 形状，
// exploratory 蓝图 M0 的锚点基座数据源）。
// 纯委托：投影派生交给 src/conversation-tree/conversation-turn-projection.ts（纯函数），
// Cline 会话服务与看板 agentId 判定由 runtime-server 经 DI 注入。
//
// M0 只接 Cline SDK 源（exact_structured）；PTY 会话按 session 粒度降级为
// unavailable_live_terminal_pty（终端 transcript 全量提取器属姊妹蓝图步骤 4 的其余部分）。
// ACP 会话同样落入该降级档——枚举名的字面语义对 ACP 不精确（其消息在内存、非 PTY），
// M0 实施注记已记录，ACP 投影源形态待蓝图补章后落地。

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import {
	deriveConversationTurnProjection,
	sliceConversationTurnProjectionEntries,
} from "../conversation-tree/conversation-turn-projection";
import type {
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
} from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { listTaskTurnCheckpointRefs } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

// 源不可用时的占位签名（与空消息流的投影签名同形，见 buildConversationTurnProjectionSignature）。
const UNAVAILABLE_PROJECTION_SIGNATURE = "0:none:0";

export interface CreateConversationTreeApiDependencies {
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	// 看板卡片上该 task 声明的 agentId（无卡片 / 未声明 → null）。廉价判定信号：绝不为
	// 终端任务触发 loadTaskSessionMessages——后者对非活会话会 boot Cline SDK session host
	// （deployment-api 的 loadTaskAgentResponsePreview 同款先例）。
	loadBoardCardAgentId: (scope: RuntimeTrpcWorkspaceScope, taskId: string) => Promise<string | null>;
}

export function createConversationTreeApi(
	deps: CreateConversationTreeApiDependencies,
): RuntimeTrpcContext["conversationTreeApi"] {
	return {
		getConversationSessionTurnProjection: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConversationSessionTurnProjectionRequest,
		): Promise<RuntimeConversationSessionTurnProjectionResponse> => {
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(scope);
			const liveSummary = clineTaskSessionService.getSummary(input.conversationSessionTaskId);
			// 双廉价信号判定（in-memory summary agentId + 看板卡片 agentId）：by-the-way 侧会话
			// 不是看板卡片、只能靠活 summary；重启后的主会话没有活 summary、只能靠卡片。
			// 两者都判不出 Cline 时不碰消息加载，直接按 session 粒度降级。
			const isClineSession =
				liveSummary?.agentId === "cline" ||
				(liveSummary == null &&
					(await deps.loadBoardCardAgentId(scope, input.conversationSessionTaskId)) === "cline");
			if (!isClineSession) {
				return {
					harnessSource: "unavailable_live_terminal_pty",
					turnProjectionEntries: [],
					turnProjectionSignature: UNAVAILABLE_PROJECTION_SIGNATURE,
					turnProjectionIsIncomplete: false,
				};
			}
			const messages = await clineTaskSessionService.loadTaskSessionMessages(input.conversationSessionTaskId);
			// checkpoint 对齐输入是 best-effort：git 故障不拖垮投影查询——锚点如实降级 unaligned。
			const checkpointRefs = await listTaskTurnCheckpointRefs({
				cwd: scope.workspacePath,
				taskId: input.conversationSessionTaskId,
			}).catch(() => []);
			const projection = deriveConversationTurnProjection(messages, {
				checkpointAlignment: {
					checkpointCommitsByTurnNumber: new Map(checkpointRefs.map((entry) => [entry.turn, entry.commit])),
					latestCheckpointTurnNumber: liveSummary?.latestTurnCheckpoint?.turn ?? null,
				},
				finalTurnIsInProgress: liveSummary !== null && resolveSessionFacets(liveSummary).turnOwner === "agent",
			});
			const sliced = sliceConversationTurnProjectionEntries(projection.entries, {
				sinceTurnNumber: input.sinceTurnNumber,
				maxTurnEntries: input.maxTurnEntries,
			});
			return {
				harnessSource: "exact_structured",
				turnProjectionEntries: sliced.entries,
				turnProjectionSignature: projection.signature,
				turnProjectionIsIncomplete: sliced.isIncomplete,
			};
		},
	};
}
