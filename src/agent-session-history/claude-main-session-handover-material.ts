import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readAssistantMessageText } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TaskMainSessionHandoverMaterial } from "../core/task-main-session-handover-contract";
import {
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";
import { resolveClaudeTranscriptFileForAgentNativeConversationSession } from "./claude-transcript-file-location-for-resume";

// EXPERIMENT_NODE: 交接预览最多扫描 8 MiB 的 transcript 头尾，缺失正文时如实提示并保留全文引用。
const MAXIMUM_HANDOVER_TRANSCRIPT_PREVIEW_BYTES = 8 * 1024 * 1024;

export async function collectClaudeMainSessionHandoverMaterial(input: {
	card: RuntimeBoardCard;
	sourceSummary: RuntimeTaskSessionSummary;
	workspacePath: string;
	userContextNotes?: string;
	additionalPlanReferencePaths?: readonly string[];
	workspaceGitStatus?: string | null;
	workspaceHeadCommit?: string | null;
}): Promise<TaskMainSessionHandoverMaterial> {
	const { card, sourceSummary } = input;
	const identity = sourceSummary.agentNativeConversationSessionIdentity;
	const workspacePath = sourceSummary.workspacePath ?? input.workspacePath;
	const missing: string[] = [];
	if (input.workspaceGitStatus == null) missing.push("无法读取任务工作目录的 git 状态，未以主仓库状态代替。");
	if (input.workspaceHeadCommit == null) missing.push("无法确认任务工作目录的 HEAD。");
	let transcriptPath: string | null = null;
	if (identity?.sourceAgentId === "claude") {
		transcriptPath = identity.transcriptPath;
		if (!transcriptPath)
			transcriptPath =
				(
					await resolveClaudeTranscriptFileForAgentNativeConversationSession({
						workspacePath,
						agentNativeConversationSessionId: identity.nativeSessionId,
					})
				)?.filePath ?? null;
	} else missing.push("原会话尚无可确认的 Claude 原生身份，未按目录猜选其他会话。");
	let lastAgentMessage: TaskMainSessionHandoverMaterial["lastAgentMessage"] = null;
	const planPaths = new Set(input.additionalPlanReferencePaths?.map((path) => resolve(workspacePath, path)));
	const planEvidence = new Map<string, string>();
	const planApprovalToolInputs = new Map<string, string>();
	const approvedPlanContents = new Map<string, string>();
	const rememberPlanPathsInText = (text: string, evidence: string) => {
		for (const match of text.matchAll(/(?:\/[\w.\-~/]+|\.plan\/[\w.\-/]+)\.md\b/gu)) {
			const path = resolve(workspacePath, match[0]);
			if (!/\/\.claude\/plans\/|\/\.plan\//u.test(path)) continue;
			planPaths.add(path);
			planEvidence.set(path, evidence);
		}
	};
	rememberPlanPathsInText(card.prompt, "原任务需求中的明确引用");
	if (transcriptPath) {
		try {
			const info = await stat(transcriptPath);
			const transcript = await readBoundedJsonLines(
				transcriptPath,
				info.size,
				MAXIMUM_HANDOVER_TRANSCRIPT_PREVIEW_BYTES,
			);
			for (const line of transcript.lines) {
				const record = parseTranscriptJsonRecord(line);
				if (!record || record.isSidechain === true) continue;
				if (record.type === "assistant") {
					const text = readAssistantMessageText(record);
					if (text.trim()) {
						lastAgentMessage = { text, sourceReference: transcriptPath };
						rememberPlanPathsInText(text, "原 Claude transcript 中的引用，批准状态尚未确认");
					}
					const message = readTranscriptRecord(record.message);
					for (const block of Array.isArray(message?.content) ? message.content : []) {
						const tool = readTranscriptRecord(block);
						const toolInput = readTranscriptRecord(tool?.input);
						if (
							tool?.type === "tool_use" &&
							tool.name === "ExitPlanMode" &&
							typeof tool.id === "string" &&
							typeof toolInput?.plan === "string"
						) {
							planApprovalToolInputs.set(tool.id, toolInput.plan);
						}
						const path = toolInput?.file_path ?? toolInput?.path;
						if (tool?.type === "tool_use" && typeof path === "string") {
							rememberPlanPathsInText(path, "原 Claude 工具调用引用，批准状态尚未确认");
						}
					}
				}
				if (record.type === "user") {
					const message = readTranscriptRecord(record.message);
					for (const content of Array.isArray(message?.content) ? message.content : []) {
						const result = readTranscriptRecord(content);
						if (
							result?.type !== "tool_result" ||
							result.is_error === true ||
							typeof result.tool_use_id !== "string"
						)
							continue;
						const plan = planApprovalToolInputs.get(result.tool_use_id);
						if (plan?.trim())
							approvedPlanContents.set(plan.trim(), `${transcriptPath}#tool_use_id=${result.tool_use_id}`);
					}
				}
			}
			if (transcript.transcriptWasTruncated)
				missing.push("预览只扫描 transcript 头尾，历史中段的计划引用可能未被发现；已保留完整 transcript 引用。");
		} catch {
			missing.push(`无法读取已确认的 transcript：${transcriptPath}`);
			transcriptPath = null;
		}
	}
	if (!transcriptPath) missing.push("缺少可读取的精确 transcript。");
	if (!lastAgentMessage && sourceSummary.latestHookActivity?.finalMessage) {
		lastAgentMessage = {
			text: sourceSummary.latestHookActivity.finalMessage,
			sourceReference: `session-summary:${sourceSummary.taskId}:latestHookActivity.finalMessage`,
		};
	}
	if (!lastAgentMessage) missing.push("缺少可确认的最后一条 agent 正文。");
	const planReferences: TaskMainSessionHandoverMaterial["planReferences"] = [];
	for (const path of planPaths) {
		if (!isAbsolute(path)) continue;
		try {
			const contents = await readFile(path, "utf8");
			const approvalEvidence = approvedPlanContents.get(contents.trim());
			planReferences.push({
				absolutePath: path,
				approvalStatus: approvalEvidence ? "approved" : "unconfirmed",
				evidenceDescription: approvalEvidence
					? `原 Claude ExitPlanMode 成功回执与计划正文逐字匹配：${approvalEvidence}`
					: (planEvidence.get(path) ?? "用户在交接时补充的计划引用，批准状态尚未确认"),
			});
		} catch {
			missing.push(`计划引用不可读取：${path}`);
		}
	}
	if (planReferences.length === 0) missing.push("尚未找到明确关联的可读计划；不从全局计划目录猜选。");
	return {
		taskTitle: card.title ?? card.id,
		taskPrompt: card.prompt,
		sourceTaskConversationSessionId: sourceSummary.taskId,
		sourceAgentId: sourceSummary.agentId ?? "claude",
		sourceNativeConversationSessionId: identity?.sourceAgentId === "claude" ? identity.nativeSessionId : null,
		workspacePath,
		currentWorkPhaseGoal: sourceSummary.agentCurrentWorkPhaseGoal?.goalText ?? null,
		planReferences,
		transcriptReferences: transcriptPath ? [transcriptPath] : [],
		lastAgentMessage,
		workspaceGitStatus: input.workspaceGitStatus ?? null,
		workspaceHeadCommit: input.workspaceHeadCommit ?? null,
		missingMaterialDescriptions: missing,
		userContextNotes: input.userContextNotes ?? "",
	};
}
