import { resolve } from "node:path";
import { z } from "zod";
import { loadTaskConversationHistoryPage } from "../agent-session-history/task-conversation-history-page";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import { mergeSummaryWithFacets } from "../core/session-activity";
import type { TaskMainSessionHandoverReportAcceptanceProbe } from "../core/task-main-session-handover-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import {
	type CodexAppServerRequestPort,
	readCodexConversationTurns,
} from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import { TaskMainSessionHandoverExecutionProhibitedError } from "./codex-main-session-handover-native-fork";

const nativeReportHistoryPageSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			items: z.array(
				z.object({
					id: z.string(),
					type: z.string(),
					content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
				}),
			),
		}),
	),
	nextCursor: z.string().nullable(),
});

function isExactSubmittedHandoverReport(text: string, prompt: string) {
	// TUI 原生 /plan 消费前缀；某些版本的持久历史保留原命令。两者均要求完整正文逐字一致。
	return text === prompt || (prompt.startsWith("/plan ") && text === prompt.slice(6));
}

export async function queryCodexMainSessionHandoverReportAcceptanceWithPort(
	port: CodexAppServerRequestPort,
	probe: TaskMainSessionHandoverReportAcceptanceProbe,
	prompt: string,
): Promise<TaskMainSessionHandoverReportAcceptanceProbe> {
	if (probe.historicalAcceptanceEvidence) return probe;
	const thread = z
		.object({ thread: z.object({ id: z.string(), cwd: z.string() }) })
		.parse(await port.request("thread/read", { threadId: probe.nativeSessionId, includeTurns: false })).thread;
	if (thread.id !== probe.nativeSessionId || resolve(thread.cwd) !== resolve(probe.workingDirectoryPath))
		throw new TaskMainSessionHandoverExecutionProhibitedError("报告接受补证的原生身份或目录归属不符。");
	let page: z.infer<typeof nativeReportHistoryPageSchema>;
	try {
		page = nativeReportHistoryPageSchema.parse(
			await port.request("thread/turns/list", {
				threadId: probe.nativeSessionId,
				cursor: probe.nativeHistoryCursor,
				limit: 100,
				sortDirection: "desc",
				itemsView: "full",
			}),
		);
	} catch (error) {
		if (
			probe.nativeHistoryCursor !== null ||
			!(error instanceof Error) ||
			!error.message.includes("list_turns is not supported yet")
		)
			throw error;
		page = { data: await readCodexConversationTurns(port, probe.nativeSessionId), nextCursor: null };
	}
	for (const turn of page.data) {
		for (const item of turn.items) {
			if (
				item.type !== "userMessage" ||
				!item.content?.length ||
				item.content.some((part) => !["text", "input_text"].includes(part.type) || part.text === undefined) ||
				!isExactSubmittedHandoverReport(item.content.map((part) => part.text).join(""), prompt)
			)
				continue;
			return {
				...probe,
				historicalAcceptanceEvidence: {
					sourceReference: `codex-native:${probe.nativeSessionId}:${turn.id}:${item.id}`,
					observedAt: Date.now(),
				},
			};
		}
	}
	if (page.nextCursor && probe.seenNativeHistoryCursors.includes(page.nextCursor))
		throw new Error("原生报告接受查询出现循环分页，保留查询进度等待恢复。");
	return {
		...probe,
		nativeHistoryCursor: page.nextCursor,
		seenNativeHistoryCursors: page.nextCursor ? [...probe.seenNativeHistoryCursors, page.nextCursor] : [],
	};
}

// 控制端点不可用时沿原绑定读取持久历史；不启动进程，不发送输入，也不重写原失败账本。
export async function queryCodexMainSessionHandoverReportAcceptance(input: {
	workspaceId: string;
	card: RuntimeBoardCard;
	summary: RuntimeTaskSessionSummary;
	probe: TaskMainSessionHandoverReportAcceptanceProbe;
	prompt: string;
}): Promise<TaskMainSessionHandoverReportAcceptanceProbe> {
	let probe = input.probe;
	if (probe.historicalAcceptanceEvidence) return probe;
	const endpoint = input.summary.codexNativeSessionControlEndpoint;
	if (
		endpoint?.workspaceId === input.workspaceId &&
		endpoint.conversationSessionId === input.summary.taskId &&
		endpoint.runtimeSessionIncarnationId === input.summary.runtimeSessionIncarnationId
	) {
		try {
			probe = await withRunningCodexAppServerControlSocketConnection(
				async (port) => await queryCodexMainSessionHandoverReportAcceptanceWithPort(port, probe, input.prompt),
				{ socketPath: endpoint.socketPath, requestTimeoutMs: 2_000 },
			);
			if (probe.historicalAcceptanceEvidence) return probe;
		} catch (error) {
			if (error instanceof TaskMainSessionHandoverExecutionProhibitedError) throw error;
			// 等价来源是已绑定的原生持久记录；控制端点的暂时故障不需要人提供机器信息。
		}
	}
	const historicalSummary: RuntimeTaskSessionSummary = mergeSummaryWithFacets(
		{
			...input.summary,
			agentId: "codex",
			workspacePath: probe.workingDirectoryPath,
			codexConversationStorageHomeDirectoryPath: probe.codexConversationStorageHomeDirectoryPath,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: probe.nativeSessionId,
				transcriptPath: probe.transcriptPath,
				observedAt: 0,
			},
		},
		{ turnOwner: null, liveness: "none", userTurnKind: null },
	);
	let resolvedTranscriptPath: string | null = null;
	const page = await loadTaskConversationHistoryPage({
		card: input.card,
		sessions: { [historicalSummary.taskId]: historicalSummary },
		request: {
			workspaceTaskId: input.card.id,
			taskConversationSessionId: historicalSummary.taskId,
			cursor: probe.transcriptHistoryCursor,
		},
		onVerifiedTranscriptSegment: (path) => {
			resolvedTranscriptPath ??= path;
		},
	});
	if (page.availability === "unavailable") return probe;
	for (const message of page.messages) {
		if (message.role === "user" && isExactSubmittedHandoverReport(message.content, input.prompt))
			return {
				...probe,
				historicalAcceptanceEvidence: {
					sourceReference: `codex-transcript:${probe.nativeSessionId}:${message.id}`,
					observedAt: Date.now(),
				},
			};
	}
	return {
		...probe,
		transcriptPath: resolvedTranscriptPath ?? probe.transcriptPath,
		transcriptHistoryCursor: page.nextCursor,
	};
}
