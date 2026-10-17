import { recoverCodexUserQuestionsForPendingAndHistoryWithFileChangeCache } from "../agent-session-history/codex-user-question-pending-and-history-file-change-cache";
import { buildCodexUserQuestionTranscriptHistoryEntries } from "../agent-session-history/codex-user-question-transcript-recovery";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	resolveAgentRaisedUserQuestionFromAgentTerminal,
	supersedeEarlierCodexUserQuestionsFromTranscript,
} from "../state/agent-raised-pending-user-decision-store";

export async function reconcileCodexUserQuestionTranscriptForTask(input: {
	workspaceId: string;
	taskId: string;
	sessionId: string;
	transcriptPath?: string | null;
	summary: RuntimeTaskSessionSummary | null;
}) {
	const recovered = await recoverCodexUserQuestionsForPendingAndHistoryWithFileChangeCache(input);
	const latest = recovered.exchanges.at(-1);
	const existing = await readAgentRaisedPendingUserDecisions(input.workspaceId);
	const sourceIdForExchange = (exchange: (typeof recovered.exchanges)[number]): string =>
		existing.some(
			(record) =>
				record.taskId === input.taskId &&
				record.agentId === "codex" &&
				record.decisionId === `${input.taskId}:${exchange.callId}` &&
				(!record.nativeConversationSessionId || record.nativeConversationSessionId === input.sessionId),
		)
			? exchange.callId
			: exchange.payload.decisionSourceId;
	const latestSourceId = latest ? sourceIdForExchange(latest) : null;

	// 覆盖不足时可以展示已验证的历史，但不能据此创建待答记录或推断旧问题已解决。
	if (recovered.coverage === "complete" && latest) {
		// 先按调用身份回填已有问题的结局，再创建后继；否则入库后继会覆盖旧问题的 pending 状态。
		for (const exchange of recovered.exchanges) {
			const decisionSourceId = sourceIdForExchange(exchange);
			const existingQuestion = existing.find(
				(record) =>
					record.taskId === input.taskId &&
					record.agentId === "codex" &&
					record.decisionId === `${input.taskId}:${decisionSourceId}` &&
					(!record.nativeConversationSessionId || record.nativeConversationSessionId === input.sessionId),
			);
			if (!existingQuestion || !exchange.resolution) continue;
			await resolveAgentRaisedUserQuestionFromAgentTerminal(input.workspaceId, {
				taskId: input.taskId,
				resolution: { ...exchange.resolution, decisionSourceId },
				resolvedAt: exchange.resolvedAt ?? exchange.askedAt,
				allowSupersededCodexAnswerRecoveryFromTranscript: true,
			});
		}
		const hasNewerQuestion = existing.some(
			(record) =>
				record.taskId === input.taskId &&
				record.decisionId !== `${input.taskId}:${latestSourceId}` &&
				record.askedAt > latest.askedAt,
		);
		if (!hasNewerQuestion) {
			const belongsToCurrentIncarnation = latest.askedAt >= (input.summary?.startedAt ?? Number.POSITIVE_INFINITY);
			await recordAgentRaisedPendingUserDecision(input.workspaceId, {
				workspaceId: input.workspaceId,
				taskId: input.taskId,
				agentId: "codex",
				sessionTransport: "pty_terminal",
				decisionId: `${input.taskId}:${latestSourceId}`,
				nativeConversationSessionId: input.sessionId,
				decisionKind: "ordinary_user_question",
				questionMarkdown: latest.payload.questionMarkdown,
				options: latest.payload.options,
				allowsFreeformAnswer: latest.payload.allowsFreeformAnswer,
				orderedQuestions: latest.payload.orderedQuestions,
				askedAt: latest.askedAt,
				graceDeadlineAt: input.summary?.agentSessionRuntimeReclamationEligibleAt ?? null,
				originRuntimeSessionIncarnationId:
					belongsToCurrentIncarnation && latest.resolution === null
						? (input.summary?.runtimeSessionIncarnationId ?? null)
						: null,
				originTurnSequence: input.summary?.agentResponseGenerationTurnSequence ?? 0,
				sourceHarnessSignal: "codex:request_user_input:transcript_salvage",
			});
			const resolution =
				latest.resolution ??
				(!belongsToCurrentIncarnation
					? {
							decisionSourceId: latest.payload.decisionSourceId,
							sourceAgentId: "codex" as const,
							nativeConversationSessionId: input.sessionId,
							resolutionKind: "interrupted_without_answer" as const,
							answersForQuestions: [],
						}
					: null);
			if (resolution)
				await resolveAgentRaisedUserQuestionFromAgentTerminal(input.workspaceId, {
					taskId: input.taskId,
					resolution: { ...resolution, decisionSourceId: latestSourceId },
					resolvedAt: latest.resolvedAt ?? latest.askedAt,
				});
			await supersedeEarlierCodexUserQuestionsFromTranscript(input.workspaceId, {
				taskId: input.taskId,
				nativeConversationSessionId: input.sessionId,
				latestDecisionId: `${input.taskId}:${latestSourceId}`,
				latestAskedAt: latest.askedAt,
			});
		}
	}
	return {
		historyEntries: buildCodexUserQuestionTranscriptHistoryEntries(
			input.taskId,
			recovered.exchanges.map((exchange) => ({
				...exchange,
				payload: { ...exchange.payload, decisionSourceId: sourceIdForExchange(exchange) },
			})),
		),
		transcriptRecoveryNotice:
			recovered.coverage === "complete"
				? null
				: "部分旧问答记录暂时无法完整读取；尚不能确认是否还有未答问题，请勿根据旧终端画面重复提交答案。",
	};
}
