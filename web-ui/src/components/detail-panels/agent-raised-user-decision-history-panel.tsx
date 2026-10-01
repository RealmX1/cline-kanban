import { ChevronDown, ChevronUp, History, RotateCw } from "lucide-react";
import { type ReactElement, useState } from "react";

import { AgentRaisedUserDecisionQuestionPrompt } from "@/components/detail-panels/agent-raised-user-decision-question-content";
import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { Button } from "@/components/ui/button";
import { useAgentRaisedUserDecisionHistory } from "@/hooks/use-agent-raised-user-decision-history";
import type {
	RuntimeAgentRaisedUserDecisionHistoryEntry,
	RuntimeAgentRaisedUserDecisionHistoryResolution,
} from "@/runtime/types";
import { preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks } from "@/utils/preserve-agent-authored-line-breaks-as-markdown-hard-breaks";

// 问答记录：agent 问过什么、你怎么答的、补充了什么、在哪答的、有没有送达。
// 存在意义见 src/agent-session-history/agent-raised-user-decision-history-builder.ts 文件头。

const HISTORY_RESOLUTION_LABEL: Record<RuntimeAgentRaisedUserDecisionHistoryResolution, string> = {
	answered_in_kanban_panel: "在面板作答",
	answered_in_agent_terminal: "在终端作答",
	declined_in_agent_terminal: "在终端拒答",
	dismissed_in_kanban_panel: "在面板取消",
	cancelled_by_agent_session_transport_switch: "切换 agent 通道时自动取消",
	superseded_by_later_question_without_answer: "未作答，被新问题取代",
};

const HISTORY_RESOLUTION_TONE_CLASS: Record<RuntimeAgentRaisedUserDecisionHistoryResolution, string> = {
	answered_in_kanban_panel: "bg-status-green/10 text-status-green",
	answered_in_agent_terminal: "bg-status-green/10 text-status-green",
	declined_in_agent_terminal: "bg-surface-2 text-text-secondary",
	dismissed_in_kanban_panel: "bg-surface-2 text-text-secondary",
	cancelled_by_agent_session_transport_switch: "bg-surface-2 text-text-secondary",
	superseded_by_later_question_without_answer: "bg-surface-2 text-text-secondary",
};

function describeAnswerDeliveryState(
	answerDeliveryState: RuntimeAgentRaisedUserDecisionHistoryEntry["answerDeliveryState"],
): string | null {
	switch (answerDeliveryState) {
		case "delivered":
			return "已送达 agent";
		case "delivery_failed":
			return "未送达 agent";
		case "answer_recorded":
		case "delivery_in_progress":
			return "投递中";
		default:
			return null;
	}
}

function AgentRaisedUserDecisionHistoryEntryCard({
	entry,
}: {
	entry: RuntimeAgentRaisedUserDecisionHistoryEntry;
}): ReactElement {
	const [isQuestionBodyExpanded, setIsQuestionBodyExpanded] = useState(false);
	const deliveryDescription = describeAnswerDeliveryState(entry.answerDeliveryState);
	return (
		<article className="space-y-2 rounded-md border border-border bg-surface-1 px-2.5 py-2">
			<header className="flex flex-wrap items-center gap-1.5 text-[11px]">
				<span className={`rounded px-1.5 py-0.5 font-medium ${HISTORY_RESOLUTION_TONE_CLASS[entry.resolution]}`}>
					{HISTORY_RESOLUTION_LABEL[entry.resolution]}
				</span>
				{deliveryDescription ? (
					<span
						className={
							entry.answerDeliveryState === "delivery_failed" ? "text-status-red" : "text-text-secondary"
						}
					>
						{deliveryDescription}
					</span>
				) : null}
				<span className="text-text-tertiary">提问于 {new Date(entry.askedAt).toLocaleString()}</span>
				{entry.recordSource === "agent_conversation_transcript" ? (
					<span className="text-text-tertiary">· 来自会话转录</span>
				) : null}
			</header>
			{entry.orderedQuestions.map((question, questionIndex) => {
				const questionAnswer = entry.questionAnswers.find(
					(candidate) => candidate.decisionQuestionId === question.decisionQuestionId,
				);
				return (
					<div key={question.decisionQuestionId} className="min-w-0 space-y-1.5">
						<div className={isQuestionBodyExpanded ? undefined : "max-h-24 overflow-hidden"}>
							<AgentRaisedUserDecisionQuestionPrompt
								question={question}
								questionIndex={questionIndex}
								questionCount={entry.orderedQuestions.length}
							/>
						</div>
						{questionAnswer ? (
							<dl className="space-y-1 rounded-md bg-surface-2 px-2 py-1.5 text-xs text-text-primary">
								{questionAnswer.selectedOptionLabels.length > 0 ? (
									<div className="flex gap-1.5">
										<dt className="shrink-0 text-text-secondary">选择</dt>
										<dd className="min-w-0 font-medium">{questionAnswer.selectedOptionLabels.join("、")}</dd>
									</div>
								) : null}
								{questionAnswer.freeformAnswerText ? (
									<div className="flex gap-1.5">
										<dt className="shrink-0 text-text-secondary">回答</dt>
										<dd className="min-w-0 whitespace-pre-wrap">{questionAnswer.freeformAnswerText}</dd>
									</div>
								) : null}
								{questionAnswer.notesText ? (
									<div className="flex gap-1.5">
										<dt className="shrink-0 text-text-secondary">备注</dt>
										<dd className="min-w-0">
											<ClineMarkdownContent
												content={preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks(
													questionAnswer.notesText,
												)}
											/>
										</dd>
									</div>
								) : null}
								{questionAnswer.selectedOptionLabels.length === 0 &&
								!questionAnswer.freeformAnswerText &&
								!questionAnswer.notesText ? (
									<div className="text-text-secondary">此问未作答</div>
								) : null}
							</dl>
						) : null}
					</div>
				);
			})}
			<button
				type="button"
				className="cursor-pointer text-[11px] text-accent-2 hover:underline"
				onClick={() => setIsQuestionBodyExpanded((value) => !value)}
			>
				{isQuestionBodyExpanded ? "收起题干" : "展开完整题干"}
			</button>
		</article>
	);
}

export function AgentRaisedUserDecisionHistoryPanel({
	workspaceId,
	taskId,
	pendingUserDecisionIdentityForRefresh,
}: {
	workspaceId: string | null;
	taskId: string;
	pendingUserDecisionIdentityForRefresh: string | null;
}): ReactElement {
	const [isHistoryVisible, setIsHistoryVisible] = useState(false);
	const { historyEntries, isLoading, refresh } = useAgentRaisedUserDecisionHistory({
		workspaceId,
		taskId,
		isHistoryVisible,
		pendingUserDecisionIdentityForRefresh,
	});
	return (
		<section className="shrink-0 border-b border-border" aria-label="问答记录">
			<div className="flex items-center gap-2 px-3 py-1">
				<History size={14} className="shrink-0 text-text-secondary" />
				<button
					type="button"
					className="min-w-0 flex-1 cursor-pointer text-left text-[11px] text-text-secondary hover:text-text-primary"
					onClick={() => setIsHistoryVisible((value) => !value)}
				>
					问答记录{historyEntries ? `（${historyEntries.length}）` : ""}
				</button>
				{isHistoryVisible ? (
					<Button
						variant="ghost"
						size="xs"
						icon={<RotateCw size={12} />}
						disabled={isLoading}
						onClick={() => void refresh()}
						aria-label="刷新问答记录"
					/>
				) : null}
				<Button
					variant="ghost"
					size="xs"
					icon={isHistoryVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					onClick={() => setIsHistoryVisible((value) => !value)}
					aria-label={isHistoryVisible ? "收起问答记录" : "展开问答记录"}
				/>
			</div>
			{isHistoryVisible ? (
				<div className="max-h-[50vh] space-y-2 overflow-y-auto border-t border-border px-3 py-2">
					{historyEntries === null ? (
						<p className="text-xs text-text-secondary">正在读取问答记录…</p>
					) : historyEntries.length === 0 ? (
						<p className="text-xs text-text-secondary">这个任务里还没有已了结的 agent 提问。</p>
					) : (
						historyEntries.map((entry) => (
							<AgentRaisedUserDecisionHistoryEntryCard key={entry.historyEntryId} entry={entry} />
						))
					)}
				</div>
			) : null}
		</section>
	);
}
