import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, ChevronDown, ChevronUp, CircleHelp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { PendingUserDecisionQuestionAnswerDraft } from "@/hooks/use-agent-raised-pending-user-decision";
import type { RuntimeAgentRaisedPendingUserDecision } from "@/runtime/types";

export function AgentRaisedPendingUserDecisionPanel({
	decision,
	isSubmitting,
	onAnswer,
	onDismiss,
	agentResponseGenerationTurnSequence,
}: {
	decision: RuntimeAgentRaisedPendingUserDecision;
	isSubmitting: boolean;
	onAnswer: (answers: PendingUserDecisionQuestionAnswerDraft[]) => Promise<boolean>;
	onDismiss: () => Promise<boolean>;
	agentResponseGenerationTurnSequence: number;
}) {
	const [isExpanded, setIsExpanded] = useState(true);
	const initialAgentResponseGenerationTurnSequenceRef = useRef(agentResponseGenerationTurnSequence);
	const [selectedOptionIdsByQuestionId, setSelectedOptionIdsByQuestionId] = useState<Record<string, string[]>>({});
	const [freeformTextByQuestionId, setFreeformTextByQuestionId] = useState<Record<string, string>>({});
	const answers = useMemo(
		() =>
			decision.orderedQuestions.map((question) => ({
				decisionQuestionId: question.decisionQuestionId,
				selectedOptionIds: selectedOptionIdsByQuestionId[question.decisionQuestionId] ?? [],
				freeformText: freeformTextByQuestionId[question.decisionQuestionId]?.trim() || null,
			})),
		[decision.orderedQuestions, freeformTextByQuestionId, selectedOptionIdsByQuestionId],
	);

	useEffect(() => {
		// 用户绕过面板、直接在终端提交 prompt 时，hook 会先推进 turnSequence；问题仍保留在 durable
		// 账本中，但面板自动折叠，避免挡住正在继续的会话。恢复会话本身不推进序号，因此不会误折叠。
		if (agentResponseGenerationTurnSequence > initialAgentResponseGenerationTurnSequenceRef.current) {
			setIsExpanded(false);
		}
	}, [agentResponseGenerationTurnSequence]);

	return (
		<section className="shrink-0 border-b border-status-gold/30 bg-status-gold/5" aria-label="Agent 等待你的回答">
			<div className="flex items-center gap-2 px-3 py-2">
				<CircleHelp size={16} className="text-status-gold" />
				<button
					type="button"
					className="min-w-0 flex-1 cursor-pointer text-left text-xs font-medium text-text-primary"
					onClick={() => setIsExpanded((value) => !value)}
				>
					Agent 有一个尚未回答的问题
				</button>
				<Button
					variant="ghost"
					size="xs"
					icon={isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					onClick={() => setIsExpanded((value) => !value)}
					aria-label={isExpanded ? "折叠问题" : "展开问题"}
				/>
			</div>
			{isExpanded ? (
				<div className="max-h-[45vh] space-y-4 overflow-y-auto border-t border-status-gold/20 px-3 py-3">
					{decision.orderedQuestions.map((question, questionIndex) => {
						const selectedOptionIds = selectedOptionIdsByQuestionId[question.decisionQuestionId] ?? [];
						return (
							<fieldset key={question.decisionQuestionId} className="space-y-2">
								<legend className="text-xs font-medium text-text-primary">
									{question.headerMarkdown ? `${question.headerMarkdown} · ` : ""}
									{question.questionMarkdown}
								</legend>
								{question.selectionMode === "single" ? (
									<div className="space-y-1.5">
										{question.options.map((option) => (
											<label
												key={option.optionId}
												className="flex cursor-pointer items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs"
											>
												<input
													type="radio"
													name={`${decision.decisionId}:${question.decisionQuestionId}`}
													value={option.optionId}
													checked={selectedOptionIds[0] === option.optionId}
													onChange={() =>
														setSelectedOptionIdsByQuestionId((previous) => ({
															...previous,
															[question.decisionQuestionId]: [option.optionId],
														}))
													}
													className="mt-0.5 size-3.5 accent-accent"
												/>
												<span>
													<span className="text-text-primary">{option.label}</span>
													{option.description ? (
														<span className="ml-1 text-text-secondary">— {option.description}</span>
													) : null}
												</span>
											</label>
										))}
									</div>
								) : (
									<div className="space-y-1.5">
										{question.options.map((option) => {
											const checked = selectedOptionIds.includes(option.optionId);
											const checkboxId = `${decision.decisionId}-${question.decisionQuestionId}-${option.optionId}`;
											return (
												<label
													key={option.optionId}
													htmlFor={checkboxId}
													className="flex cursor-pointer items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs"
												>
													<Checkbox.Root
														id={checkboxId}
														checked={checked}
														onCheckedChange={(nextChecked) =>
															setSelectedOptionIdsByQuestionId((previous) => ({
																...previous,
																[question.decisionQuestionId]:
																	nextChecked === true
																		? [...selectedOptionIds, option.optionId]
																		: selectedOptionIds.filter((id) => id !== option.optionId),
															}))
														}
														className="mt-0.5 flex size-3.5 items-center justify-center rounded-sm border border-border-bright data-[state=checked]:border-accent data-[state=checked]:bg-accent"
													>
														<Checkbox.Indicator>
															<Check size={10} />
														</Checkbox.Indicator>
													</Checkbox.Root>
													<span>
														<span className="text-text-primary">{option.label}</span>
														{option.description ? (
															<span className="ml-1 text-text-secondary">— {option.description}</span>
														) : null}
													</span>
												</label>
											);
										})}
									</div>
								)}
								{question.allowsFreeformAnswer ? (
									<textarea
										value={freeformTextByQuestionId[question.decisionQuestionId] ?? ""}
										onChange={(event) =>
											setFreeformTextByQuestionId((previous) => ({
												...previous,
												[question.decisionQuestionId]: event.target.value,
											}))
										}
										placeholder={questionIndex === 0 ? "其他回答或补充说明" : "此问题的其他回答或补充说明"}
										className="min-h-14 w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary outline-none focus:border-focus"
									/>
								) : null}
							</fieldset>
						);
					})}
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							disabled={isSubmitting}
							onClick={() => void onDismiss()}
						>
							取消问题
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={isSubmitting}
							onClick={async () => {
								if (await onAnswer(answers)) setIsExpanded(false);
							}}
						>
							提交回答
						</Button>
					</div>
				</div>
			) : null}
		</section>
	);
}
