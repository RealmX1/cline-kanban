import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveAgentCurrentWorkPhaseGoalForDisplay } from "../core/agent-current-work-phase-goal";
import type { RuntimeBoardCard, RuntimeTaskChatMessage, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TaskMainSessionHandoverMaterial } from "../core/task-main-session-handover-contract";
import { loadTaskConversationHistoryPage } from "./task-conversation-history-page";

// EXPERIMENT_NODE: 交接预览最多读取 32 页、8 MiB 正文；超预算保留精确分段引用并声明缺口。
const MAXIMUM_HANDOVER_HISTORY_PAGES = 32;
const MAXIMUM_HANDOVER_HISTORY_TEXT_BYTES = 8 * 1024 * 1024;

export async function collectCodexMainSessionHandoverMaterial(input: {
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
	const transcriptPaths = new Set<string>();
	const historyPages: RuntimeTaskChatMessage[][] = [];
	let cursor: string | null = null;
	let textBytes = 0;
	const seenCursors = new Set<string>();
	for (let pageIndex = 0; pageIndex < MAXIMUM_HANDOVER_HISTORY_PAGES; pageIndex++) {
		const page = await loadTaskConversationHistoryPage({
			card,
			sessions: { [sourceSummary.taskId]: sourceSummary },
			request: { workspaceTaskId: card.id, taskConversationSessionId: sourceSummary.taskId, cursor },
			onVerifiedTranscriptSegment: (path) => transcriptPaths.add(path),
		});
		if (page.availability !== "available") missing.push(page.notice ?? "部分原生历史无法完整读取。");
		if (page.availability === "unavailable") break;
		historyPages.push(page.messages);
		textBytes += page.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
		cursor = page.nextCursor;
		if (!cursor) break;
		if (seenCursors.has(cursor)) {
			missing.push("历史分页标记重复，未将部分内容视作完整历史。");
			break;
		}
		seenCursors.add(cursor);
		if (textBytes >= MAXIMUM_HANDOVER_HISTORY_TEXT_BYTES || pageIndex === MAXIMUM_HANDOVER_HISTORY_PAGES - 1) {
			missing.push("交接预览达到读取预算，较早正文与计划可能未收集；保留已核实的 transcript 分段引用。");
			break;
		}
	}
	const messages = historyPages.reverse().flat();
	const reversedAssistantIndex = [...messages].reverse().findIndex((message) => message.role === "assistant");
	const latestAssistantIndex = reversedAssistantIndex < 0 ? -1 : messages.length - reversedAssistantIndex - 1;
	const continuousAssistantMessages: RuntimeTaskChatMessage[] = [];
	for (let index = latestAssistantIndex; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== "assistant") break;
		continuousAssistantMessages.unshift(message);
	}
	const lastAgentMessage = continuousAssistantMessages.length
		? {
				text: continuousAssistantMessages.map((message) => message.content).join("\n\n"),
				sourceReference: `native-history:${sourceSummary.taskId}:${continuousAssistantMessages.map((message) => message.id).join(",")}`,
			}
		: sourceSummary.latestHookActivity?.finalMessage
			? {
					text: sourceSummary.latestHookActivity.finalMessage,
					sourceReference: `session-summary:${sourceSummary.taskId}:latestHookActivity.finalMessage`,
				}
			: null;
	const embeddedPlanReferences: NonNullable<TaskMainSessionHandoverMaterial["embeddedPlanReferences"]> = [];
	const planPaths = new Map<string, string>();
	for (const path of input.additionalPlanReferencePaths ?? [])
		planPaths.set(resolve(workspacePath, path), "用户在交接时补充的计划路径，批准状态尚未确认");
	const rememberPlanPaths = (text: string, sourceReference: string) => {
		for (const match of text.matchAll(/(?:\/[\w.\-~/]+|\.plan\/[\w.\-/]+)\.md\b/gu)) {
			const path = resolve(workspacePath, match[0]);
			if (/\/\.plan\/|\/plans\//u.test(path)) planPaths.set(path, sourceReference);
		}
	};
	rememberPlanPaths(card.prompt, "原任务需求中的明确引用");
	for (const message of messages) {
		if (message.role !== "assistant" && message.role !== "user") continue;
		const sourceReference = `native-history:${sourceSummary.taskId}:${message.id}`;
		rememberPlanPaths(message.content, sourceReference);
		if (message.role !== "assistant") continue;
		for (const match of message.content.matchAll(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/gu)) {
			const text = match[1]?.trim();
			if (text) embeddedPlanReferences.push({ text, sourceReference, approvalStatus: "unconfirmed" });
		}
	}
	const planReferences: TaskMainSessionHandoverMaterial["planReferences"] = [];
	for (const [absolutePath, evidenceDescription] of planPaths) {
		try {
			await readFile(absolutePath, "utf8");
			planReferences.push({ absolutePath, approvalStatus: "unconfirmed", evidenceDescription });
		} catch {
			missing.push(`计划引用不可读取：${absolutePath}`);
		}
	}
	if (!planReferences.length && !embeddedPlanReferences.length) missing.push("尚未找到可确认关联的计划。");
	if (planReferences.length || embeddedPlanReferences.length)
		missing.push("Codex 计划正文与历史用户消息已保留；未将普通历史文本推断为批准或新的实施授权。");
	if (!lastAgentMessage) missing.push("缺少可确认的最后连续 agent 正文。");
	if (input.workspaceGitStatus == null) missing.push("无法读取任务工作目录的 git 状态。");
	if (input.workspaceHeadCommit == null) missing.push("无法确认任务工作目录的 HEAD。");
	const phaseGoal = resolveAgentCurrentWorkPhaseGoalForDisplay(sourceSummary);
	return {
		taskTitle: card.title ?? card.id,
		taskPrompt: card.prompt,
		sourceTaskConversationSessionId: sourceSummary.taskId,
		sourceAgentId: "codex",
		sourceNativeConversationSessionId: identity?.sourceAgentId === "codex" ? identity.nativeSessionId : null,
		workspacePath,
		currentWorkPhaseGoal: phaseGoal && !phaseGoal.isHistorical ? phaseGoal.goalText : null,
		planReferences,
		embeddedPlanReferences,
		transcriptReferences: [...transcriptPaths],
		lastAgentMessage,
		workspaceGitStatus: input.workspaceGitStatus ?? null,
		workspaceHeadCommit: input.workspaceHeadCommit ?? null,
		missingMaterialDescriptions: [...new Set(missing)],
		userContextNotes: input.userContextNotes ?? "",
	};
}
