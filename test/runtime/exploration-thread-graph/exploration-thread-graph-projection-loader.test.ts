import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
} from "agent-conversation-exploration-thread-graph/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideExplorationThreadGraphMaintenanceThrottle } from "../../../src/exploration-thread-graph/exploration-thread-graph-maintenance-throttle";
import {
	COMPLETED_TURN_SEQUENCE_UNAVAILABLE_SNAPSHOT_SOURCE_SIGNATURE,
	loadExplorationThreadGraphProjection,
} from "../../../src/exploration-thread-graph/exploration-thread-graph-projection-loader";

// 这里的命门只有一条：核心包适配器表达「转录读不出来」用的是**哨兵快照**（turns 为空、
// sourceSignature = "unavailable"）而不是抛错。只认 try/catch 的话，不可用会被静默伪装成
// 「这条会话一个已完成 turn 都没有」——面板不再警告，节流闸也按 0 个未归位 turn 判。

let storeRoot = "";

beforeAll(async () => {
	// 空 store：核心包对缺失的 collection / topic registry 一律回空值，正是「刚建卡还没有图」的形态。
	storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-projection-loader-"));
});

afterAll(async () => {
	await rm(storeRoot, { recursive: true, force: true });
});

function makeSessionRef(nativeSessionId: string): ConversationSessionRef {
	return {
		harnessKind: "claude_code",
		nativeSessionId,
		transcriptPath: `/transcripts/${nativeSessionId}.jsonl`,
		workingDirectory: "/repo",
		launchArgvTemplate: { model: "default", appendSystemPrompt: null, settingsPath: null, extraArgs: [] },
	};
}

function makeReadableSnapshot(
	conversationSessionId: string,
	turnNumbers: readonly number[],
): CompletedTurnSequenceSnapshot {
	return {
		conversationSessionId,
		sourceKind: "claude_code_transcript",
		turns: turnNumbers.map((turnNumber) => ({
			turnNumber,
			userPromptExcerpt: `prompt ${turnNumber}`,
			assistantResponseExcerpt: `response ${turnNumber}`,
			startedAt: new Date(turnNumber * 1_000).toISOString(),
			endedAt: new Date(turnNumber * 1_000 + 500).toISOString(),
			userMessageOrigin: "human_typed",
			toolCallCount: 0,
		})),
		sourceSignature: `1700000000000:${turnNumbers.length * 100}:${turnNumbers.length * 100}`,
		projectionConfidence: "transcript_reconstructed",
		inProgressTurnNumber: null,
	};
}

// 与 ClaudeCodeTranscriptCompletedTurnSource 读失败时的返回值逐字一致（转录缺失 / 不可读 / 超预算单行）。
function makeUnavailableSnapshot(conversationSessionId: string): CompletedTurnSequenceSnapshot {
	return {
		conversationSessionId,
		sourceKind: "claude_code_transcript",
		turns: [],
		sourceSignature: COMPLETED_TURN_SEQUENCE_UNAVAILABLE_SNAPSHOT_SOURCE_SIGNATURE,
		projectionConfidence: "transcript_reconstructed",
		inProgressTurnNumber: null,
	};
}

function makeTurnSource(
	readOutcomeByNativeSessionId: Readonly<Record<string, CompletedTurnSequenceSnapshot | Error>>,
): CompletedTurnSequenceSource {
	return {
		readCompletedTurnSequence: async (sessionRef) => {
			const readOutcome = readOutcomeByNativeSessionId[sessionRef.nativeSessionId];
			if (readOutcome === undefined) {
				throw new Error(`测试没有为 ${sessionRef.nativeSessionId} 准备读取结果`);
			}
			if (readOutcome instanceof Error) throw readOutcome;
			return readOutcome;
		},
	};
}

describe("loadExplorationThreadGraphProjection", () => {
	it("哨兵签名的快照算不可用：排除出快照表并记进不可用清单", async () => {
		const result = await loadExplorationThreadGraphProjection({
			explorationId: "exploration-1",
			storeRoot,
			sessionRefs: [makeSessionRef("native-readable"), makeSessionRef("native-unavailable")],
			turnSource: makeTurnSource({
				"native-readable": makeReadableSnapshot("native-readable", [1, 2]),
				"native-unavailable": makeUnavailableSnapshot("native-unavailable"),
			}),
		});

		expect(result.turnSourceUnavailableSessionIds).toEqual(["native-unavailable"]);
		expect([...result.turnSnapshotsBySession.keys()]).toEqual(["native-readable"]);
	});

	it("读取抛错时仍然兜底记账（harnessKind 不匹配现在就抛，适配器契约也可能改回抛错）", async () => {
		const result = await loadExplorationThreadGraphProjection({
			explorationId: "exploration-1",
			storeRoot,
			sessionRefs: [makeSessionRef("native-throwing")],
			turnSource: makeTurnSource({ "native-throwing": new Error("transcript 读不动") }),
		});

		expect(result.turnSourceUnavailableSessionIds).toEqual(["native-throwing"]);
		expect(result.turnSnapshotsBySession.size).toBe(0);
	});

	it("真的读到了（哪怕一个已完成 turn 都没有）就不算不可用", async () => {
		const result = await loadExplorationThreadGraphProjection({
			explorationId: "exploration-1",
			storeRoot,
			sessionRefs: [makeSessionRef("native-empty-but-readable")],
			turnSource: makeTurnSource({
				"native-empty-but-readable": makeReadableSnapshot("native-empty-but-readable", []),
			}),
		});

		expect(result.turnSourceUnavailableSessionIds).toEqual([]);
		expect([...result.turnSnapshotsBySession.keys()]).toEqual(["native-empty-but-readable"]);
	});

	it("不可用会话不进节流判定：可读会话的未归位 turn 照常算，不被哨兵快照稀释", async () => {
		const result = await loadExplorationThreadGraphProjection({
			explorationId: "exploration-1",
			storeRoot,
			sessionRefs: [makeSessionRef("native-readable"), makeSessionRef("native-unavailable")],
			turnSource: makeTurnSource({
				"native-readable": makeReadableSnapshot("native-readable", [1, 2, 3]),
				"native-unavailable": makeUnavailableSnapshot("native-unavailable"),
			}),
		});

		expect(
			decideExplorationThreadGraphMaintenanceThrottle({
				collection: result.collection,
				turnSnapshotsBySession: result.turnSnapshotsBySession,
			}),
		).toEqual({ shouldRun: true, mode: "initial_backfill", unplacedCompletedTurnCount: 3 });
	});
});
