import { join } from "node:path";
import { ClaudeCodeForkedSessionWorkBranchExecutor } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { recordModelProviderUsage } from "../model-provider-access/model-provider-usage-record";
import type { PersistedIndependentTaskCreationDraft } from "./persisted-creation-draft";

export const generatedIndependentTaskDefinitionSchema = z.object({
	suggestedTaskDescription: z.string().trim().min(1),
	title: z.string().trim().min(1).max(80),
	initialPrompt: z.string().trim().min(1),
});

export function sourceAgentDraftGenerationUnavailableReason(
	record: PersistedIndependentTaskCreationDraft,
): string | null {
	if (record.nativeConversationSeed?.sourceAgentId !== "claude")
		return "当前仅 Claude 来源支持无工具的建议生成分身；可使用 Kanban 模型或手动填写。";
	if (record.sourceSummary?.agentSessionForkReplayLaunchArguments?.sourceAgentId !== "claude")
		return "缺少来源实际启动参数快照，无法可靠复用来源 Agent。";
	return null;
}

export async function generateIndependentTaskDraftWithSourceAgentFork(input: {
	record: PersistedIndependentTaskCreationDraft;
	artifactDirectory: string;
	prompt: string;
}) {
	const unavailable = sourceAgentDraftGenerationUnavailableReason(input.record);
	const seed = input.record.nativeConversationSeed;
	const replay = input.record.sourceSummary?.agentSessionForkReplayLaunchArguments;
	if (unavailable || !seed || !replay || !seed.sourceSessionWorkingDirectoryPath)
		throw new Error(unavailable ?? "来源分身参数缺失。");
	const startedAt = Date.now();
	const result = await new ClaudeCodeForkedSessionWorkBranchExecutor().start({
		parentSession: {
			harnessKind: "claude_code",
			nativeSessionId: seed.sourceSessionId,
			transcriptPath: join(input.artifactDirectory, "source-transcript.jsonl"),
			workingDirectory: seed.sourceSessionWorkingDirectoryPath,
			launchArgvTemplate: {
				model: replay.modelArgumentLiteral ?? "default",
				appendSystemPrompt: replay.appendSystemPromptText,
				settingsPath: replay.settingsFilePath,
				extraArgs: ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
			},
		},
		promptText: input.prompt,
		outputSchema: {
			type: "object",
			properties: {
				suggestedTaskDescription: { type: "string" },
				title: { type: "string" },
				initialPrompt: { type: "string" },
			},
			required: ["suggestedTaskDescription", "title", "initialPrompt"],
			additionalProperties: false,
		},
		timeoutMs: 120_000,
	});
	await lockedFileSystem.writeTextFileAtomic(
		join(input.artifactDirectory, "source-agent-generation-result.json"),
		JSON.stringify(result),
	);
	recordModelProviderUsage({
		modelUsagePurpose: "independent_task_creation_draft_generation",
		modelProviderId: "source-agent-claude",
		modelId: replay.modelArgumentLiteral,
		outcome: result.stopReason === "completed" ? "completed" : "unavailable",
		elapsedMs: Date.now() - startedAt,
		promptCharacterCount: input.prompt.length,
		promptTokenCount: result.usage?.inputTokens,
		completionTokenCount: result.usage?.outputTokens,
	});
	if (result.stopReason !== "completed")
		throw new Error("来源 Agent 分身生成未完成，未自动重试；可切换 Kanban 模型或手动填写。");
	return {
		status: "completed" as const,
		parsedJsonObject: generatedIndependentTaskDefinitionSchema.parse(result.structured),
	};
}
