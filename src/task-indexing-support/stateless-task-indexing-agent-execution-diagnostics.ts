import type { TaskAssistanceModelProviderAttempt } from "../core/task-assistance-model-provider-routing-contract";

/** 诊断只保留限长、脱敏后的错误，不留输入材料和推理正文。 */
export function sanitizeStatelessAgentFailureDetail(text: string, inputMaterialTexts: readonly string[] = []): string {
	let sanitized = text;
	// 完整输入与 JSON 转义回显必须先清理；提前截断会破坏匹配，留下问题或任务材料的片段。
	const inputMaterialRepresentations = new Set(
		inputMaterialTexts.filter(Boolean).flatMap((material) => [material, JSON.stringify(material).slice(1, -1)]),
	);
	for (const material of [...inputMaterialRepresentations].sort((left, right) => right.length - left.length))
		sanitized = sanitized.replaceAll(material, "[输入材料已隐藏]");
	sanitized = sanitized
		.replace(/(Bearer\s+)[^\s"']+/giu, "$1[已隐藏]")
		// 转义日志中的凭据值边界可能被再次编码；从敏感字段起保守隐藏，避免仅删去值的前半段。
		.replace(
			/(\\+["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\\+["']\s*[=:]\s*)[\s\S]*/giu,
			"$1[已隐藏]",
		)
		.replace(
			/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/giu,
			"$1[已隐藏]",
		)
		.replace(/\bsk-[a-zA-Z0-9_-]{8,}/gu, "[已隐藏]");
	for (const [name, value] of Object.entries(process.env)) {
		if (value && value.length >= 4 && /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/u.test(name))
			sanitized = sanitized.replaceAll(value, "[已隐藏]");
	}
	return sanitized.slice(-4000);
}

export class StatelessTaskIndexingAgentExecutionError extends Error {
	providerAttempts?: TaskAssistanceModelProviderAttempt[];
	exitCode: number | null = null;
	signal: string | null = null;
	stderrTail: string | null = null;
	constructor(
		readonly reasonCode: string,
		message: string,
		inputMaterialTexts: readonly string[] = [],
	) {
		super(sanitizeStatelessAgentFailureDetail(message, inputMaterialTexts));
		this.name = "StatelessTaskIndexingAgentExecutionError";
	}
}

export function classifyStatelessAgentFailureReason(message: string): string {
	return /authenticat|oauth|unauthorized|认证|401\b/iu.test(message)
		? "authentication_failed"
		: "agent_execution_failed";
}
