import { describe, expect, it } from "vitest";
import type { RuntimeTaskConversationSessionMetadata, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveObservedTaskConversationSessionContextSourceIdentity } from "../../../src/core/task-conversation-session-context-source";

const metadata = {
	workspaceTaskId: "task",
	taskConversationSessionRole: "by_the_way",
	taskConversationSessionContextSource: "forked_from_conversation_session",
	contextSourceTaskConversationSessionId: "source",
	parentTaskConversationSessionId: "source",
	mainSessionOriginTurnNumber: null,
	mainSessionOriginUserMessagePreview: null,
	latestUserMessagePreview: null,
} satisfies RuntimeTaskConversationSessionMetadata;

function liveSource(nativeSessionId: string, transcriptPath: string | null): RuntimeTaskSessionSummary {
	return {
		taskId: "source",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		agentId: "codex",
		workspacePath: "/repo",
		pid: 1,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: null,
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath,
			observedAt: 2,
		},
	};
}

describe("复刻回报的来源身份补证", () => {
	it("创建时没有原生身份时，采用来源会话后来落下的身份", () => {
		expect(
			resolveObservedTaskConversationSessionContextSourceIdentity(metadata, liveSource("native-1", "/transcript")),
		).toEqual({
			sourceAgentId: "codex",
			nativeSessionId: "native-1",
			transcriptPath: "/transcript",
		});
	});

	it("已记录身份只补齐同一原生会话的转录路径，不改用后来换掉的身份", () => {
		const recorded = {
			...metadata,
			contextSourceNativeSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native-1",
				transcriptPath: null,
			},
		};
		expect(
			resolveObservedTaskConversationSessionContextSourceIdentity(recorded, liveSource("native-1", "/transcript")),
		).toMatchObject({ nativeSessionId: "native-1", transcriptPath: "/transcript" });
		expect(
			resolveObservedTaskConversationSessionContextSourceIdentity(recorded, liveSource("native-2", "/other")),
		).toMatchObject({ nativeSessionId: "native-1", transcriptPath: null });
	});
});
