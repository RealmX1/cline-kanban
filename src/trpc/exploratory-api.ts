// Exploratory Mode 的 tRPC handler 层（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md）。
// 纯委托：读写交给 src/state/exploratory-session-map-store.ts，写回校验交给
// src/state/exploratory-session-map-apply-funnel.ts（四道闸的唯一落装点），投影加载交给
// src/conversation-tree/load-conversation-session-turn-projection.ts（与投影 query 同一条链）。

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import {
	type ConversationSessionTurnProjectionScope,
	loadConversationSessionTurnProjection,
} from "../conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeExploratorySessionMapCollection,
	RuntimeGetExploratorySessionMapRequest,
	RuntimeGetExploratorySessionMapResponse,
	RuntimeIngestExploratorySessionMapUpdateRequest,
	RuntimeIngestExploratorySessionMapUpdateResponse,
} from "../core/api-contract";
import {
	applyExploratorySessionMapUpdateFunnel,
	type ExploratorySessionMapApplyFunnelResult,
} from "../state/exploratory-session-map-apply-funnel";
import {
	mutateExploratorySessionMapState,
	readExploratorySessionMapCollection,
} from "../state/exploratory-session-map-store";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateExploratoryApiDependencies {
	getScopedClineTaskSessionService: (
		scope: ConversationSessionTurnProjectionScope,
	) => Promise<ClineTaskSessionService>;
	loadBoardCardAgentId: (scope: ConversationSessionTurnProjectionScope, taskId: string) => Promise<string | null>;
	// 集合变更广播出口（runtime-server 注入 runtime-state-hub 的
	// broadcastExploratorySessionMapUpdated）。只在 apply 成功落盘后调用
	// （durable-write-before-ack，蓝图 §B.2 闸 5）。
	onExploratorySessionMapUpdated: (
		workspaceId: string,
		conversationSessionTaskId: string,
		mapCollection: RuntimeExploratorySessionMapCollection,
	) => void;
}

export function createExploratoryApi(deps: CreateExploratoryApiDependencies): RuntimeTrpcContext["exploratoryApi"] {
	return {
		getSessionMap: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetExploratorySessionMapRequest,
		): Promise<RuntimeGetExploratorySessionMapResponse> => {
			const mapCollection = await readExploratorySessionMapCollection(
				scope.workspaceId,
				input.conversationSessionTaskId,
			);
			return { mapCollection };
		},

		ingestSessionMapUpdate: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeIngestExploratorySessionMapUpdateRequest,
		): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> => {
			// 先把 apply 时刻的投影快照取好（含 checkpoint 保留集合），再进串行写队列跑漏斗——
			// 快照取数与落盘之间投影可能又前进，那一档由闸 3 的签名对账兜住（拒绝并按新边沿
			// 重触发再维护），这里不追求跨子系统的完美原子性（蓝图 §B.2 的既定取舍）。
			const snapshot = await loadConversationSessionTurnProjection(deps, scope, input.conversationSessionTaskId);
			const turnUserMessagePreviewByTurnNumber = new Map<number, string>();
			let latestTurnNumber = 0;
			for (const entry of snapshot.projection.entries) {
				latestTurnNumber = entry.turnNumber;
				if (entry.turnUserMessageExcerpt !== null) {
					turnUserMessagePreviewByTurnNumber.set(entry.turnNumber, entry.turnUserMessageExcerpt);
				}
			}

			let currentCollectionForResponse: RuntimeExploratorySessionMapCollection | null = null;
			// 经对象属性带出闭包赋值：TS 不会对跨调用的对象属性做 null 收窄（let 变量会被
			// 收窄成 never）。
			const funnelOutcome: { result: ExploratorySessionMapApplyFunnelResult | null } = { result: null };
			await mutateExploratorySessionMapState(scope.workspaceId, (state) => {
				const currentCollection =
					state.mapCollectionsByConversationSessionTaskId[input.conversationSessionTaskId] ?? null;
				currentCollectionForResponse = currentCollection;
				funnelOutcome.result = applyExploratorySessionMapUpdateFunnel({
					currentCollection,
					request: input,
					projection: {
						harnessSource: snapshot.harnessSource,
						turnProjectionSignature: snapshot.projection.signature,
						latestTurnNumber,
						turnUserMessagePreviewByTurnNumber,
						retainedCheckpointCommits: snapshot.retainedCheckpointCommits,
					},
					nodeGenerationSource: "agent_live_session_maintenance",
					now: Date.now(),
				});
				if (funnelOutcome.result.outcome !== "applied") {
					return null;
				}
				return {
					...state,
					mapCollectionsByConversationSessionTaskId: {
						...state.mapCollectionsByConversationSessionTaskId,
						[input.conversationSessionTaskId]: funnelOutcome.result.mapCollection,
					},
				};
			});

			// mutator 在串行队列里同步执行完毕，result 必已赋值。
			const result = funnelOutcome.result;
			if (result === null) {
				throw new Error("exploratory session map funnel did not run");
			}
			if (result.outcome === "rejected") {
				return {
					applied: false,
					rejectionReason: result.rejectionReason,
					mapCollection: currentCollectionForResponse,
				};
			}
			if (result.outcome === "applied") {
				// durable 写已成功（mutate 返回即落盘完成）→ 广播 + ack（durable-write-before-ack）。
				deps.onExploratorySessionMapUpdated(
					scope.workspaceId,
					input.conversationSessionTaskId,
					result.mapCollection,
				);
			}
			// dedup_ack：幂等成功，不重写不广播，回现状集合供调用方重同步。
			return { applied: true, rejectionReason: null, mapCollection: result.mapCollection };
		},
	};
}
