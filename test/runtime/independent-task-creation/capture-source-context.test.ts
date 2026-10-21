import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { captureIndependentTaskSourceContext } from "../../../src/independent-task-creation/capture-source-context";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

function createSourceContextFixture() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const artifactDirectory = join(fixture.fixtureRootDirectoryPath, "captured-source-context");
	mkdirSync(artifactDirectory);
	const sourceTranscriptPath = join(fixture.fixtureRootDirectoryPath, "side-session.jsonl");
	const parentTranscriptPath = join(fixture.fixtureRootDirectoryPath, "current-main-session.jsonl");
	const originTranscriptPath = join(fixture.fixtureRootDirectoryPath, "origin-main-session.jsonl");
	const writeUserMessage = (path: string, text: string, timestamp: number) =>
		writeFileSync(
			path,
			JSON.stringify({
				type: "response_item",
				timestamp,
				payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
			}),
		);
	writeUserMessage(sourceTranscriptPath, "侧会话正文", 200);
	writeUserMessage(parentTranscriptPath, "当前主会话正文", 50);
	writeUserMessage(originTranscriptPath, "固定来源主会话正文", 50);
	const parentIdentity = {
		sourceAgentId: "codex",
		nativeSessionId: "origin-native-session",
		transcriptPath: parentTranscriptPath,
		observedAt: 200,
	};
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "main",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		agentId: "codex",
		workspacePath: fixture.fixtureRootDirectoryPath,
		pid: null,
		startedAt: 100,
		updatedAt: 200,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentNativeConversationSessionIdentity: parentIdentity,
	});
	const source = {
		...summary,
		taskId: "side",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "side-native-session",
			transcriptPath: sourceTranscriptPath,
			observedAt: 200,
		},
		taskConversationSessionMetadata: {
			workspaceTaskId: "main",
			sideSessionCreatedAt: 100,
			sideSessionOriginMainNativeSessionId: "origin-native-session",
			sideSessionOriginMainAgentId: "codex",
			taskConversationSessionRole: "task_collaborator" as const,
			taskConversationSessionContextSource: "started_from_scratch" as const,
			parentTaskConversationSessionId: "main",
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		},
	};
	return { source, parent: summary, parentIdentity, artifactDirectory, originTranscriptPath };
}

describe("独立任务上下文的固定来源身份", () => {
	it.each(["nativeSessionId", "sourceAgentId"] as const)(
		"未记录固定转录路径时，当前主会话的 %s 不匹配就不混入其正文",
		async (field) => {
			const fixture = createSourceContextFixture();
			const parent = {
				...fixture.parent,
				agentNativeConversationSessionIdentity: {
					...fixture.parentIdentity,
					[field]: field === "nativeSessionId" ? "replacement-native-session" : "claude",
				},
			};
			const context = await captureIndependentTaskSourceContext({ ...fixture, parent });
			expect(context.before).toEqual([]);
			expect(context.after.map((message) => message.text)).toEqual(["侧会话正文"]);
			expect(context.warnings.join("\n")).toContain("来源");
			expect(context.warnings.join("\n")).toContain("不一致");
		},
	);

	it("当前主会话仍是固定原生身份时，可以补齐转录路径", async () => {
		const context = await captureIndependentTaskSourceContext(createSourceContextFixture());
		expect(context.before.map((message) => message.text)).toEqual(["当前主会话正文"]);
		expect(context.warnings).toEqual([]);
	});

	it("已有固定来源转录路径时，不受当前主会话更换身份影响", async () => {
		const fixture = createSourceContextFixture();
		const context = await captureIndependentTaskSourceContext({
			...fixture,
			source: {
				...fixture.source,
				taskConversationSessionMetadata: {
					...fixture.source.taskConversationSessionMetadata,
					sideSessionOriginMainTranscriptPath: fixture.originTranscriptPath,
				},
			},
			parent: {
				...fixture.parent,
				agentNativeConversationSessionIdentity: {
					...fixture.parentIdentity,
					nativeSessionId: "replacement-native-session",
				},
			},
		});
		expect(context.before.map((message) => message.text)).toEqual(["固定来源主会话正文"]);
		expect(context.warnings).toEqual([]);
	});

	it("缺少固定原生身份的存量记录可以回退，但必须明示来源未被确认", async () => {
		const fixture = createSourceContextFixture();
		const context = await captureIndependentTaskSourceContext({
			...fixture,
			source: {
				...fixture.source,
				taskConversationSessionMetadata: {
					...fixture.source.taskConversationSessionMetadata,
					sideSessionOriginMainNativeSessionId: undefined,
				},
			},
		});
		expect(context.before.map((message) => message.text)).toEqual(["当前主会话正文"]);
		expect(context.warnings.join("\n")).toContain("原生身份");
	});
});
