// Exploratory Mode 的 tRPC handler 层（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md）。
// 纯委托：session map 读写交给 src/state/exploratory-session-map-store.ts，写回校验交给
// src/state/exploratory-session-map-apply-funnel.ts（闸的唯一落装点）；findings 读写交给
// src/state/exploratory-findings-store.ts（§D，人工动作为 zod 校验即够、agent 建议通道的
// provenance 可解析性校验在本层）；投影加载交给
// src/conversation-tree/load-conversation-session-turn-projection.ts（与投影 query 同一条链）。

import { TRPCError } from "@trpc/server";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import {
	type ConversationSessionTurnProjectionScope,
	loadConversationSessionTurnProjection,
} from "../conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeArchiveExploratoryFindingRequest,
	RuntimeArchiveExploratoryFindingResponse,
	RuntimeConfirmExploratoryFindingRequest,
	RuntimeConfirmExploratoryFindingResponse,
	RuntimeExploratoryFindingEntry,
	RuntimeExploratoryFindingProvenanceLink,
	RuntimeExploratorySessionMapCollection,
	RuntimeGetExploratoryFindingsRequest,
	RuntimeGetExploratoryFindingsResponse,
	RuntimeGetExploratorySessionMapRequest,
	RuntimeGetExploratorySessionMapResponse,
	RuntimeIngestExploratoryFindingCandidateRequest,
	RuntimeIngestExploratoryFindingCandidateResponse,
	RuntimeIngestExploratorySessionMapUpdateRequest,
	RuntimeIngestExploratorySessionMapUpdateResponse,
	RuntimeRejectExploratoryFindingRequest,
	RuntimeRejectExploratoryFindingResponse,
	RuntimeSaveExploratoryFindingRequest,
	RuntimeSaveExploratoryFindingResponse,
} from "../core/api-contract";
import {
	ExploratoryFindingsCapOverflowError,
	mutateExploratoryFindingsState,
	readExploratoryFindingEntries,
	readExploratoryFindingsState,
	type WorkspaceExploratoryFindingsState,
} from "../state/exploratory-findings-store";
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
	// session map 集合变更广播出口（runtime-server 注入 runtime-state-hub 的
	// broadcastExploratorySessionMapUpdated）。只在 apply 成功落盘后调用
	// （durable-write-before-ack，蓝图 §B.2 闸 5）。
	onExploratorySessionMapUpdated: (
		workspaceId: string,
		conversationSessionTaskId: string,
		mapCollection: RuntimeExploratorySessionMapCollection,
	) => void;
	// findings 集合变更广播出口（runtime-server 注入 runtime-state-hub 的
	// broadcastExploratoryFindingsUpdated）。只在变更落盘成功后调用
	// （durable-write-before-ack，蓝图 §D.3）；幂等空转（dedup / 已处目标态）不广播。
	onExploratoryFindingsUpdated: (workspaceId: string, findings: RuntimeExploratoryFindingEntry[]) => void;
}

// cap 沉默路径防线（容量取舍见 exploratory-findings-store 的 MAX 注释）：pending 永不
// 静默裁 ⇒ 容量被 pending 占满时，cap 的唯一可裁候选就是本次操作刚写入/更新的非 pending
// 条目——它会刚落库就被裁掉。操作目标没活下来必须显式失败（PRECONDITION_FAILED，
// 不广播），绝不「返回成功但 finding 消失」。该断言必须发生在 store 串行写队列的原子区内
// （cap 后、写盘前）——在 mutate 返回后再查，裁剪结果早已落盘提交，报错路径会伴随静默
// 删除。故本函数只经 mutate 的 postCapGuard 钩子注入执行（store 不知道哪个条目是操作目标，
// 目标语义由本层自带）；ingest 通道不经过本检查（pending 条目永不进裁剪候选，它的拒绝
// 统一走 store 的 ExploratoryFindingsCapOverflowError → findings_cap_overflow）。
function assertFindingSurvivedCap(nextState: WorkspaceExploratoryFindingsState, findingId: string): void {
	if (nextState.findingsById[findingId] === undefined) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Finding "${findingId}" could not be persisted within the per-workspace findings cap: pending suggestions are never trimmed silently and they currently fill the cap. Confirm or reject some pending findings first.`,
		});
	}
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
			// 先把 apply 时刻的投影快照（含 checkpoint 保留集合）与 findings 现状（闸 2.5
			// referencedFindingId 可解析性的输入）取好，再进串行写队列跑漏斗——快照取数与落盘
			// 之间投影可能又前进，那一档由闸 3 的签名对账兜住（拒绝并按新边沿重触发再维护），
			// 这里不追求跨子系统的完美原子性（蓝图 §B.2 的既定取舍）。
			const [snapshot, findingsState] = await Promise.all([
				loadConversationSessionTurnProjection(deps, scope, input.conversationSessionTaskId),
				readExploratoryFindingsState(scope.workspaceId),
			]);
			const existingFindingIds = new Set(Object.keys(findingsState.findingsById));
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
					existingFindingIds,
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

		// ---- findings（蓝图 §D，M2）----
		// 人工动作（save/confirm/reject/archive）：zod 校验即够、无需作业漏斗（§D.2.1）；
		// 每次成功变更落盘后广播全量新集合（durable-write-before-ack）。

		getFindings: async (
			scope: RuntimeTrpcWorkspaceScope,
			_input: RuntimeGetExploratoryFindingsRequest,
		): Promise<RuntimeGetExploratoryFindingsResponse> => {
			return { findings: await readExploratoryFindingEntries(scope.workspaceId) };
		},

		saveFinding: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSaveExploratoryFindingRequest,
		): Promise<RuntimeSaveExploratoryFindingResponse> => {
			// 经对象属性带出闭包赋值（同 ingestSessionMapUpdate 的 funnelOutcome 手法）。
			const outcome: { finding: RuntimeExploratoryFindingEntry | null; persisted: boolean } = {
				finding: null,
				persisted: false,
			};
			const nextState = await mutateExploratoryFindingsState(
				scope.workspaceId,
				(state) => {
					const existing = state.findingsById[input.findingId];
					if (existing !== undefined) {
						// 幂等：同 findingId 已存在 → 不变更、不广播，直接回现状条目。
						outcome.finding = existing;
						return null;
					}
					const now = Date.now();
					// 落库即 active + user_saved（蓝图 §D.2.1 人工保存主路径）。
					const finding: RuntimeExploratoryFindingEntry = {
						findingId: input.findingId,
						findingTitle: input.findingTitle,
						findingBodyMarkdown: input.findingBodyMarkdown,
						findingStatus: "active",
						supersededByFindingId: null,
						findingGenerationSource: "user_saved",
						provenanceLinks: input.provenanceLinks,
						originConversationSessionTaskId: input.originConversationSessionTaskId,
						createdAt: now,
						updatedAt: now,
					};
					outcome.finding = finding;
					outcome.persisted = true;
					return { ...state, findingsById: { ...state.findingsById, [input.findingId]: finding } };
				},
				// 目标存活断言进 store 原子区（cap 后、写盘前）：被裁则整体放弃写入并抛错。
				(next) => assertFindingSurvivedCap(next, input.findingId),
			);
			const finding = outcome.finding;
			if (finding === null) {
				throw new Error("exploratory findings mutate did not run");
			}
			if (outcome.persisted && nextState !== null) {
				// guard 已在写盘前断言目标存活——走到这里裁剪结果必然仍含目标条目。
				deps.onExploratoryFindingsUpdated(scope.workspaceId, Object.values(nextState.findingsById));
			}
			return { finding };
		},

		confirmFinding: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConfirmExploratoryFindingRequest,
		): Promise<RuntimeConfirmExploratoryFindingResponse> => {
			const outcome: { finding: RuntimeExploratoryFindingEntry | null } = { finding: null };
			const nextState = await mutateExploratoryFindingsState(
				scope.workspaceId,
				(state) => {
					const existing = state.findingsById[input.findingId];
					if (existing === undefined) {
						// 不存在的 findingId → finding: null（UI 幂等），不报错。
						return null;
					}
					if (existing.findingStatus !== "suggested_pending_confirmation") {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Finding "${input.findingId}" is not pending confirmation (status: ${existing.findingStatus}).`,
						});
					}
					const confirmed: RuntimeExploratoryFindingEntry = {
						...existing,
						findingStatus: "active",
						updatedAt: Date.now(),
					};
					outcome.finding = confirmed;
					return { ...state, findingsById: { ...state.findingsById, [input.findingId]: confirmed } };
				},
				// 同 saveFinding：目标存活断言进 store 原子区（confirm 会把 pending 目标变成
				// 可裁的 active——存量超限且 pending 占满时它会刚确认就被 cap 裁掉）。
				(next) => assertFindingSurvivedCap(next, input.findingId),
			);
			if (outcome.finding !== null && nextState !== null) {
				deps.onExploratoryFindingsUpdated(scope.workspaceId, Object.values(nextState.findingsById));
			}
			return { finding: outcome.finding };
		},

		rejectFinding: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRejectExploratoryFindingRequest,
		): Promise<RuntimeRejectExploratoryFindingResponse> => {
			const outcome = { removed: false };
			const nextState = await mutateExploratoryFindingsState(scope.workspaceId, (state) => {
				const existing = state.findingsById[input.findingId];
				if (existing === undefined) {
					// 不存在的 findingId → removed: false（UI 幂等），不报错。
					return null;
				}
				if (existing.findingStatus !== "suggested_pending_confirmation") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Finding "${input.findingId}" is not pending confirmation (status: ${existing.findingStatus}).`,
					});
				}
				// 物理删除：pending 建议尚未成为资产（蓝图 §D.2.2），删除类操作只有这一档物理抹除。
				outcome.removed = true;
				return {
					...state,
					findingsById: Object.fromEntries(
						Object.entries(state.findingsById).filter(([findingId]) => findingId !== input.findingId),
					),
				};
			});
			if (outcome.removed && nextState !== null) {
				deps.onExploratoryFindingsUpdated(scope.workspaceId, Object.values(nextState.findingsById));
			}
			return { removed: outcome.removed };
		},

		archiveFinding: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeArchiveExploratoryFindingRequest,
		): Promise<RuntimeArchiveExploratoryFindingResponse> => {
			const outcome: { finding: RuntimeExploratoryFindingEntry | null } = { finding: null };
			const nextState = await mutateExploratoryFindingsState(
				scope.workspaceId,
				(state) => {
					const existing = state.findingsById[input.findingId];
					if (existing === undefined) {
						// 不存在的 findingId → finding: null（UI 幂等），不报错。
						return null;
					}
					const targetStatus = input.archived ? "archived" : "active";
					if (existing.findingStatus === targetStatus) {
						// 已处目标态：幂等空转，不变更不广播。
						outcome.finding = existing;
						return null;
					}
					// active ↔ archived 软删/恢复环之外的状态机违规：pending 尚未成为资产（该走
					// reject，蓝图 §D.2.2）；superseded 的审计链（supersededByFindingId 互链）不可
					// 经 archive 改写。
					if (existing.findingStatus !== "active" && existing.findingStatus !== "archived") {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Finding "${input.findingId}" cannot be ${input.archived ? "archived" : "restored"} from status "${existing.findingStatus}".`,
						});
					}
					const updated: RuntimeExploratoryFindingEntry = {
						...existing,
						findingStatus: targetStatus,
						updatedAt: Date.now(),
					};
					outcome.finding = updated;
					return { ...state, findingsById: { ...state.findingsById, [input.findingId]: updated } };
				},
				// 同 saveFinding：archive 会把 active 目标变成可裁序第一档的 archived——
				// 目标存活断言进 store 原子区（cap 后、写盘前）。
				(next) => assertFindingSurvivedCap(next, input.findingId),
			);
			// 幂等空转时 outcome.finding 已赋值为现状条目但 nextState 为 null——不广播。
			if (outcome.finding !== null && nextState !== null) {
				deps.onExploratoryFindingsUpdated(scope.workspaceId, Object.values(nextState.findingsById));
			}
			return { finding: outcome.finding };
		},

		ingestFindingCandidate: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeIngestExploratoryFindingCandidateRequest,
		): Promise<RuntimeIngestExploratoryFindingCandidateResponse> => {
			// findingId 服务端派生（蓝图 §D.1：agent 建议 = clientProposalId 规范化），
			// agent 不可自报——同 clientProposalId 重发不落成两条。
			const findingId = `agent-${input.clientProposalId}`;
			// dedup 快路径：已存在（任意状态）→ 幂等 ack 回现状条目，不重写不广播。
			const existingState = await readExploratoryFindingsState(scope.workspaceId);
			const deduped = existingState.findingsById[findingId];
			if (deduped !== undefined) {
				return { ingested: true, rejectionReason: null, finding: deduped };
			}

			// provenance 校验（仅 turn_anchor link；session_level / user_authored_freeform 无锚
			// 可验，原样通过）。校验在串行写队列外做（投影加载是 IO），降级结果随落库写入——
			// 与 map 闸 2c 同语义：checkpoint 不可解析降级 null，绝不整份拒绝。
			const validatedProvenanceLinks: RuntimeExploratoryFindingProvenanceLink[] = [];
			for (const link of input.provenanceLinks) {
				if (link.linkKind !== "turn_anchor") {
					validatedProvenanceLinks.push(link);
					continue;
				}
				let snapshot: Awaited<ReturnType<typeof loadConversationSessionTurnProjection>>;
				try {
					snapshot = await loadConversationSessionTurnProjection(deps, scope, link.conversationSessionTaskId);
				} catch {
					// link 声明的会话投影完全加载不出来（会话不存在）→ 整份拒绝。
					return {
						ingested: false,
						rejectionReason: "provenance_conversation_session_unresolvable",
						finding: null,
					};
				}
				if (snapshot.harnessSource === "unavailable_live_terminal_pty") {
					// 投影源不可用（PTY 会话 / 判不出 harness）：turnNumber 无法核实 → 接受，
					// checkpoint 降级 null（能力矩阵：PTY 锚 best-effort）。
					validatedProvenanceLinks.push({ ...link, turnCheckpointCommit: null });
					continue;
				}
				const latestTurnNumber = snapshot.projection.entries.at(-1)?.turnNumber ?? 0;
				if (link.turnNumber !== null && link.turnNumber > latestTurnNumber) {
					return { ingested: false, rejectionReason: "anchor_turn_number_unresolvable", finding: null };
				}
				const turnCheckpointCommit =
					link.turnCheckpointCommit !== null && !snapshot.retainedCheckpointCommits.has(link.turnCheckpointCommit)
						? null
						: link.turnCheckpointCommit;
				validatedProvenanceLinks.push({ ...link, turnCheckpointCommit });
			}

			const outcome: { finding: RuntimeExploratoryFindingEntry | null; persisted: boolean } = {
				finding: null,
				persisted: false,
			};
			let nextState: WorkspaceExploratoryFindingsState | null;
			try {
				nextState = await mutateExploratoryFindingsState(scope.workspaceId, (state) => {
					const existing = state.findingsById[findingId];
					if (existing !== undefined) {
						// dedup 竞态护栏（快路径读取与落盘之间另一请求已落库）：幂等 ack 现状条目。
						outcome.finding = existing;
						return null;
					}
					const now = Date.now();
					// 落库即 suggested_pending_confirmation + agent_suggested（蓝图 §D.2.2）。
					const finding: RuntimeExploratoryFindingEntry = {
						findingId,
						findingTitle: input.findingTitle,
						findingBodyMarkdown: input.findingBodyMarkdown,
						findingStatus: "suggested_pending_confirmation",
						supersededByFindingId: null,
						findingGenerationSource: "agent_suggested",
						provenanceLinks: validatedProvenanceLinks,
						originConversationSessionTaskId: input.conversationSessionTaskId,
						createdAt: now,
						updatedAt: now,
					};
					outcome.finding = finding;
					outcome.persisted = true;
					return { ...state, findingsById: { ...state.findingsById, [findingId]: finding } };
				});
			} catch (error) {
				if (error instanceof ExploratoryFindingsCapOverflowError) {
					// 容量被 pending 建议占满（pending 永不静默裁 ⇒ cap 无可裁候选）：显式拒绝、
					// 不落盘不广播，agent 侧按 rejectionReason 处置（请用户先确认/拒绝既有建议）。
					return { ingested: false, rejectionReason: "findings_cap_overflow", finding: null };
				}
				throw error;
			}
			const finding = outcome.finding;
			if (finding === null) {
				throw new Error("exploratory findings mutate did not run");
			}
			if (outcome.persisted && nextState !== null) {
				// durable 写已成功 → 广播全量新集合 + ack（durable-write-before-ack）。
				deps.onExploratoryFindingsUpdated(scope.workspaceId, Object.values(nextState.findingsById));
			}
			return { ingested: true, rejectionReason: null, finding };
		},
	};
}
