// 解析用户在 agent 终端里对 AskUserQuestion 作答后 harness 回传的原文答案。
//
// Claude 把多选答案里选中的各个标签以「, 」拼接成一串回传，「Other」里手打的文字也混在同一串里。
// 标签本身可能含「, 」（例如「读写分离, 带缓存」），所以不能直接按「, 」切开逐段匹配——那会把这种标签
// 拆碎，一部分误当成自由回答。这里按「, 」切成片段后，从左到右每次尝试拼出**最长**的已知标签，
// 拼不出任何标签的片段才归入自由回答。
//
// 账本写入（终端作答了结时把答案映射成 optionId）与问答记录展示（重新解析已落盘的原文）共用本函数，
// 保证同一个答案在两处得到同一个结论。

const AGENT_TERMINAL_MULTI_SELECT_ANSWER_LABEL_SEPARATOR = ", ";

export interface AgentTerminalAnswerTextSplitIntoSelectedOptionLabelsAndFreeformAnswerText {
	// 按在答案原文中出现的顺序。
	selectedOptionLabels: string[];
	// 对不上任何选项标签的剩余文字；没有则为 null。
	freeformAnswerText: string | null;
}

export function splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
	answerText: string,
	knownOptionLabels: readonly string[],
): AgentTerminalAnswerTextSplitIntoSelectedOptionLabelsAndFreeformAnswerText {
	const knownOptionLabelSet = new Set(knownOptionLabels);
	const answerTextParts = answerText.split(AGENT_TERMINAL_MULTI_SELECT_ANSWER_LABEL_SEPARATOR);
	const selectedOptionLabels: string[] = [];
	const unmatchedAnswerTextParts: string[] = [];
	let partIndex = 0;
	while (partIndex < answerTextParts.length) {
		let matchedPartEndIndexExclusive = -1;
		for (
			let candidateEndIndexExclusive = answerTextParts.length;
			candidateEndIndexExclusive > partIndex;
			candidateEndIndexExclusive -= 1
		) {
			const candidateLabel = answerTextParts
				.slice(partIndex, candidateEndIndexExclusive)
				.join(AGENT_TERMINAL_MULTI_SELECT_ANSWER_LABEL_SEPARATOR)
				.trim();
			if (knownOptionLabelSet.has(candidateLabel)) {
				selectedOptionLabels.push(candidateLabel);
				matchedPartEndIndexExclusive = candidateEndIndexExclusive;
				break;
			}
		}
		if (matchedPartEndIndexExclusive === -1) {
			unmatchedAnswerTextParts.push(answerTextParts[partIndex] ?? "");
			partIndex += 1;
		} else {
			partIndex = matchedPartEndIndexExclusive;
		}
	}
	const freeformAnswerText = unmatchedAnswerTextParts.join(AGENT_TERMINAL_MULTI_SELECT_ANSWER_LABEL_SEPARATOR).trim();
	return { selectedOptionLabels, freeformAnswerText: freeformAnswerText.length > 0 ? freeformAnswerText : null };
}
