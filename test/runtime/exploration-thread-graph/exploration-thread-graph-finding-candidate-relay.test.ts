import type {
	CompletedTurnSequenceSnapshot,
	ExplorationThreadGraphCollection,
	TurnEventMark,
} from "agent-conversation-exploration-thread-graph/core";
import { createEmptyExplorationThreadGraphCollection } from "agent-conversation-exploration-thread-graph/core";
import { describe, expect, it } from "vitest";
import {
	buildExplorationThreadGraphFindingCandidateProposalId,
	collectExplorationThreadGraphFindingCandidateRequests,
} from "../../../src/exploration-thread-graph/exploration-thread-graph-finding-candidate-relay";

// 这一跳的两个命门：① dedup 键必须确定性派生（否则每次作业都往待确认列表刷同一条结论）；
// ② provenance 用的是**宿主 taskId**，不是核心包的原生 session id（伪造会落出永远解析不了的链接）。

function makeEventMark(overrides: Partial<TurnEventMark> = {}): TurnEventMark {
	return {
		turnRef: { conversationSessionId: "native-session-1", turnNumber: 3, turnCheckpointCommit: null },
		mark: "finding_candidate",
		note: "缓存未命中的成因是 session id 进了 system prompt",
		externalReferenceId: null,
		generationSource: "work_branch_maintenance_job",
		createdAt: 1_000,
		...overrides,
	};
}

function makeCollection(turnEventMarks: TurnEventMark[]): ExplorationThreadGraphCollection {
	return { ...createEmptyExplorationThreadGraphCollection("exploration-1", 1_000), turnEventMarks };
}

function makeSnapshots(): Map<string, CompletedTurnSequenceSnapshot> {
	return new Map([
		[
			"native-session-1",
			{
				conversationSessionId: "native-session-1",
				sourceKind: "claude_code_transcript" as const,
				turns: [
					{
						turnNumber: 3,
						userPromptExcerpt: "为什么 fork 拿不到 cache？",
						assistantResponseExcerpt: "因为 session id 被嵌进了 scratchpad 路径。",
						startedAt: "2026-09-10T00:00:00.000Z",
						endedAt: "2026-09-10T00:01:00.000Z",
						userMessageOrigin: "human_typed" as const,
						toolCallCount: 2,
					},
				],
				sourceSignature: "signature-1",
				projectionConfidence: "transcript_reconstructed" as const,
				inProgressTurnNumber: null,
			},
		],
	]);
}

const HOST_TASK_ID_BY_NATIVE_SESSION_ID = { "native-session-1": "exploration-1" };

describe("collectExplorationThreadGraphFindingCandidateRequests", () => {
	it("把作业标注翻译成建议通道请求，provenance 用宿主 taskId 而不是原生 session id", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark()]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.conversationSessionTaskId).toBe("exploration-1");
		expect(request?.provenanceLinks).toEqual([
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: "exploration-1",
				turnNumber: 3,
				turnCheckpointCommit: null,
			},
		]);
		// 标题取标注自带的判断；正文并排放上下文摘录，让人确认时看得到凭据。
		expect(request?.findingTitle).toBe("缓存未命中的成因是 session id 进了 system prompt");
		expect(request?.findingBodyMarkdown).toContain("为什么 fork 拿不到 cache？");
		expect(request?.findingBodyMarkdown).toContain("因为 session id 被嵌进了 scratchpad 路径。");
	});

	it("dedup 键确定性派生——同一条标注反复扫到恒得同一个 id", () => {
		const first = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark()]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});
		const second = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			// 第二次作业跑完，图里多了别的东西，但这条标注还在。
			collection: makeCollection([
				makeEventMark(),
				makeEventMark({
					turnRef: { conversationSessionId: "native-session-1", turnNumber: 5, turnCheckpointCommit: null },
				}),
			]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(second[0]?.clientProposalId).toBe(first[0]?.clientProposalId);
		expect(first[0]?.clientProposalId).toBe(
			buildExplorationThreadGraphFindingCandidateProposalId({
				explorationId: "exploration-1",
				conversationSessionId: "native-session-1",
				turnNumber: 3,
			}),
		);
		// 新标注有自己的 id，不与旧的相撞。
		expect(second[1]?.clientProposalId).not.toBe(second[0]?.clientProposalId);
	});

	it("只转投 finding_candidate，其余事件标注一概不碰", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([
				makeEventMark({ mark: "milestone" }),
				makeEventMark({ mark: "decision_point" }),
				makeEventMark({ mark: "open_question" }),
			]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests).toEqual([]);
	});

	it("用户手工加的标注不转投——那已经是用户自己的动作，再生成待确认建议是循环", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark({ generationSource: "user_manual_edit" })]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests).toEqual([]);
	});

	it("会话不在桥接表里时跳过，绝不用原生 id 冒充 taskId", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark()]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: {},
		});

		expect(requests).toEqual([]);
	});

	it("标注没有 note 时回落到该轮提问摘录，绝不落出空标题", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark({ note: null })]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests[0]?.findingTitle).toBe("为什么 fork 拿不到 cache？");
		expect(requests[0]?.findingBodyMarkdown.length).toBeGreaterThan(0);
	});

	it("既没有 note 也读不到该轮快照时仍给出非空标题与正文（ingest 的 min(1) 约束）", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark({ note: null })]),
			turnSnapshotsBySession: new Map(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests[0]?.findingTitle).toBe("探索线标注的候选结论（第 3 轮）");
		expect(requests[0]?.findingBodyMarkdown).toBe("探索线标注的候选结论（第 3 轮）");
	});

	it("超长 note 被截断到契约上限内", () => {
		const requests = collectExplorationThreadGraphFindingCandidateRequests({
			explorationId: "exploration-1",
			collection: makeCollection([makeEventMark({ note: "长".repeat(500) })]),
			turnSnapshotsBySession: makeSnapshots(),
			hostTaskIdByNativeSessionId: HOST_TASK_ID_BY_NATIVE_SESSION_ID,
		});

		expect(requests[0]?.findingTitle.length).toBeLessThanOrEqual(120);
		expect(requests[0]?.findingBodyMarkdown.length).toBeLessThanOrEqual(4000);
	});
});
