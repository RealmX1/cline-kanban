// Exploratory session map 写回的 apply 漏斗（蓝图 §B.2）：agent 提案进 store 前的**唯一**
// 校验与落装点。纯函数——tRPC mutation 先把投影快照取好，再在 store 串行写队列的 mutator
// 里调本函数，保证「读现状 → 校验 → 落装」与写盘原子于同一把队列锁内。
//
// 闸序（蓝图 §B.2，任一失败整体丢弃）：
//   0. dedup：同 clientProposalId 已应用过 → 幂等 ack（重试不落地两条）；
//   1. zod 白名单：在 tRPC input schema 完成（含尺寸上限、finding_reference 配套校验），不在本模块；
//   2. 锚点可解析性：投影源可用 + anchorTurnNumber ≤ 投影最新 turn；checkpoint commit 不在保留
//      ref 集合内 → 降级 null + 标集合级 mapStaleReason（不拒绝）；
//   3. sourceTurnProjectionSignature 对账：与 apply 时刻投影签名一致；
//   4. user_manual_edit 冲突拒绝：用户修正优先级恒最高（冲突集合 = 同 mapNodeId）。
//
// 赋名纪律：mapNodeId 恒由本漏斗派生（deriveExploratorySessionMapNodeId），agent 不可自报——
// 这也是聊天里 map-anchor marker 必须使用的 id 约定（指令文件据此成文）。

import type {
	RuntimeConversationTurnProjectionHarnessSource,
	RuntimeExploratorySessionMapCollection,
	RuntimeExploratorySessionMapIngestRejectionReason,
	RuntimeExploratorySessionMapNode,
	RuntimeExploratorySessionMapNodeKind,
	RuntimeIngestExploratorySessionMapUpdateRequest,
} from "../core/api-contract";

// dedup 账本保留的最近 clientProposalId 条数（FIFO 淘汰）。schema 上限 100，留一半余量。
const MAX_RECENT_APPLIED_CLIENT_PROPOSAL_IDS = 50;

const ANCHOR_USER_MESSAGE_PREVIEW_MAX_LENGTH = 200;

// 稳定节点 id 的派生约定：`turn-<anchorTurnNumber>-<nodeKind>`。集合本身已按会话隔离
// （mapCollectionsByConversationSessionTaskId 的键），id 无需再带会话前缀；同锚点同 kind
// 幂等归并是蓝图 §B.1 的既定语义。agent 在聊天里埋 map-anchor marker 时必须使用同一个 id。
export function deriveExploratorySessionMapNodeId(
	anchorTurnNumber: number,
	nodeKind: RuntimeExploratorySessionMapNodeKind,
): string {
	return `turn-${anchorTurnNumber}-${nodeKind}`;
}

// 漏斗消费的 apply 时刻投影快照（由 loadConversationSessionTurnProjection 规整）。
export interface ExploratorySessionMapApplyFunnelProjectionSnapshot {
	harnessSource: RuntimeConversationTurnProjectionHarnessSource;
	turnProjectionSignature: string;
	// 投影最新 turn 号（= entries 条数，turn 编号 1..N 连续）；空投影为 0。
	latestTurnNumber: number;
	// turn → 用户消息预览（漏斗回填用，不信 agent 自报）。
	turnUserMessagePreviewByTurnNumber: ReadonlyMap<number, string>;
	// 该任务保留的 checkpoint commit 集合（listTaskTurnCheckpointRefs）。
	retainedCheckpointCommits: ReadonlySet<string>;
}

export interface ApplyExploratorySessionMapUpdateFunnelInput {
	currentCollection: RuntimeExploratorySessionMapCollection | null;
	request: RuntimeIngestExploratorySessionMapUpdateRequest;
	projection: ExploratorySessionMapApplyFunnelProjectionSnapshot;
	// 本次写入的生产者（蓝图 §B.2 两类生产者共用同一漏斗）：live agent 经 CLI 实时维护 /
	// 防抖再维护作业。绝不接受 user_manual_edit——用户修正只能来自 UI 编辑通道（M3）。
	nodeGenerationSource: "agent_live_session_maintenance" | "agent_maintenance_job";
	now: number;
}

export type ExploratorySessionMapApplyFunnelResult =
	| { outcome: "applied"; mapCollection: RuntimeExploratorySessionMapCollection }
	// 同 clientProposalId 重试：幂等 ack，携带未变更的现状集合（不落盘、不广播）。
	| { outcome: "dedup_ack"; mapCollection: RuntimeExploratorySessionMapCollection }
	| { outcome: "rejected"; rejectionReason: RuntimeExploratorySessionMapIngestRejectionReason };

export function applyExploratorySessionMapUpdateFunnel(
	input: ApplyExploratorySessionMapUpdateFunnelInput,
): ExploratorySessionMapApplyFunnelResult {
	const { currentCollection, request, projection, nodeGenerationSource, now } = input;

	// 闸 0：dedup。重试的提案即便投影已前进也要幂等 ack——它早已应用成功。
	if (currentCollection?.recentAppliedClientProposalIds?.includes(request.clientProposalId)) {
		return { outcome: "dedup_ack", mapCollection: currentCollection };
	}

	// 闸 2a：投影源可用性（锚点可解析性的前提）。M1 只有 exact_structured 可解析；
	// unavailable_live_terminal_pty（PTY/ACP 会话或判定不出 harness）无从对锚，整份拒绝。
	if (projection.harnessSource === "unavailable_live_terminal_pty") {
		return { outcome: "rejected", rejectionReason: "projection_source_unavailable" };
	}
	// 闸 2b：anchorTurnNumber 可解析性（蓝图 §B.1：> 投影最新 turn 即整份拒绝）。
	for (const node of request.nodes) {
		if (node.anchorTurnNumber > projection.latestTurnNumber) {
			return { outcome: "rejected", rejectionReason: "anchor_turn_number_unresolvable" };
		}
	}

	// 闸 3：签名对账（提案基于的投影 ≠ apply 时刻投影 = 作业期间来了新 turn，整体丢弃）。
	if (request.sourceTurnProjectionSignature !== projection.turnProjectionSignature) {
		return { outcome: "rejected", rejectionReason: "stale_source_turn_projection_signature" };
	}

	// 闸 4：user_manual_edit 冲突拒绝。提案是整份目标态，故现存的每个用户修正节点都必须
	// 在提案中原样出现（同派生 id 且语义字段全等）；缺漏或改写即冲突。
	const userEditNodes = (currentCollection?.mapNodes ?? []).filter(
		(node) => node.nodeGenerationSource === "user_manual_edit",
	);
	if (userEditNodes.length > 0) {
		const proposalNodesByDerivedId = new Map(
			request.nodes.map((node) => [deriveExploratorySessionMapNodeId(node.anchorTurnNumber, node.nodeKind), node]),
		);
		for (const userNode of userEditNodes) {
			const proposal = proposalNodesByDerivedId.get(userNode.mapNodeId);
			if (
				proposal === undefined ||
				proposal.anchorTurnNumber !== userNode.anchorTurnNumber ||
				proposal.anchorTurnCheckpointCommit !== userNode.anchorTurnCheckpointCommit ||
				proposal.nodeTitle !== userNode.nodeTitle ||
				proposal.nodeSummaryMarkdown !== userNode.nodeSummaryMarkdown ||
				proposal.referencedFindingId !== userNode.referencedFindingId
			) {
				return { outcome: "rejected", rejectionReason: "user_manual_edit_conflict" };
			}
		}
	}

	// 落装。checkpoint commit 校验（闸 2c）：不在保留 ref 集合内 → 降级 null + 集合级标 stale。
	let anyCheckpointCommitDowngraded = false;
	const existingNodesById = new Map((currentCollection?.mapNodes ?? []).map((node) => [node.mapNodeId, node]));
	// 载荷内同派生 id 重复出现 → 幂等归并（后写为准：它是 agent 对同一锚点的最新陈述）。
	const mergedProposalsByDerivedId = new Map<
		string,
		RuntimeIngestExploratorySessionMapUpdateRequest["nodes"][number]
	>();
	for (const node of request.nodes) {
		mergedProposalsByDerivedId.set(deriveExploratorySessionMapNodeId(node.anchorTurnNumber, node.nodeKind), node);
	}
	const nextNodes: RuntimeExploratorySessionMapNode[] = [];
	for (const [mapNodeId, proposal] of mergedProposalsByDerivedId) {
		let anchorTurnCheckpointCommit = proposal.anchorTurnCheckpointCommit;
		if (
			anchorTurnCheckpointCommit !== null &&
			!projection.retainedCheckpointCommits.has(anchorTurnCheckpointCommit)
		) {
			anchorTurnCheckpointCommit = null;
			anyCheckpointCommitDowngraded = true;
		}
		const preview = projection.turnUserMessagePreviewByTurnNumber.get(proposal.anchorTurnNumber) ?? null;
		const anchorTurnUserMessagePreview =
			preview !== null && preview.length > ANCHOR_USER_MESSAGE_PREVIEW_MAX_LENGTH
				? preview.slice(0, ANCHOR_USER_MESSAGE_PREVIEW_MAX_LENGTH)
				: preview;
		const existing = existingNodesById.get(mapNodeId);
		const semanticFieldsUnchanged =
			existing !== undefined &&
			existing.anchorTurnNumber === proposal.anchorTurnNumber &&
			existing.anchorTurnCheckpointCommit === anchorTurnCheckpointCommit &&
			existing.anchorTurnUserMessagePreview === anchorTurnUserMessagePreview &&
			existing.nodeKind === proposal.nodeKind &&
			existing.nodeTitle === proposal.nodeTitle &&
			existing.nodeSummaryMarkdown === proposal.nodeSummaryMarkdown &&
			existing.referencedFindingId === proposal.referencedFindingId;
		if (existing !== undefined && semanticFieldsUnchanged) {
			// 幂等重放：语义字段全等 ⇒ 保留原 createdAt/updatedAt/nodeGenerationSource
			// （含 user_manual_edit 节点——闸 4 已保证内容全等，绝不被改章成 agent 来源）。
			nextNodes.push({
				...existing,
				anchorConversationSessionTaskId: request.conversationSessionTaskId,
			});
			continue;
		}
		// 重建分支同样绝不允许把 user_manual_edit 节点改章成 agent 来源：目前唯一可能走到
		// 这里的路径是其落盘 commit 被 200 上限滚动修剪后在闸 2c 降级为 null（语义字段被判
		// 变化）。选择「降级后保留 user 章重建」而非「闸 4 拒绝」——commit 降级是系统侧的
		// 解析状态归一化而非 agent 改写用户语义内容，且被修剪的 commit 永远不会回到保留
		// 集合，拒绝会让该会话的 map 维护永久卡死在 user_manual_edit_conflict。章一丢，
		// 闸 4 保护随之失效（闸 4 只认 user_manual_edit），故这里必须连 createdAt 一起保。
		const preserveUserEditStamp = existing?.nodeGenerationSource === "user_manual_edit";
		nextNodes.push({
			mapNodeId,
			anchorConversationSessionTaskId: request.conversationSessionTaskId,
			anchorTurnNumber: proposal.anchorTurnNumber,
			anchorTurnCheckpointCommit,
			anchorTurnUserMessagePreview,
			nodeKind: proposal.nodeKind,
			nodeTitle: proposal.nodeTitle,
			nodeSummaryMarkdown: proposal.nodeSummaryMarkdown,
			referencedFindingId: proposal.referencedFindingId,
			nodeGenerationSource: preserveUserEditStamp ? existing.nodeGenerationSource : nodeGenerationSource,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		});
	}
	// 显示序由 anchorTurnNumber 派生（map 不存边）；存盘保持有序让文件可读、diff 稳定。
	nextNodes.sort(
		(left, right) => left.anchorTurnNumber - right.anchorTurnNumber || left.mapNodeId.localeCompare(right.mapNodeId),
	);

	const recentAppliedClientProposalIds = [
		...(currentCollection?.recentAppliedClientProposalIds ?? []).filter((id) => id !== request.clientProposalId),
		request.clientProposalId,
	].slice(-MAX_RECENT_APPLIED_CLIENT_PROPOSAL_IDS);

	return {
		outcome: "applied",
		mapCollection: {
			sourceTurnProjectionSignature: projection.turnProjectionSignature,
			mapNodes: nextNodes,
			// 刚按最新签名落装的集合与投影同步：唯一可能残留的是 commit 降级标记。
			mapStaleReason: anyCheckpointCommitDowngraded ? "anchor_turn_checkpoint_commit_unresolvable" : null,
			lastMaintenanceJobCompletedAt: currentCollection?.lastMaintenanceJobCompletedAt ?? null,
			recentAppliedClientProposalIds,
			updatedAt: now,
		},
	};
}
