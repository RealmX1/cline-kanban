export const KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID = "grok-4.5-high";

export function isKanbanCursorAgentModelId(modelId: string): boolean {
	const trimmedModelId = modelId.trim();
	return (
		trimmedModelId === "auto" ||
		trimmedModelId === "composer" ||
		trimmedModelId.startsWith("composer-") ||
		trimmedModelId === "grok-4.5" ||
		trimmedModelId.startsWith("grok-4.5-") ||
		trimmedModelId.startsWith("grok-4.5[")
	);
}
