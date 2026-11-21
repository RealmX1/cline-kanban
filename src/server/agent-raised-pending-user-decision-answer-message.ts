import {
	type AgentRaisedPendingUserDecisionAnswer,
	type AgentRaisedPendingUserDecisionAnswerDeliveryAttempt,
	type PersistedAgentRaisedPendingUserDecision,
	resolveAgentRaisedPendingUserDecisionOrderedQuestions,
} from "../state/agent-raised-pending-user-decision-store";

// 投递给 agent 的正文。刻意把**原问题**也带上：会话可能已经被回收重启，新活体并不知道
// 「你刚才问了什么」，只发一句「我选 B」它无从对应。
// 开头措辞必须对两种投递情形都成立：会话已被回收 / 重启后恢复；或会话仍活着、为投递先用 Esc 关掉了
// 终端里的选择器（此时原工具调用被记为拒绝）。两种情形下原 AskUserQuestion 都没有正式的作答结果。
export function buildAgentRaisedPendingUserDecisionAnswerMessage(
	decision: PersistedAgentRaisedPendingUserDecision,
	answer: AgentRaisedPendingUserDecisionAnswer,
	deliveryAttempt:
		| Pick<
				AgentRaisedPendingUserDecisionAnswerDeliveryAttempt,
				"answerMessageFormatVersion" | "dispatchIdempotencyKey"
		  >
		| undefined = decision.answerDeliveryAttempts?.at(-1),
): string {
	const lines = [
		"这是用户在 Cline Kanban 面板中对你先前提出的待答问题给出的答复。",
		"原提问工具调用已被中断或记为拒绝，没有正式的作答结果——请以这里为准，不要重新提问。",
		"",
		"以下逐项重述你当时提出的全部问题、全部选项及用户答案。",
	];
	if (deliveryAttempt?.answerMessageFormatVersion === 2)
		lines.push(`答案投递标识：${deliveryAttempt.dispatchIdempotencyKey}`);
	const orderedQuestions = resolveAgentRaisedPendingUserDecisionOrderedQuestions(decision);
	for (const [questionIndex, question] of orderedQuestions.entries()) {
		const questionAnswer = answer.orderedQuestionAnswers?.find(
			(candidate) => candidate.decisionQuestionId === question.decisionQuestionId,
		);
		const selectedOptionIds =
			questionAnswer?.selectedOptionIds ?? (questionIndex === 0 ? answer.selectedOptionIds : []);
		const freeformText = (questionAnswer?.freeformText ?? (questionIndex === 0 ? answer.freeformText : null))?.trim();
		lines.push("", `问题 ${questionIndex + 1}${question.headerMarkdown ? `（${question.headerMarkdown}）` : ""}：`);
		lines.push(
			question.questionMarkdown,
			"",
			`全部选项（${question.selectionMode === "multiple" ? "多选" : "单选"}）：`,
		);
		for (const option of question.options) {
			lines.push(`- [${option.optionId}] ${option.label}${option.description ? ` — ${option.description}` : ""}`);
		}
		const selectedLabels = selectedOptionIds.map((optionId) => {
			const structuredQuestionOptionLabel = question.options.find((option) => option.optionId === optionId)?.label;
			if (structuredQuestionOptionLabel !== undefined) {
				return structuredQuestionOptionLabel;
			}
			// 旧客户端只提交顶层 selectedOptionIds；AskUserQuestion 的单问 payload 曾让顶层选项使用
			// `option-N`、orderedQuestions[0] 使用 `question-0-option-N`。首问在结构化 ID 未命中时
			// 回退顶层选项，确保恢复投递给 agent 的仍是人类可读标签。
			return questionAnswer === undefined && questionIndex === 0
				? (decision.options.find((option) => option.optionId === optionId)?.label ?? optionId)
				: optionId;
		});
		if (selectedLabels.length > 0) {
			lines.push("", `用户选择：${selectedLabels.join("、")}`);
		}
		if (freeformText) {
			lines.push(selectedLabels.length > 0 ? `用户补充：${freeformText}` : `用户自由回答：${freeformText}`);
		}
		if (selectedLabels.length === 0 && !freeformText) {
			lines.push("", "我没有选择任何选项，也未填写自由回答。");
		}
	}
	lines.push("", "请仅在以上用户答复的基础上继续先前工作。");
	return lines.join("\n");
}
