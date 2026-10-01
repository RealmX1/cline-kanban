import type { ReactElement } from "react";

import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import type { RuntimeAgentRaisedDecisionOption, RuntimeAgentRaisedDecisionQuestion } from "@/runtime/types";
import { preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks } from "@/utils/preserve-agent-authored-line-breaks-as-markdown-hard-breaks";

// agent 提问的正文与选项说明都是 markdown（加粗、列表、代码、换行），此前被塞进 <legend> / 行内 <span>
// 当纯文本渲染，换行被折叠、列表被压成一行，整道题读起来就是一长串。这里统一按 markdown 块渲染，
// 面板作答与问答记录共用同一套呈现，避免两处各自漂移。

export function AgentRaisedUserDecisionQuestionPrompt({
	question,
	questionIndex,
	questionCount,
}: {
	question: RuntimeAgentRaisedDecisionQuestion;
	questionIndex: number;
	questionCount: number;
}): ReactElement {
	return (
		<div className="min-w-0 space-y-1">
			{question.headerMarkdown || questionCount > 1 ? (
				<div className="flex items-center gap-1.5 text-[11px] font-medium text-status-gold">
					{questionCount > 1 ? <span>问题 {questionIndex + 1}</span> : null}
					{question.headerMarkdown ? (
						<span className="rounded bg-status-gold/10 px-1.5 py-0.5 text-text-primary">
							{question.headerMarkdown}
						</span>
					) : null}
				</div>
			) : null}
			<ClineMarkdownContent
				content={preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks(question.questionMarkdown)}
			/>
		</div>
	);
}

export function AgentRaisedUserDecisionOptionText({
	option,
}: {
	option: RuntimeAgentRaisedDecisionOption;
}): ReactElement {
	return (
		<span className="block min-w-0 flex-1 space-y-1">
			<span className="block text-sm font-medium text-text-primary">{option.label}</span>
			{option.description ? (
				<span className="block text-text-secondary">
					<ClineMarkdownContent
						content={preserveAgentAuthoredLineBreaksAsMarkdownHardBreaks(option.description)}
					/>
				</span>
			) : null}
		</span>
	);
}

// preview 常是等宽对比矩阵：必须保留行首空白与列对齐，横向超宽时滚动而不是折行。
export function AgentRaisedUserDecisionOptionPreview({ previewText }: { previewText: string }): ReactElement {
	return (
		<figure aria-label="选项预览" className="m-0">
			<pre className="max-h-60 overflow-auto rounded-md border border-border bg-surface-1 px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre text-text-primary">
				{previewText}
			</pre>
		</figure>
	);
}
