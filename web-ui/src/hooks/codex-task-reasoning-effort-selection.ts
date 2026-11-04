import type { CodexConfigurationProfile, RuntimeTerminalAgentModelSelectionOptionsResponse } from "@/runtime/types";

export function resolveCodexTaskReasoningEffortSelection(input: {
	profile: CodexConfigurationProfile | undefined;
	explicitModelId: string | undefined;
	override: string | undefined;
	catalog: RuntimeTerminalAgentModelSelectionOptionsResponse | null;
	catalogWarning: string | null;
	catalogIsLoading?: boolean;
}) {
	const profileField = (name: string) =>
		input.profile?.fields.find((field) => field.fieldKey === JSON.stringify(["config.toml", name]))?.value;
	const profileModel = profileField("model");
	const profileEffort = profileField("model_reasoning_effort");
	const catalog = input.catalog?.agentId === "codex" ? input.catalog : null;
	const effectiveModelId =
		input.explicitModelId ?? (typeof profileModel === "string" ? profileModel : catalog?.defaultModelId);
	const model = effectiveModelId ? catalog?.options.find((option) => option.modelId === effectiveModelId) : undefined;
	const options = model?.supportedReasoningEfforts ?? [];
	const inheritedEffort = typeof profileEffort === "string" ? profileEffort : model?.defaultReasoningEffort;
	// 首次读取还没有目录，也不算失败。已有健康目录时，刷新中的 loading 不取消不兼容拦截。
	const hasRefreshWarning = Boolean(input.catalogWarning || catalog?.warning);
	const canVerify = Boolean(catalog && !hasRefreshWarning && model?.supportedReasoningEfforts !== undefined);
	const awaitingFirstCatalog = Boolean(input.catalogIsLoading) && !catalog && !hasRefreshWarning;
	const effectiveEffort = input.override ?? inheritedEffort;
	const validationError =
		canVerify && effectiveEffort && !options.some((option) => option.effort === effectiveEffort)
			? `模型 ${effectiveModelId} 不支持推理强度 ${effectiveEffort}，请选择该模型支持的档位。`
			: null;
	return {
		options,
		inheritedEffort,
		validationError,
		recoveryMessage:
			!awaitingFirstCatalog && (hasRefreshWarning || !canVerify)
				? "暂时无法核验此模型的推理档位，已保留选择；目录或连接恢复后自动重验。"
				: null,
	};
}
