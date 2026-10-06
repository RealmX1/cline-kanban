import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, ChevronDown, ChevronUp, CircleHelp, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
	AgentRaisedUserDecisionOptionPreview,
	AgentRaisedUserDecisionOptionText,
	AgentRaisedUserDecisionQuestionPrompt,
} from "@/components/detail-panels/agent-raised-user-decision-question-content";
import { Button } from "@/components/ui/button";
import type { PendingUserDecisionQuestionAnswerDraft } from "@/hooks/use-agent-raised-pending-user-decision";
import { useAgentRaisedPendingUserDecisionAnswerDraft } from "@/hooks/use-agent-raised-pending-user-decision-answer-draft";
import type { RuntimeAgentRaisedPendingUserDecision } from "@/runtime/types";

// 调用方必须以 workspace + task + decision 作为 key 挂载本组件：草稿选择、展开状态属于「这一次提问」，
// 换了问题就该从头开始，而不是把上一题勾选的选项 id 带进新题。
export function AgentRaisedPendingUserDecisionPanel({
	workspaceId,
	decision,
	isSubmitting,
	onAnswer,
	onDismiss,
	agentResponseGenerationTurnSequence,
	isAgentStoppedOnThisQuestionSelectorInLiveTerminal,
	isQuestionRaisedByEarlierAgentSessionIncarnation,
	onDecisionNoLongerPending,
}: {
	workspaceId: string | null;
	decision: RuntimeAgentRaisedPendingUserDecision;
	isSubmitting: boolean;
	onAnswer: (answers: PendingUserDecisionQuestionAnswerDraft[]) => Promise<boolean>;
	onDismiss: () => Promise<boolean>;
	agentResponseGenerationTurnSequence: number;
	// agent 此刻正停在终端里这道题的交互式选择器上：默认在终端作答，面板折叠但可手动展开作答。
	isAgentStoppedOnThisQuestionSelectorInLiveTerminal: boolean;
	// 提问它的会话活体已不是当前活体（Kanban / 系统重启后 resume、会话被回收后重建），或来源不明（转录补录）：
	// 选择器早已不在而问题仍未回答——这是用户必须回来处理的时刻，面板主动弹出。
	// 刻意**不**用「选择器从在线变为不在线」触发：用户在同一会话里拒答后继续工作时它同样成立，
	// 那时弹出面板只会打断人（Claude 的终端拒答不触发任何 hook，账本无从得知这次拒答）。
	isQuestionRaisedByEarlierAgentSessionIncarnation: boolean;
	onDecisionNoLongerPending?: () => void;
}) {
	const [isExpanded, setIsExpanded] = useState(!isAgentStoppedOnThisQuestionSelectorInLiveTerminal);
	const initialAgentResponseGenerationTurnSequenceRef = useRef(agentResponseGenerationTurnSequence);
	const { questionAnswerDrafts, updateQuestionAnswerDraft, discardAnswerDraft, draftSaveStatusText } =
		useAgentRaisedPendingUserDecisionAnswerDraft({ workspaceId, decision, onDecisionNoLongerPending });
	const answerIsRecordedButNotYetDelivered = decision.recordedAnswerQuestionAnswers !== null;
	const answers = useMemo(
		() =>
			decision.orderedQuestions.map((question) => ({
				decisionQuestionId: question.decisionQuestionId,
				selectedOptionIds:
					questionAnswerDrafts.find((answer) => answer.decisionQuestionId === question.decisionQuestionId)
						?.selectedOptionIds ?? [],
				freeformText:
					questionAnswerDrafts
						.find((answer) => answer.decisionQuestionId === question.decisionQuestionId)
						?.freeformText?.trim() || null,
			})),
		[decision.orderedQuestions, questionAnswerDrafts],
	);

	useEffect(() => {
		// 用户绕过面板、直接在终端提交 prompt 时，hook 会先推进 turnSequence；问题仍保留在 durable
		// 账本中，但面板自动折叠，避免挡住正在继续的会话。恢复会话本身不推进序号，因此不会误折叠。
		if (agentResponseGenerationTurnSequence > initialAgentResponseGenerationTurnSequenceRef.current) {
			setIsExpanded(false);
		}
	}, [agentResponseGenerationTurnSequence]);

	const wasRaisedByEarlierAgentSessionIncarnationRef = useRef(isQuestionRaisedByEarlierAgentSessionIncarnation);
	useEffect(() => {
		if (!wasRaisedByEarlierAgentSessionIncarnationRef.current && isQuestionRaisedByEarlierAgentSessionIncarnation) {
			setIsExpanded(true);
		}
		wasRaisedByEarlierAgentSessionIncarnationRef.current = isQuestionRaisedByEarlierAgentSessionIncarnation;
	}, [isQuestionRaisedByEarlierAgentSessionIncarnation]);

	// 面板可能先于会话 summary 挂载（或先于 summary 推进到提问回合）：那一刻「选择器在终端上」被算成 false，
	// 面板以展开态出现。之后 summary 到达、确认选择器其实就在当前活体终端上时，收回到默认折叠，
	// 让「可在终端作答」的引导露出来。用户已手动展开 / 折叠过就不再替人收回。
	const hasUserManuallyToggledPendingUserDecisionPanelExpansionRef = useRef(false);
	const wasAgentStoppedOnThisQuestionSelectorInLiveTerminalRef = useRef(
		isAgentStoppedOnThisQuestionSelectorInLiveTerminal,
	);
	useEffect(() => {
		if (
			!wasAgentStoppedOnThisQuestionSelectorInLiveTerminalRef.current &&
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal &&
			!hasUserManuallyToggledPendingUserDecisionPanelExpansionRef.current
		) {
			setIsExpanded(false);
		}
		wasAgentStoppedOnThisQuestionSelectorInLiveTerminalRef.current =
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal;
	}, [isAgentStoppedOnThisQuestionSelectorInLiveTerminal]);
	const toggleExpansionByUserAndStopAutomaticCollapse = () => {
		hasUserManuallyToggledPendingUserDecisionPanelExpansionRef.current = true;
		setIsExpanded((value) => !value);
	};

	const headerTitle = answerIsRecordedButNotYetDelivered
		? "答案已保存，尚未送达 agent"
		: isAgentStoppedOnThisQuestionSelectorInLiveTerminal
			? "Agent 正在终端里等你回答一个问题"
			: "Agent 有一个尚未回答的问题";
	const headerHint =
		!answerIsRecordedButNotYetDelivered && isAgentStoppedOnThisQuestionSelectorInLiveTerminal && !isExpanded
			? "可直接在终端作答，或展开在此作答"
			: null;

	return (
		<section className="shrink-0 border-b border-status-gold/30 bg-status-gold/5" aria-label="Agent 等待你的回答">
			<div className="flex items-center gap-2 px-3 py-2">
				<CircleHelp size={16} className="shrink-0 text-status-gold" />
				<button
					type="button"
					className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 text-left"
					onClick={toggleExpansionByUserAndStopAutomaticCollapse}
				>
					<span className="truncate text-xs font-medium text-text-primary">{headerTitle}</span>
					{headerHint ? <span className="truncate text-[11px] text-text-secondary">{headerHint}</span> : null}
				</button>
				<Button
					variant="ghost"
					size="xs"
					icon={isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					onClick={toggleExpansionByUserAndStopAutomaticCollapse}
					aria-label={isExpanded ? "折叠问题" : "展开问题"}
				/>
			</div>
			{isExpanded ? (
				<div className="max-h-[55vh] space-y-4 overflow-y-auto border-t border-status-gold/20 px-3 py-3">
					{answerIsRecordedButNotYetDelivered ? (
						<RecordedAnswerAwaitingDelivery
							decision={decision}
							isSubmitting={isSubmitting}
							onRetryDelivery={() => onAnswer(decision.recordedAnswerQuestionAnswers ?? [])}
						/>
					) : (
						<>
							{decision.orderedQuestions.map((question, questionIndex) => {
								const questionAnswerDraft = questionAnswerDrafts.find(
									(answer) => answer.decisionQuestionId === question.decisionQuestionId,
								);
								const selectedOptionIds = questionAnswerDraft?.selectedOptionIds ?? [];
								const selectedOptionWithPreview = question.options.find(
									(option) => selectedOptionIds.includes(option.optionId) && option.previewText,
								);
								return (
									<fieldset key={question.decisionQuestionId} className="min-w-0 space-y-2">
										<legend className="sr-only">
											{question.headerMarkdown ? `${question.headerMarkdown}：` : ""}
											{question.questionMarkdown}
										</legend>
										<AgentRaisedUserDecisionQuestionPrompt
											question={question}
											questionIndex={questionIndex}
											questionCount={decision.orderedQuestions.length}
										/>
										<div className="space-y-1.5">
											{question.options.map((option) => {
												const optionInputId = `${decision.decisionId}-${question.decisionQuestionId}-${option.optionId}`;
												const checked = selectedOptionIds.includes(option.optionId);
												return (
													<label
														key={option.optionId}
														htmlFor={optionInputId}
														className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 ${
															checked ? "border-accent bg-surface-2" : "border-transparent bg-surface-2"
														}`}
													>
														{question.selectionMode === "single" ? (
															<input
																id={optionInputId}
																type="radio"
																name={`${decision.decisionId}:${question.decisionQuestionId}`}
																value={option.optionId}
																checked={checked}
																onChange={() =>
																	updateQuestionAnswerDraft(question.decisionQuestionId, {
																		selectedOptionIds: [option.optionId],
																	})
																}
																className="mt-1 size-3.5 shrink-0 accent-accent"
															/>
														) : (
															<Checkbox.Root
																id={optionInputId}
																checked={checked}
																onCheckedChange={(nextChecked) =>
																	updateQuestionAnswerDraft(question.decisionQuestionId, {
																		selectedOptionIds:
																			nextChecked === true
																				? [...selectedOptionIds, option.optionId]
																				: selectedOptionIds.filter((id) => id !== option.optionId),
																	})
																}
																className="mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-border-bright data-[state=checked]:border-accent data-[state=checked]:bg-accent"
															>
																<Checkbox.Indicator>
																	<Check size={10} />
																</Checkbox.Indicator>
															</Checkbox.Root>
														)}
														<AgentRaisedUserDecisionOptionText option={option} />
													</label>
												);
											})}
										</div>
										{selectedOptionWithPreview?.previewText ? (
											<AgentRaisedUserDecisionOptionPreview
												previewText={selectedOptionWithPreview.previewText}
											/>
										) : null}
										{question.allowsFreeformAnswer ? (
											<textarea
												value={questionAnswerDraft?.freeformText ?? ""}
												onChange={(event) =>
													updateQuestionAnswerDraft(question.decisionQuestionId, {
														freeformText: event.target.value,
													})
												}
												placeholder={
													questionIndex === 0 ? "其他回答或补充说明" : "此问题的其他回答或补充说明"
												}
												className="min-h-14 w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary outline-none focus:border-focus"
											/>
										) : null}
									</fieldset>
								);
							})}
							{isAgentStoppedOnThisQuestionSelectorInLiveTerminal ? (
								<p className="text-[11px] text-text-secondary">
									提交后会先在终端里按 Esc 关闭提问选择器，再把你的答案作为一条消息发给 agent。
								</p>
							) : null}
							<div className="flex justify-end gap-2">
								{draftSaveStatusText ? (
									<span role="status" className="mr-auto self-center text-[11px] text-text-secondary">
										{draftSaveStatusText}
									</span>
								) : null}
								<Button
									variant="ghost"
									size="sm"
									icon={<X size={14} />}
									disabled={isSubmitting}
									onClick={async () => {
										if (await onDismiss()) discardAnswerDraft();
									}}
								>
									取消问题
								</Button>
								<Button
									variant="primary"
									size="sm"
									disabled={isSubmitting}
									onClick={async () => {
										if (await onAnswer(answers)) {
											discardAnswerDraft();
											setIsExpanded(false);
										}
									}}
								>
									提交回答
								</Button>
							</div>
						</>
					)}
				</div>
			) : null}
		</section>
	);
}

// 答案已 durable 记下但没送达：如实回显用户答了什么、卡在哪，并给一个明确的重试入口。
// 账本不允许覆盖已记下的答案（防止重复投递两份不同答案），所以这里只读、不给改。
function RecordedAnswerAwaitingDelivery({
	decision,
	isSubmitting,
	onRetryDelivery,
}: {
	decision: RuntimeAgentRaisedPendingUserDecision;
	isSubmitting: boolean;
	onRetryDelivery: () => Promise<boolean>;
}) {
	return (
		<div className="space-y-3">
			{decision.orderedQuestions.map((question, questionIndex) => {
				const recordedAnswer = decision.recordedAnswerQuestionAnswers?.find(
					(candidate) => candidate.decisionQuestionId === question.decisionQuestionId,
				);
				const selectedLabels = (recordedAnswer?.selectedOptionIds ?? []).map(
					(optionId) => question.options.find((option) => option.optionId === optionId)?.label ?? optionId,
				);
				return (
					<div key={question.decisionQuestionId} className="min-w-0 space-y-1.5">
						<AgentRaisedUserDecisionQuestionPrompt
							question={question}
							questionIndex={questionIndex}
							questionCount={decision.orderedQuestions.length}
						/>
						<div className="rounded-md bg-surface-2 px-2 py-1.5 text-xs text-text-primary">
							{selectedLabels.length > 0 ? <div>你的选择：{selectedLabels.join("、")}</div> : null}
							{recordedAnswer?.freeformText ? (
								<div className="whitespace-pre-wrap">补充说明：{recordedAnswer.freeformText}</div>
							) : null}
							{selectedLabels.length === 0 && !recordedAnswer?.freeformText ? (
								<div className="text-text-secondary">未选择任何选项，也未填写补充说明</div>
							) : null}
						</div>
					</div>
				);
			})}
			<p className="text-[11px] text-status-red">
				未送达原因：{decision.lastAnswerDeliveryFailureReason ?? "投递尚未完成"}
			</p>
			<div className="flex justify-end">
				<Button
					variant="primary"
					size="sm"
					icon={<RotateCw size={14} />}
					disabled={isSubmitting}
					onClick={() => void onRetryDelivery()}
				>
					重试投递
				</Button>
			</div>
		</div>
	);
}
