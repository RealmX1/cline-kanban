// Exploratory session map apply 漏斗（蓝图 §B.2）：dedup → 锚点可解析性 → 签名对账 →
// user_manual_edit 冲突拒绝的四道闸，以及落装语义（派生 id / preview 回填 / checkpoint
// 降级 / 幂等重放 / 整份替换）。
import { describe, expect, it } from "vitest";

import type {
	RuntimeExploratorySessionMapCollection,
	RuntimeExploratorySessionMapNode,
	RuntimeIngestExploratorySessionMapUpdateRequest,
} from "../../../src/core/api-contract";
import {
	type ApplyExploratorySessionMapUpdateFunnelInput,
	applyExploratorySessionMapUpdateFunnel,
	deriveExploratorySessionMapNodeId,
	type ExploratorySessionMapApplyFunnelProjectionSnapshot,
} from "../../../src/state/exploratory-session-map-apply-funnel";

const NOW = 1_700_000_000_000;
const TASK_ID = "task-a";
const SIGNATURE = "42:msg-last:1024";

function makeProjection(
	overrides: Partial<ExploratorySessionMapApplyFunnelProjectionSnapshot> = {},
): ExploratorySessionMapApplyFunnelProjectionSnapshot {
	return {
		harnessSource: "exact_structured",
		turnProjectionSignature: SIGNATURE,
		latestTurnNumber: 5,
		turnUserMessagePreviewByTurnNumber: new Map([[3, "第三轮用户问题原文"]]),
		retainedCheckpointCommits: new Set(["commit-a", "commit-b"]),
		...overrides,
	};
}

function makeNodeProposal(
	overrides: Partial<RuntimeIngestExploratorySessionMapUpdateRequest["nodes"][number]> = {},
): RuntimeIngestExploratorySessionMapUpdateRequest["nodes"][number] {
	return {
		anchorTurnNumber: 3,
		anchorTurnCheckpointCommit: null,
		nodeKind: "milestone",
		nodeTitle: "里程碑标题",
		nodeSummaryMarkdown: null,
		referencedFindingId: null,
		...overrides,
	};
}

function makeRequest(
	overrides: Partial<RuntimeIngestExploratorySessionMapUpdateRequest> = {},
): RuntimeIngestExploratorySessionMapUpdateRequest {
	return {
		conversationSessionTaskId: TASK_ID,
		clientProposalId: "proposal-1",
		sourceTurnProjectionSignature: SIGNATURE,
		nodes: [makeNodeProposal()],
		...overrides,
	};
}

function makeStoredNode(overrides: Partial<RuntimeExploratorySessionMapNode> = {}): RuntimeExploratorySessionMapNode {
	return {
		mapNodeId: "turn-3-milestone",
		anchorConversationSessionTaskId: TASK_ID,
		anchorTurnNumber: 3,
		anchorTurnCheckpointCommit: null,
		anchorTurnUserMessagePreview: "第三轮用户问题原文",
		nodeKind: "milestone",
		nodeTitle: "里程碑标题",
		nodeSummaryMarkdown: null,
		referencedFindingId: null,
		nodeGenerationSource: "agent_live_session_maintenance",
		createdAt: NOW - 60_000,
		updatedAt: NOW - 60_000,
		...overrides,
	};
}

function makeCollection(
	overrides: Partial<RuntimeExploratorySessionMapCollection> = {},
): RuntimeExploratorySessionMapCollection {
	return {
		sourceTurnProjectionSignature: SIGNATURE,
		mapNodes: [],
		mapStaleReason: null,
		lastMaintenanceJobCompletedAt: null,
		updatedAt: NOW - 60_000,
		...overrides,
	};
}

function runFunnel(
	overrides: Partial<ApplyExploratorySessionMapUpdateFunnelInput> = {},
): ReturnType<typeof applyExploratorySessionMapUpdateFunnel> {
	return applyExploratorySessionMapUpdateFunnel({
		currentCollection: null,
		request: makeRequest(),
		projection: makeProjection(),
		existingFindingIds: new Set<string>(),
		nodeGenerationSource: "agent_live_session_maintenance",
		now: NOW,
		...overrides,
	});
}

describe("deriveExploratorySessionMapNodeId", () => {
	it("按 turn-<N>-<kind> 派生（marker id 约定同源）", () => {
		expect(deriveExploratorySessionMapNodeId(3, "milestone")).toBe("turn-3-milestone");
		expect(deriveExploratorySessionMapNodeId(12, "open_question")).toBe("turn-12-open_question");
	});
});

describe("闸 0：dedup", () => {
	it("同 clientProposalId 已应用过 → 幂等 ack，不重写", () => {
		const current = makeCollection({ recentAppliedClientProposalIds: ["proposal-1"], mapNodes: [makeStoredNode()] });
		const result = runFunnel({ currentCollection: current });
		expect(result.outcome).toBe("dedup_ack");
		if (result.outcome === "dedup_ack") {
			expect(result.mapCollection).toBe(current);
		}
	});
});

describe("闸 2：锚点可解析性", () => {
	it("投影源不可用 → projection_source_unavailable", () => {
		const result = runFunnel({
			projection: makeProjection({
				harnessSource: "unavailable_live_terminal_pty",
				turnProjectionSignature: "0:none:0",
				latestTurnNumber: 0,
			}),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "projection_source_unavailable" });
	});

	it("anchorTurnNumber > 投影最新 turn → anchor_turn_number_unresolvable（整份拒绝）", () => {
		const result = runFunnel({
			request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnNumber: 6 })] }),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "anchor_turn_number_unresolvable" });
	});

	it("anchorTurnCheckpointCommit 不在保留集合 → 降级 null + 标集合级 stale（不拒绝）", () => {
		const result = runFunnel({
			request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnCheckpointCommit: "commit-gone" })] }),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes[0]?.anchorTurnCheckpointCommit).toBeNull();
			expect(result.mapCollection.mapStaleReason).toBe("anchor_turn_checkpoint_commit_unresolvable");
		}
	});

	it("anchorTurnCheckpointCommit 在保留集合 → 保留且不标 stale", () => {
		const result = runFunnel({
			request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnCheckpointCommit: "commit-a" })] }),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes[0]?.anchorTurnCheckpointCommit).toBe("commit-a");
			expect(result.mapCollection.mapStaleReason).toBeNull();
		}
	});
});

describe("闸 2.5：referencedFindingId 可解析性（M2）", () => {
	it("引用的 finding 已存在 → applied（任意状态都算可解析）", () => {
		const result = runFunnel({
			existingFindingIds: new Set(["finding-1"]),
			request: makeRequest({
				nodes: [makeNodeProposal({ nodeKind: "finding_reference", referencedFindingId: "finding-1" })],
			}),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes[0]?.referencedFindingId).toBe("finding-1");
		}
	});

	it("引用的 finding 不存在 → referenced_finding_unresolvable（整份拒绝）", () => {
		const result = runFunnel({
			existingFindingIds: new Set(["finding-other"]),
			request: makeRequest({
				nodes: [makeNodeProposal({ nodeKind: "finding_reference", referencedFindingId: "finding-gone" })],
			}),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "referenced_finding_unresolvable" });
	});

	it("referencedFindingId 为 null → 不校验（非 finding_reference 节点照常过闸）", () => {
		const result = runFunnel({ existingFindingIds: new Set<string>() });
		expect(result.outcome).toBe("applied");
	});

	it("闸序：锚点不可解析与 finding 不可解析同时在场 → 先报锚点（闸 2b 先于闸 2.5）", () => {
		const result = runFunnel({
			existingFindingIds: new Set<string>(),
			request: makeRequest({
				nodes: [
					makeNodeProposal({ anchorTurnNumber: 6, nodeKind: "finding_reference", referencedFindingId: "f-gone" }),
				],
			}),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "anchor_turn_number_unresolvable" });
	});
});

describe("闸 3：签名对账", () => {
	it("签名不一致 → stale_source_turn_projection_signature（整份丢弃）", () => {
		const result = runFunnel({ request: makeRequest({ sourceTurnProjectionSignature: "43:other:1" }) });
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "stale_source_turn_projection_signature" });
	});
});

describe("闸 4：user_manual_edit 冲突拒绝", () => {
	const userNode = makeStoredNode({ nodeGenerationSource: "user_manual_edit" });

	it("提案缺漏用户修正节点 → user_manual_edit_conflict", () => {
		const result = runFunnel({
			currentCollection: makeCollection({ mapNodes: [userNode] }),
			request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnNumber: 4, nodeKind: "open_question" })] }),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "user_manual_edit_conflict" });
	});

	it("提案改写用户修正节点 → user_manual_edit_conflict", () => {
		const result = runFunnel({
			currentCollection: makeCollection({ mapNodes: [userNode] }),
			request: makeRequest({ nodes: [makeNodeProposal({ nodeTitle: "被 agent 改过的标题" })] }),
		});
		expect(result).toEqual({ outcome: "rejected", rejectionReason: "user_manual_edit_conflict" });
	});

	it("提案原样带回用户修正节点 → applied，来源/时间戳全部保留", () => {
		const result = runFunnel({
			currentCollection: makeCollection({ mapNodes: [userNode] }),
			request: makeRequest({
				nodes: [
					makeNodeProposal(),
					makeNodeProposal({ anchorTurnNumber: 4, nodeKind: "digression", nodeTitle: "岔路" }),
				],
			}),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			const carried = result.mapCollection.mapNodes.find((node) => node.mapNodeId === "turn-3-milestone");
			expect(carried?.nodeGenerationSource).toBe("user_manual_edit");
			expect(carried?.createdAt).toBe(NOW - 60_000);
			expect(carried?.updatedAt).toBe(NOW - 60_000);
			// 新增的 agent 节点照常落装。
			const added = result.mapCollection.mapNodes.find((node) => node.mapNodeId === "turn-4-digression");
			expect(added?.nodeGenerationSource).toBe("agent_live_session_maintenance");
			expect(added?.createdAt).toBe(NOW);
		}
	});

	describe("user 节点的 checkpoint commit 被滚动修剪", () => {
		const prunedUserNode = makeStoredNode({
			nodeGenerationSource: "user_manual_edit",
			anchorTurnCheckpointCommit: "commit-pruned",
		});

		it("降级 null 落装但保留 user 来源章与 createdAt（绝不被改章成 agent 来源）", () => {
			const result = runFunnel({
				currentCollection: makeCollection({ mapNodes: [prunedUserNode] }),
				// 闸 4 要求原样带回（含落盘时的 commit），提案如实复述后由闸 2c 降级。
				request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnCheckpointCommit: "commit-pruned" })] }),
			});
			expect(result.outcome).toBe("applied");
			if (result.outcome === "applied") {
				const carried = result.mapCollection.mapNodes.find((node) => node.mapNodeId === "turn-3-milestone");
				expect(carried?.anchorTurnCheckpointCommit).toBeNull();
				expect(carried?.nodeGenerationSource).toBe("user_manual_edit");
				expect(carried?.createdAt).toBe(NOW - 60_000);
				// commit 字段确实变化，updatedAt 如实推进。
				expect(carried?.updatedAt).toBe(NOW);
				expect(result.mapCollection.mapStaleReason).toBe("anchor_turn_checkpoint_commit_unresolvable");
			}
		});

		it("降级重建后闸 4 保护仍生效：改写该节点的提案被拒绝", () => {
			const downgraded = runFunnel({
				currentCollection: makeCollection({ mapNodes: [prunedUserNode] }),
				request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnCheckpointCommit: "commit-pruned" })] }),
			});
			expect(downgraded.outcome).toBe("applied");
			if (downgraded.outcome !== "applied") {
				return;
			}
			const result = runFunnel({
				currentCollection: downgraded.mapCollection,
				request: makeRequest({
					clientProposalId: "proposal-2",
					// commit 已降级为 null，提案如实复述 null 但篡改标题 → 冲突拒绝。
					nodes: [makeNodeProposal({ nodeTitle: "被 agent 改过的标题" })],
				}),
			});
			expect(result).toEqual({ outcome: "rejected", rejectionReason: "user_manual_edit_conflict" });
		});

		it("降级后下一轮原样带回 → 幂等重放（updatedAt 不 churn，漏斗不会卡死）", () => {
			const downgraded = runFunnel({
				currentCollection: makeCollection({ mapNodes: [prunedUserNode] }),
				request: makeRequest({ nodes: [makeNodeProposal({ anchorTurnCheckpointCommit: "commit-pruned" })] }),
			});
			expect(downgraded.outcome).toBe("applied");
			if (downgraded.outcome !== "applied") {
				return;
			}
			const result = runFunnel({
				currentCollection: downgraded.mapCollection,
				request: makeRequest({ clientProposalId: "proposal-2" }),
				now: NOW + 60_000,
			});
			expect(result.outcome).toBe("applied");
			if (result.outcome === "applied") {
				const carried = result.mapCollection.mapNodes.find((node) => node.mapNodeId === "turn-3-milestone");
				expect(carried?.nodeGenerationSource).toBe("user_manual_edit");
				// 时间前进也不刷新 updatedAt —— 语义字段全等走幂等重放。
				expect(carried?.updatedAt).toBe(NOW);
				expect(result.mapCollection.mapStaleReason).toBeNull();
			}
		});
	});
});

describe("落装语义", () => {
	it("happy path：派生 id、preview 回填（不信 agent 自报）、签名/账本会话键落位", () => {
		const result = runFunnel();
		expect(result.outcome).toBe("applied");
		if (result.outcome !== "applied") {
			return;
		}
		const collection = result.mapCollection;
		expect(collection.sourceTurnProjectionSignature).toBe(SIGNATURE);
		expect(collection.recentAppliedClientProposalIds).toEqual(["proposal-1"]);
		expect(collection.updatedAt).toBe(NOW);
		expect(collection.mapNodes).toHaveLength(1);
		const node = collection.mapNodes[0];
		expect(node.mapNodeId).toBe("turn-3-milestone");
		expect(node.anchorConversationSessionTaskId).toBe(TASK_ID);
		// preview 由漏斗从投影层回填（提案里根本没有这个字段）。
		expect(node.anchorTurnUserMessagePreview).toBe("第三轮用户问题原文");
		expect(node.createdAt).toBe(NOW);
		expect(node.updatedAt).toBe(NOW);
	});

	it("preview 超过 200 字符 → 截断到 200", () => {
		const longPreview = "长".repeat(300);
		const result = runFunnel({
			projection: makeProjection({ turnUserMessagePreviewByTurnNumber: new Map([[3, longPreview]]) }),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes[0]?.anchorTurnUserMessagePreview).toHaveLength(200);
		}
	});

	it("同锚点同 kind 重复提交 → 幂等归并（后写为准）", () => {
		const result = runFunnel({
			request: makeRequest({
				nodes: [makeNodeProposal({ nodeTitle: "第一版" }), makeNodeProposal({ nodeTitle: "第二版" })],
			}),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes).toHaveLength(1);
			expect(result.mapCollection.mapNodes[0]?.nodeTitle).toBe("第二版");
		}
	});

	it("整份替换：现存 agent 节点未出现在新提案 → 被移除", () => {
		const current = makeCollection({
			mapNodes: [
				makeStoredNode(),
				makeStoredNode({
					mapNodeId: "turn-4-digression",
					anchorTurnNumber: 4,
					nodeKind: "digression",
					nodeTitle: "旧岔路",
				}),
			],
		});
		const result = runFunnel({ currentCollection: current });
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes.map((node) => node.mapNodeId)).toEqual(["turn-3-milestone"]);
		}
	});

	it("幂等重放：语义字段全等 ⇒ 保留 createdAt/updatedAt（不 churn 广播时间戳）", () => {
		const current = makeCollection({ mapNodes: [makeStoredNode()] });
		const result = runFunnel({
			currentCollection: current,
			request: makeRequest({ clientProposalId: "proposal-2" }),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes[0]?.createdAt).toBe(NOW - 60_000);
			expect(result.mapCollection.mapNodes[0]?.updatedAt).toBe(NOW - 60_000);
			expect(result.mapCollection.recentAppliedClientProposalIds).toEqual(["proposal-2"]);
		}
	});

	it("节点按 anchorTurnNumber 升序落盘（显示序派生自锚点，map 不存边）", () => {
		const result = runFunnel({
			request: makeRequest({
				nodes: [
					makeNodeProposal({ anchorTurnNumber: 5, nodeKind: "open_question", nodeTitle: "问题" }),
					makeNodeProposal({ anchorTurnNumber: 2, nodeKind: "decision_point", nodeTitle: "取舍" }),
				],
			}),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.mapNodes.map((node) => node.anchorTurnNumber)).toEqual([2, 5]);
		}
	});

	it("dedup 账本 FIFO：超过 50 条丢最老", () => {
		const ledger = Array.from({ length: 50 }, (_, index) => `old-${index}`);
		const result = runFunnel({
			currentCollection: makeCollection({ recentAppliedClientProposalIds: ledger }),
		});
		expect(result.outcome).toBe("applied");
		if (result.outcome === "applied") {
			expect(result.mapCollection.recentAppliedClientProposalIds).toHaveLength(50);
			expect(result.mapCollection.recentAppliedClientProposalIds?.[0]).toBe("old-1");
			expect(result.mapCollection.recentAppliedClientProposalIds?.at(-1)).toBe("proposal-1");
		}
	});
});
