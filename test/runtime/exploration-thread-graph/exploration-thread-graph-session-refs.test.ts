import { describe, expect, it } from "vitest";
import type {
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeAgentSessionForkReplayLaunchArguments,
	RuntimeTaskConversationSessionMetadata,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { assembleExplorationThreadGraphSessionRefs } from "../../../src/exploration-thread-graph/exploration-thread-graph-session-refs";

// 会话引用组装的命门：主会话恒在 [0]、sidecar 必须同源、缺项只剔这一条而不是炸整批。

function makeNativeIdentity(
	overrides: Partial<RuntimeAgentNativeConversationSessionIdentity> = {},
): RuntimeAgentNativeConversationSessionIdentity {
	return {
		sourceAgentId: "claude",
		nativeSessionId: "native-session-1",
		transcriptPath: "/transcripts/native-session-1.jsonl",
		observedAt: 1_000,
		...overrides,
	};
}

function makeForkReplayLaunchArguments(
	overrides: Partial<RuntimeAgentSessionForkReplayLaunchArguments> = {},
): RuntimeAgentSessionForkReplayLaunchArguments {
	return {
		sourceAgentId: "claude",
		modelArgumentLiteral: "default",
		appendSystemPromptText: "This is an exploratory conversation:\n- stay curious",
		settingsFilePath: "/settings.json",
		capturedAt: 900,
		...overrides,
	};
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "exploration-1",
		state: "idle",
		agentId: "claude",
		workspacePath: "/repo",
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: makeNativeIdentity(),
		agentSessionForkReplayLaunchArguments: makeForkReplayLaunchArguments(),
		...overrides,
	};
}

function makeByTheWayMetadata(mainSessionOriginTurnNumber: number | null): RuntimeTaskConversationSessionMetadata {
	return {
		workspaceTaskId: "exploration-1",
		taskConversationSessionRole: "by_the_way",
		taskConversationSessionContextSource: "forked_from_main_current_turn",
		parentTaskConversationSessionId: "exploration-1",
		mainSessionOriginTurnNumber,
		mainSessionOriginUserMessagePreview: null,
		latestUserMessagePreview: null,
	};
}

describe("assembleExplorationThreadGraphSessionRefs", () => {
	it("主会话恒在 [0]，by-the-way 会话按 taskId 稳定排序跟在其后", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({
					taskId: "by-the-way-b",
					agentNativeConversationSessionIdentity: makeNativeIdentity({ nativeSessionId: "native-b" }),
					taskConversationSessionMetadata: makeByTheWayMetadata(7),
				}),
				makeSummary({
					taskId: "by-the-way-a",
					agentNativeConversationSessionIdentity: makeNativeIdentity({ nativeSessionId: "native-a" }),
					taskConversationSessionMetadata: makeByTheWayMetadata(3),
				}),
				makeSummary({ taskId: "exploration-1" }),
			],
		});

		expect(assembly.sessionRefs.map((ref) => ref.nativeSessionId)).toEqual([
			"native-session-1",
			"native-a",
			"native-b",
		]);
	});

	it("by-the-way 会话把 mainSessionOriginTurnNumber 翻译成分叉锚点；主会话不带该字段", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "exploration-1" }),
				makeSummary({
					taskId: "by-the-way-a",
					agentNativeConversationSessionIdentity: makeNativeIdentity({ nativeSessionId: "native-a" }),
					taskConversationSessionMetadata: makeByTheWayMetadata(4),
				}),
			],
		});

		expect(assembly.sessionRefs[0]).not.toHaveProperty("forkedFromParentSessionTurnNumber");
		expect(assembly.sessionRefs[1]).toMatchObject({ forkedFromParentSessionTurnNumber: 4 });
	});

	it("launchArgvTemplate 逐字取自启动快照，绝不重算", () => {
		const promptWithAwkwardWhitespace = "line one\n\n   indented\ttab";
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({
					agentSessionForkReplayLaunchArguments: makeForkReplayLaunchArguments({
						modelArgumentLiteral: "default",
						appendSystemPromptText: promptWithAwkwardWhitespace,
						settingsFilePath: "/custom/settings.json",
					}),
				}),
			],
		});

		const [mainSessionRef] = assembly.sessionRefs;
		expect(mainSessionRef?.harnessKind).toBe("claude_code");
		if (mainSessionRef?.harnessKind !== "claude_code") {
			throw new Error("主会话必须是 claude_code harness");
		}
		expect(mainSessionRef.launchArgvTemplate).toEqual({
			// 浮动别名存字面值；解析后的模型 id 会在上游换代后指向错误的模型。
			model: "default",
			appendSystemPrompt: promptWithAwkwardWhitespace,
			settingsPath: "/custom/settings.json",
			// 宿主不额外追加 argv：分身的参数面必须与主会话一致。
			extraArgs: [],
		});
	});

	it("两个 sidecar 的 sourceAgentId 不一致时剔除该会话——那是换过 agent 后的陈旧快照", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({
					agentSessionForkReplayLaunchArguments: makeForkReplayLaunchArguments({ sourceAgentId: "codex" }),
				}),
			],
		});

		expect(assembly.sessionRefs).toEqual([]);
		expect(assembly.excludedSessions).toEqual([{ taskId: "exploration-1", reason: "sidecar_agent_mismatch" }]);
	});

	it("sidecar 与会话当前 agentId 不一致时同样剔除", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [makeSummary({ agentId: "codex" })],
		});

		expect(assembly.sessionRefs).toEqual([]);
		expect(assembly.excludedSessions).toEqual([{ taskId: "exploration-1", reason: "sidecar_agent_mismatch" }]);
	});

	it("会话当前 agentId 为 null 时也剔除——确认不了身份就不该 fork", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [makeSummary({ agentId: null })],
		});

		expect(assembly.sessionRefs).toEqual([]);
		expect(assembly.excludedSessions).toEqual([{ taskId: "exploration-1", reason: "sidecar_agent_mismatch" }]);
	});

	it("尚未接入的 harness 被剔除（v1 只有 claude 的 fork 语义已核实）", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({
					agentId: "codex",
					agentNativeConversationSessionIdentity: makeNativeIdentity({ sourceAgentId: "codex" }),
					agentSessionForkReplayLaunchArguments: makeForkReplayLaunchArguments({ sourceAgentId: "codex" }),
				}),
			],
		});

		expect(assembly.excludedSessions).toEqual([{ taskId: "exploration-1", reason: "unsupported_harness" }]);
	});

	it.each([
		["缺 N0a 身份", { agentNativeConversationSessionIdentity: null }, "missing_native_conversation_session_identity"],
		["缺启动快照", { agentSessionForkReplayLaunchArguments: null }, "missing_fork_replay_launch_arguments"],
		[
			"缺 transcript 路径",
			{ agentNativeConversationSessionIdentity: makeNativeIdentity({ transcriptPath: null }) },
			"missing_transcript_path",
		],
		["缺工作目录", { workspacePath: null }, "missing_working_directory"],
	] as const)("主会话%s时整体放弃——没有可 fork 的对象", (_label, overrides, expectedReason) => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [makeSummary(overrides)],
		});

		expect(assembly.sessionRefs).toEqual([]);
		expect(assembly.excludedSessions).toEqual([{ taskId: "exploration-1", reason: expectedReason }]);
	});

	it("by-the-way 会话缺 sidecar 只剔它自己，主会话照常入列", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "exploration-1" }),
				makeSummary({
					taskId: "by-the-way-a",
					agentNativeConversationSessionIdentity: null,
					taskConversationSessionMetadata: makeByTheWayMetadata(2),
				}),
			],
		});

		expect(assembly.sessionRefs.map((ref) => ref.nativeSessionId)).toEqual(["native-session-1"]);
		expect(assembly.excludedSessions).toEqual([
			{ taskId: "by-the-way-a", reason: "missing_native_conversation_session_identity" },
		]);
	});

	it("同时给出原生 session id → 宿主 taskId 的桥接表（findings provenance 要 taskId）", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "exploration-1" }),
				makeSummary({
					taskId: "by-the-way-a",
					agentNativeConversationSessionIdentity: makeNativeIdentity({ nativeSessionId: "native-a" }),
					taskConversationSessionMetadata: makeByTheWayMetadata(2),
				}),
			],
		});

		expect(assembly.hostTaskIdByNativeSessionId).toEqual({
			"native-session-1": "exploration-1",
			"native-a": "by-the-way-a",
		});
	});

	it("被剔除的会话不进桥接表——没有 taskId 可用时宁可跳过也不伪造", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "exploration-1" }),
				makeSummary({
					taskId: "by-the-way-a",
					agentNativeConversationSessionIdentity: null,
					taskConversationSessionMetadata: makeByTheWayMetadata(2),
				}),
			],
		});

		expect(assembly.hostTaskIdByNativeSessionId).toEqual({ "native-session-1": "exploration-1" });
	});

	it("不属于本 exploration 的会话完全不参与——跨卡片撞不到一起", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "exploration-1" }),
				makeSummary({ taskId: "unrelated-task", agentNativeConversationSessionIdentity: null }),
			],
		});

		expect(assembly.sessionRefs).toHaveLength(1);
		expect(assembly.excludedSessions).toEqual([]);
	});

	it("主会话缺席时返回空数组（by-the-way 会话不能独自成图）", () => {
		const assembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: "exploration-1",
			sessionSummaries: [
				makeSummary({ taskId: "by-the-way-a", taskConversationSessionMetadata: makeByTheWayMetadata(1) }),
			],
		});

		expect(assembly.sessionRefs).toEqual([]);
	});
});
