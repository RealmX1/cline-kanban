// exploratory-api 的 findings 六个 handler（save/confirm/reject/archive/get/ingestFindingCandidate）：
// 状态机、幂等、provenance 校验与广播纪律。旧 session map handler 已随 map 链退役。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConversationSessionTurnProjection } from "../../../src/conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeExploratoryFindingEntry,
	RuntimeIngestExploratoryFindingCandidateRequest,
} from "../../../src/core/api-contract";
import {
	runtimeIngestExploratoryFindingCandidateRequestSchema,
	runtimeSaveExploratoryFindingRequestSchema,
} from "../../../src/core/api-contract";
import {
	ExploratoryFindingsCapOverflowError,
	mutateExploratoryFindingsState,
	readExploratoryFindingEntries,
	readExploratoryFindingsState,
	type WorkspaceExploratoryFindingsState,
} from "../../../src/state/exploratory-findings-store";
import { createExploratoryApi } from "../../../src/trpc/exploratory-api";

vi.mock("../../../src/conversation-tree/load-conversation-session-turn-projection", () => ({
	loadConversationSessionTurnProjection: vi.fn(),
}));

vi.mock("../../../src/state/exploratory-findings-store", async (importOriginal) => {
	// importOriginal 保留真实的 ExploratoryFindingsCapOverflowError——handler 与测试都凭
	// instanceof 识别它，mock 掉三个函数导出的同时不能让 error class 漂移成另一份。
	const actual = await importOriginal<typeof import("../../../src/state/exploratory-findings-store")>();
	return {
		...actual,
		readExploratoryFindingsState: vi.fn(),
		readExploratoryFindingEntries: vi.fn(),
		mutateExploratoryFindingsState: vi.fn(),
	};
});

const loadProjectionMock = vi.mocked(loadConversationSessionTurnProjection);
const readFindingsStateMock = vi.mocked(readExploratoryFindingsState);
const readFindingEntriesMock = vi.mocked(readExploratoryFindingEntries);
const mutateFindingsStateMock = vi.mocked(mutateExploratoryFindingsState);

const SCOPE = { workspaceId: "ws-1", workspacePath: "/repo" };
const TASK_ID = "task-a";
const SIGNATURE = "3:m3:10";

function makeAvailableProjectionSnapshot() {
	return {
		harnessSource: "exact_structured" as const,
		projection: {
			entries: [1, 2, 3].map((turnNumber) => ({
				turnNumber,
				turnStartedAt: 1,
				turnUserMessageExcerpt: `第 ${turnNumber} 轮`,
				turnAssistantResponseExcerpt: null,
				turnMessageCount: 2,
				turnCheckpointCommit: null,
				turnCheckpointAlignmentConfidence: "unaligned" as const,
				turnIsInProgress: false,
				turnHasConversationTreeForkAnchor: false,
			})),
			signature: SIGNATURE,
		},
		retainedCheckpointCommits: new Set<string>(),
	};
}

interface HarnessOptions {
	findings?: Record<string, RuntimeExploratoryFindingEntry>;
}

function makeHarness(options: HarnessOptions) {
	const findingsBroadcasts: Array<{
		workspaceId: string;
		findings: RuntimeExploratoryFindingEntry[];
	}> = [];
	readFindingsStateMock.mockImplementation(async () => ({
		schemaVersion: 1,
		findingsById: options.findings ?? {},
	}));
	readFindingEntriesMock.mockImplementation(async () => Object.values(options.findings ?? {}));
	mutateFindingsStateMock.mockImplementation(async (_workspaceId, mutator, postCapGuard) => {
		const state: WorkspaceExploratoryFindingsState = { schemaVersion: 1, findingsById: options.findings ?? {} };
		const mutated = mutator(state);
		if (mutated === null) {
			return null;
		}
		// 模拟真实 store 契约：postCapGuard 在 cap 后、写盘前执行，抛错 = 整体放弃写入。
		postCapGuard?.(mutated);
		options.findings = mutated.findingsById;
		return mutated;
	});
	const api = createExploratoryApi({
		getScopedClineTaskSessionService: async () => {
			throw new Error("不应被调用：投影加载走 loader mock");
		},
		loadBoardCardAgentId: async () => null,
		onExploratoryFindingsUpdated: (workspaceId, findings) => {
			findingsBroadcasts.push({ workspaceId, findings });
		},
	});
	return { api, findingsBroadcasts };
}

beforeEach(() => {
	vi.clearAllMocks();
	loadProjectionMock.mockResolvedValue(makeAvailableProjectionSnapshot());
});

// ---- findings（M2）----

function makeFindingEntry(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "调查结论",
		findingBodyMarkdown: "正文",
		findingStatus: "active",
		supersededByFindingId: null,
		findingGenerationSource: "user_saved",
		provenanceLinks: [
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: TASK_ID,
				turnNumber: 3,
				turnCheckpointCommit: null,
			},
		],
		originConversationSessionTaskId: TASK_ID,
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

function makeFindingCandidateRequest(
	overrides: Partial<RuntimeIngestExploratoryFindingCandidateRequest> = {},
): RuntimeIngestExploratoryFindingCandidateRequest {
	return {
		conversationSessionTaskId: TASK_ID,
		clientProposalId: "prop-1",
		findingTitle: "建议标题",
		findingBodyMarkdown: "建议正文",
		provenanceLinks: [
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: TASK_ID,
				turnNumber: 3,
				turnCheckpointCommit: null,
			},
		],
		...overrides,
	};
}

describe("findings 写入请求 schema：provenanceLinks 组合约束与条数上限", () => {
	// linkKind ↔ 锚字段组合与条数上限在 schema 层（tRPC input 校验）强制——违例请求
	// 根本到不了 handler，故这里直接对两个写入请求 schema 做 safeParse 断言。
	function makeSaveRequest(provenanceLinks: unknown[]) {
		return {
			findingId: "finding-1",
			findingTitle: "调查结论",
			findingBodyMarkdown: "正文",
			provenanceLinks,
			originConversationSessionTaskId: TASK_ID,
		};
	}
	function makeIngestRequest(provenanceLinks: unknown[]) {
		return {
			conversationSessionTaskId: TASK_ID,
			clientProposalId: "prop-1",
			findingTitle: "建议标题",
			findingBodyMarkdown: "建议正文",
			provenanceLinks,
		};
	}
	const turnAnchorLink = {
		linkKind: "turn_anchor",
		conversationSessionTaskId: TASK_ID,
		turnNumber: 3,
		turnCheckpointCommit: null,
	};

	it("turn_anchor 三元齐全（checkpoint null = 仅时间锚）→ 两个写入通道均接受", () => {
		expect(runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest([turnAnchorLink])).success).toBe(
			true,
		);
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(makeIngestRequest([turnAnchorLink])).success,
		).toBe(true);
	});

	it("turn_anchor 缺 turnNumber（无锚伪 turn_anchor）→ schema 直接拒", () => {
		const link = { ...turnAnchorLink, turnNumber: null };
		expect(runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest([link])).success).toBe(false);
		expect(runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(makeIngestRequest([link])).success).toBe(
			false,
		);
	});

	it("session_level / user_authored_freeform 必须全 null：挂锚字段拒、全 null 收", () => {
		const sessionLevelLink = {
			linkKind: "session_level",
			conversationSessionTaskId: TASK_ID,
			turnNumber: null,
			turnCheckpointCommit: null,
		};
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(makeIngestRequest([sessionLevelLink])).success,
		).toBe(true);
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(
				makeIngestRequest([{ ...sessionLevelLink, turnNumber: 3 }]),
			).success,
		).toBe(false);
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(
				makeIngestRequest([{ ...sessionLevelLink, turnCheckpointCommit: "commit-1" }]),
			).success,
		).toBe(false);
		const freeformLink = { ...sessionLevelLink, linkKind: "user_authored_freeform" };
		expect(runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest([freeformLink])).success).toBe(true);
		expect(
			runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest([{ ...freeformLink, turnNumber: 3 }]))
				.success,
		).toBe(false);
	});

	it("provenanceLinks 超过 8 条 → 两个写入通道 schema 均拒（上限对齐 findingTags）", () => {
		const eightLinks = Array.from({ length: 8 }, () => turnAnchorLink);
		const nineLinks = Array.from({ length: 9 }, () => turnAnchorLink);
		expect(runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest(eightLinks)).success).toBe(true);
		expect(runtimeSaveExploratoryFindingRequestSchema.safeParse(makeSaveRequest(nineLinks)).success).toBe(false);
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(makeIngestRequest(eightLinks)).success,
		).toBe(true);
		expect(
			runtimeIngestExploratoryFindingCandidateRequestSchema.safeParse(makeIngestRequest(nineLinks)).success,
		).toBe(false);
	});
});

describe("exploratory.getFindings", () => {
	it("读路径直传 store（workspace 级全量）", async () => {
		const entry = makeFindingEntry();
		const { api } = makeHarness({ findings: { [entry.findingId]: entry } });
		const response = await api.getFindings(SCOPE, {});
		expect(response.findings).toEqual([entry]);
	});
});

describe("exploratory.saveFinding", () => {
	it("落库即 active + user_saved，durable 落盘后广播全量新集合", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.saveFinding(SCOPE, {
			findingId: "finding-1",
			findingTitle: "调查结论",
			findingBodyMarkdown: "正文",
			provenanceLinks: [
				{
					linkKind: "turn_anchor",
					conversationSessionTaskId: TASK_ID,
					turnNumber: 3,
					turnCheckpointCommit: null,
				},
			],
			originConversationSessionTaskId: TASK_ID,
		});
		expect(response.finding.findingStatus).toBe("active");
		expect(response.finding.findingGenerationSource).toBe("user_saved");
		expect(response.finding.supersededByFindingId).toBeNull();
		expect(findingsBroadcasts).toHaveLength(1);
		expect(findingsBroadcasts[0]?.workspaceId).toBe("ws-1");
		expect(findingsBroadcasts[0]?.findings).toEqual([response.finding]);
	});

	it("同 findingId 已存在 → 幂等回现状条目，不变更不广播", async () => {
		const existing = makeFindingEntry({ findingTitle: "旧标题" });
		const { api, findingsBroadcasts } = makeHarness({ findings: { "finding-1": existing } });
		const response = await api.saveFinding(SCOPE, {
			findingId: "finding-1",
			findingTitle: "新标题",
			findingBodyMarkdown: "新正文",
			provenanceLinks: existing.provenanceLinks,
			originConversationSessionTaskId: TASK_ID,
		});
		expect(response.finding).toBe(existing);
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("cap 裁掉了刚保存的条目（pending 占满）→ PRECONDITION_FAILED 显式失败，不广播", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		// 模拟 store 端 cap-and-trim：pending 占满时唯一可裁候选就是刚写入的非 pending
		// 条目。真实 store 在 cap 后、写盘前执行 postCapGuard——guard 抛错即整体放弃写入
		// （mutate reject），绝不「落盘后才发现目标消失」。handler 把它翻成显式失败。
		mutateFindingsStateMock.mockImplementationOnce(async (_workspaceId, mutator, postCapGuard) => {
			const state: WorkspaceExploratoryFindingsState = { schemaVersion: 1, findingsById: {} };
			const mutated = mutator(state);
			if (mutated === null) {
				return null;
			}
			const capped: WorkspaceExploratoryFindingsState = { ...mutated, findingsById: {} };
			postCapGuard?.(capped);
			return capped;
		});
		await expect(
			api.saveFinding(SCOPE, {
				findingId: "finding-1",
				findingTitle: "调查结论",
				findingBodyMarkdown: "正文",
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: TASK_ID,
						turnNumber: 3,
						turnCheckpointCommit: null,
					},
				],
				originConversationSessionTaskId: TASK_ID,
			}),
		).rejects.toThrow(/could not be persisted/);
		expect(findingsBroadcasts).toHaveLength(0);
	});
});

describe("exploratory.confirmFinding", () => {
	it("pending → active + 广播", async () => {
		const pending = makeFindingEntry({
			findingStatus: "suggested_pending_confirmation",
			findingGenerationSource: "agent_suggested",
		});
		const { api, findingsBroadcasts } = makeHarness({ findings: { "finding-1": pending } });
		const response = await api.confirmFinding(SCOPE, { findingId: "finding-1" });
		expect(response.finding?.findingStatus).toBe("active");
		expect(findingsBroadcasts).toHaveLength(1);
	});

	it("对 active 调 confirm → 状态机违规报错", async () => {
		const { api } = makeHarness({ findings: { "finding-1": makeFindingEntry() } });
		await expect(api.confirmFinding(SCOPE, { findingId: "finding-1" })).rejects.toThrow(/not pending confirmation/);
	});

	it("不存在的 findingId → finding: null（UI 幂等），不报错不广播", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.confirmFinding(SCOPE, { findingId: "finding-gone" });
		expect(response.finding).toBeNull();
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("cap 裁掉了刚确认的条目（存量超限且 pending 占满）→ PRECONDITION_FAILED 显式失败，不广播", async () => {
		const pending = makeFindingEntry({
			findingStatus: "suggested_pending_confirmation",
			findingGenerationSource: "agent_suggested",
		});
		const { api, findingsBroadcasts } = makeHarness({ findings: { "finding-1": pending } });
		// 同 saveFinding 用例的 mock 手法：cap 把刚确认的 active 裁掉后，真实 store 在写盘前
		// 执行 postCapGuard——guard 抛错即整体放弃写入（mutate reject，不落盘）。
		mutateFindingsStateMock.mockImplementationOnce(async (_workspaceId, mutator, postCapGuard) => {
			const state: WorkspaceExploratoryFindingsState = { schemaVersion: 1, findingsById: { "finding-1": pending } };
			const mutated = mutator(state);
			if (mutated === null) {
				return null;
			}
			const capped: WorkspaceExploratoryFindingsState = { ...mutated, findingsById: {} };
			postCapGuard?.(capped);
			return capped;
		});
		await expect(api.confirmFinding(SCOPE, { findingId: "finding-1" })).rejects.toThrow(/could not be persisted/);
		expect(findingsBroadcasts).toHaveLength(0);
	});
});

describe("exploratory.rejectFinding", () => {
	it("pending → 物理删除 + removed:true + 广播空集合", async () => {
		const pending = makeFindingEntry({
			findingStatus: "suggested_pending_confirmation",
			findingGenerationSource: "agent_suggested",
		});
		const harness = makeHarness({ findings: { "finding-1": pending } });
		const response = await harness.api.rejectFinding(SCOPE, { findingId: "finding-1" });
		expect(response.removed).toBe(true);
		expect(harness.findingsBroadcasts).toHaveLength(1);
		expect(harness.findingsBroadcasts[0]?.findings).toEqual([]);
	});

	it("对 active 调 reject → 状态机违规报错（已是资产，只能 archive）", async () => {
		const { api } = makeHarness({ findings: { "finding-1": makeFindingEntry() } });
		await expect(api.rejectFinding(SCOPE, { findingId: "finding-1" })).rejects.toThrow(/not pending confirmation/);
	});

	it("不存在的 findingId → removed: false（UI 幂等），不报错不广播", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.rejectFinding(SCOPE, { findingId: "finding-gone" });
		expect(response.removed).toBe(false);
		expect(findingsBroadcasts).toHaveLength(0);
	});
});

describe("exploratory.archiveFinding", () => {
	it("active → archived + 广播；archived:false 恢复 active", async () => {
		const harness = makeHarness({ findings: { "finding-1": makeFindingEntry() } });
		const archived = await harness.api.archiveFinding(SCOPE, { findingId: "finding-1", archived: true });
		expect(archived.finding?.findingStatus).toBe("archived");
		const restored = await harness.api.archiveFinding(SCOPE, { findingId: "finding-1", archived: false });
		expect(restored.finding?.findingStatus).toBe("active");
		expect(harness.findingsBroadcasts).toHaveLength(2);
	});

	it("已处目标态 → 幂等空转（回现状条目，不变更不广播）", async () => {
		const archived = makeFindingEntry({ findingStatus: "archived" });
		const { api, findingsBroadcasts } = makeHarness({ findings: { "finding-1": archived } });
		const response = await api.archiveFinding(SCOPE, { findingId: "finding-1", archived: true });
		expect(response.finding).toBe(archived);
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("pending 条目不可 archive → 状态机违规报错", async () => {
		const pending = makeFindingEntry({ findingStatus: "suggested_pending_confirmation" });
		const { api } = makeHarness({ findings: { "finding-1": pending } });
		await expect(api.archiveFinding(SCOPE, { findingId: "finding-1", archived: true })).rejects.toThrow(
			/cannot be archived/,
		);
	});

	it("superseded 条目不可 archive → 状态机违规报错（审计链不改写）", async () => {
		const superseded = makeFindingEntry({ findingStatus: "superseded", supersededByFindingId: "finding-2" });
		const { api } = makeHarness({ findings: { "finding-1": superseded } });
		await expect(api.archiveFinding(SCOPE, { findingId: "finding-1", archived: true })).rejects.toThrow(
			/cannot be archived/,
		);
	});

	it("不存在的 findingId → finding: null（UI 幂等），不报错不广播", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.archiveFinding(SCOPE, { findingId: "finding-gone", archived: true });
		expect(response.finding).toBeNull();
		expect(findingsBroadcasts).toHaveLength(0);
	});
});

describe("exploratory.ingestFindingCandidate", () => {
	it("happy path：服务端派生 findingId、落库即 pending + agent_suggested、origin 落位、durable 后广播", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.ingestFindingCandidate(SCOPE, makeFindingCandidateRequest());
		expect(response.ingested).toBe(true);
		expect(response.rejectionReason).toBeNull();
		expect(response.finding?.findingId).toBe("agent-prop-1");
		expect(response.finding?.findingStatus).toBe("suggested_pending_confirmation");
		expect(response.finding?.findingGenerationSource).toBe("agent_suggested");
		expect(response.finding?.originConversationSessionTaskId).toBe(TASK_ID);
		expect(findingsBroadcasts).toHaveLength(1);
		expect(findingsBroadcasts[0]?.findings).toEqual([response.finding]);
	});

	it("dedup：同 clientProposalId 重发（任意状态）→ 幂等 ack 回现状条目，不重写不广播不加载投影", async () => {
		const existing = makeFindingEntry({
			findingId: "agent-prop-1",
			findingStatus: "suggested_pending_confirmation",
			findingGenerationSource: "agent_suggested",
		});
		const { api, findingsBroadcasts } = makeHarness({ findings: { "agent-prop-1": existing } });
		loadProjectionMock.mockClear();
		const response = await api.ingestFindingCandidate(SCOPE, makeFindingCandidateRequest());
		expect(response).toEqual({ ingested: true, rejectionReason: null, finding: existing });
		expect(findingsBroadcasts).toHaveLength(0);
		expect(loadProjectionMock).not.toHaveBeenCalled();
	});

	it("turnNumber > 投影最新 turn → anchor_turn_number_unresolvable（整份拒绝，不落库不广播）", async () => {
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.ingestFindingCandidate(
			SCOPE,
			makeFindingCandidateRequest({
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: TASK_ID,
						turnNumber: 99,
						turnCheckpointCommit: null,
					},
				],
			}),
		);
		expect(response).toEqual({ ingested: false, rejectionReason: "anchor_turn_number_unresolvable", finding: null });
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("checkpoint 不在保留集合 → 降级 null 落库（不拒绝，同 map 闸 2c 语义）", async () => {
		loadProjectionMock.mockResolvedValue({
			...makeAvailableProjectionSnapshot(),
			retainedCheckpointCommits: new Set(["commit-kept"]),
		});
		const { api } = makeHarness({});
		const response = await api.ingestFindingCandidate(
			SCOPE,
			makeFindingCandidateRequest({
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: TASK_ID,
						turnNumber: 3,
						turnCheckpointCommit: "commit-gone",
					},
				],
			}),
		);
		expect(response.ingested).toBe(true);
		expect(response.finding?.provenanceLinks[0]?.turnCheckpointCommit).toBeNull();
	});

	it("投影加载抛错（会话不存在）→ provenance_conversation_session_unresolvable", async () => {
		loadProjectionMock.mockRejectedValue(new Error("task session not found"));
		const { api, findingsBroadcasts } = makeHarness({});
		const response = await api.ingestFindingCandidate(SCOPE, makeFindingCandidateRequest());
		expect(response).toEqual({
			ingested: false,
			rejectionReason: "provenance_conversation_session_unresolvable",
			finding: null,
		});
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("findings 被 pending 占满达上限（store 抛 CapOverflowError）→ findings_cap_overflow，不落库不广播", async () => {
		// pending 永不静默裁 ⇒ 容量被 pending 占满时 cap 无可裁候选，store 显式拒绝；
		// handler 把它翻译为 agent 可程序化处置的结构化拒绝（同既有两种 rejectionReason）。
		const { api, findingsBroadcasts } = makeHarness({});
		mutateFindingsStateMock.mockRejectedValueOnce(
			new ExploratoryFindingsCapOverflowError("cap exceeded: no trimmable entries remain"),
		);
		const response = await api.ingestFindingCandidate(SCOPE, makeFindingCandidateRequest());
		expect(response).toEqual({ ingested: false, rejectionReason: "findings_cap_overflow", finding: null });
		expect(findingsBroadcasts).toHaveLength(0);
	});

	it("投影源不可用（PTY 会话）→ 接受并降级 checkpoint 为 null（能力矩阵 best-effort 锚）", async () => {
		loadProjectionMock.mockResolvedValue({
			harnessSource: "unavailable_live_terminal_pty",
			projection: { entries: [], signature: "0:none:0" },
			retainedCheckpointCommits: new Set<string>(),
		});
		const { api } = makeHarness({});
		const response = await api.ingestFindingCandidate(
			SCOPE,
			makeFindingCandidateRequest({
				provenanceLinks: [
					{
						linkKind: "turn_anchor",
						conversationSessionTaskId: "pty-task",
						// schema 层强制 turn_anchor 必带 turnNumber；PTY 下它无法核实、checkpoint
						// 无法核验 → 接受并降级 checkpoint null（指不出轮次该用 session_level）。
						turnNumber: 3,
						turnCheckpointCommit: "commit-unverifiable",
					},
				],
			}),
		);
		expect(response.ingested).toBe(true);
		expect(response.finding?.provenanceLinks[0]?.turnCheckpointCommit).toBeNull();
	});

	it("非 turn_anchor link（session_level）无锚可验 → 原样通过且不加载投影", async () => {
		const { api } = makeHarness({});
		loadProjectionMock.mockClear();
		const response = await api.ingestFindingCandidate(
			SCOPE,
			makeFindingCandidateRequest({
				provenanceLinks: [
					{
						linkKind: "session_level",
						conversationSessionTaskId: TASK_ID,
						turnNumber: null,
						turnCheckpointCommit: null,
					},
				],
			}),
		);
		expect(response.ingested).toBe(true);
		expect(response.finding?.provenanceLinks[0]?.linkKind).toBe("session_level");
		expect(loadProjectionMock).not.toHaveBeenCalled();
	});
});
