export const KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID = "composer-2.5";

export function isKanbanCursorAgentModelId(modelId: string): boolean {
	const trimmedModelId = modelId.trim();
	return trimmedModelId === "auto" || trimmedModelId === "composer" || trimmedModelId.startsWith("composer-");
}
