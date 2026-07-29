// 从 harness 的 hook stdin JSON 里挑出「agent 正在等你拍板」所需的**白名单**字段。
//
// 为什么单独成模块：CLI 侧已经解析了完整 hook payload，但发给 daemon 的只能是收窄后的结构
// （既是隐私边界，也避免把某个 harness 的私有形状固化成 Kanban 契约）。挑字段这件事本身是纯函数，
// 单独放出来才能用真实 payload fixture 锁定字段名。
//
// 隐私红线：工具授权只取工具名与参数**摘要**，绝不取参数正文；提问只取问题正文与选项文案。
import type {
	RuntimeAgentRaisedDecisionOption,
	RuntimeAgentRaisedToolPermissionPayload,
	RuntimeAgentRaisedUserQuestionPayload,
} from "../core/api-contract";

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

interface ParsedQuestion {
	header: string | null;
	question: string;
	multiSelect: boolean;
	options: Array<{ label: string; description: string | null }>;
}

// Claude 的 AskUserQuestion 工具输入形状：`{ questions: [{ question, header, multiSelect, options: [...] }] }`。
// 对字段缺失 / 类型不符一律跳过而不是抛错——hook payload 来自外部进程，宁可少采集也不能让
// 一次 hook 投递整体失败。
function parseQuestions(toolInput: Record<string, unknown>): ParsedQuestion[] {
	const rawQuestions = toolInput.questions;
	if (!Array.isArray(rawQuestions)) {
		return [];
	}
	const parsed: ParsedQuestion[] = [];
	for (const rawQuestion of rawQuestions) {
		const questionRecord = asRecord(rawQuestion);
		if (!questionRecord) {
			continue;
		}
		const question = asNonEmptyString(questionRecord.question);
		if (!question) {
			continue;
		}
		const rawOptions = Array.isArray(questionRecord.options) ? questionRecord.options : [];
		const options: ParsedQuestion["options"] = [];
		for (const rawOption of rawOptions) {
			const optionRecord = asRecord(rawOption);
			const label = optionRecord ? asNonEmptyString(optionRecord.label) : null;
			if (!label) {
				continue;
			}
			options.push({ label, description: optionRecord ? asNonEmptyString(optionRecord.description) : null });
		}
		parsed.push({
			header: asNonEmptyString(questionRecord.header),
			question,
			multiSelect: questionRecord.multiSelect === true,
			options,
		});
	}
	return parsed;
}

function renderQuestionMarkdown(questions: readonly ParsedQuestion[]): string {
	if (questions.length === 1) {
		const only = questions[0] as ParsedQuestion;
		return only.header ? `**${only.header}**\n\n${only.question}` : only.question;
	}
	// 多问一次性提出时，把「哪个选项属于哪一问」渲进正文——否则扁平化的选项列表会丢掉归属关系。
	return questions
		.map((entry, index) => {
			const heading = entry.header
				? `${index + 1}. **${entry.header}** — ${entry.question}`
				: `${index + 1}. ${entry.question}`;
			const optionLines = entry.options.map((option) =>
				option.description ? `   - ${option.label}：${option.description}` : `   - ${option.label}`,
			);
			return [heading, ...optionLines].join("\n");
		})
		.join("\n\n");
}

/**
 * 从 AskUserQuestion 的工具输入构造待答提问 payload。
 *
 * 单问 → 结构化选项，用户点选即可。
 * 多问 → 选项归属关系无法用一个扁平列表表达，故把全部问题与选项渲进正文、清空结构化选项、
 *        并允许自由文本作答。这是刻意的「宁可如实降级，也不丢信息」。
 */
export function extractAgentRaisedUserQuestionPayload(input: {
	toolUseId: string | null;
	toolInput: Record<string, unknown> | null;
}): RuntimeAgentRaisedUserQuestionPayload | null {
	if (!input.toolInput) {
		return null;
	}
	const questions = parseQuestions(input.toolInput);
	if (questions.length === 0) {
		return null;
	}
	const decisionSourceId = input.toolUseId ?? `ask-user-question:${renderQuestionMarkdown(questions).slice(0, 120)}`;
	const isSingleQuestion = questions.length === 1;
	const singleQuestion = questions[0] as ParsedQuestion;
	const options: RuntimeAgentRaisedDecisionOption[] = isSingleQuestion
		? singleQuestion.options.map((option, index) => ({
				optionId: `option-${index}`,
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			}))
		: [];
	return {
		decisionSourceId,
		questionMarkdown: renderQuestionMarkdown(questions),
		options,
		// AskUserQuestion 总是允许「其他」自由输入；多问降级时更是只能靠自由文本作答。
		allowsFreeformAnswer: true,
		multiSelect: isSingleQuestion ? singleQuestion.multiSelect : false,
	};
}

/**
 * 从权限请求 hook 构造工具授权 payload。只取工具名与已经压过的参数摘要——
 * 参数正文可能含命令行 / 路径 / 密钥，绝不落盘。
 */
export function extractAgentRaisedToolPermissionPayload(input: {
	toolUseId: string | null;
	toolName: string | null;
	toolInputSummary: string | null;
}): RuntimeAgentRaisedToolPermissionPayload | null {
	const toolName = asNonEmptyString(input.toolName);
	if (!toolName) {
		return null;
	}
	return {
		decisionSourceId: input.toolUseId ?? `tool-permission:${toolName}`,
		toolName,
		toolInputSummary: asNonEmptyString(input.toolInputSummary),
	};
}
