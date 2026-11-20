import type { RuntimeTerminalAgentModelSelectionOptionsResponse } from "@/runtime/types";

export function resolveCodexTaskReasoningEffortSelection(input: {
	explicitModelId: string | undefined;
	override: string | undefined;
	catalog: RuntimeTerminalAgentModelSelectionOptionsResponse | null;
	catalogWarning: string | null;
	catalogIsLoading?: boolean;
}) {
	const catalog = input.catalog?.agentId === "codex" ? input.catalog : null;
	const effectiveModelId = input.explicitModelId ?? catalog?.defaultModelId;
	const model = effectiveModelId ? catalog?.options.find((option) => option.modelId === effectiveModelId) : undefined;
	const options = model?.supportedReasoningEfforts ?? [];
	const inheritedEffort = model?.defaultReasoningEffort;
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
				? "推理档位未能加载，已保留选择和上次目录；目录或连接恢复后自动重验。"
				: null,
	};
}
