import type { RuntimeAgentId } from "../core/api-contract";
import { isKanbanTaskWorktreeWorkingDirectoryPath } from "./kanban-task-worktree-working-directory-path";
import { normalizeTerminalText, stripAnsiAndControl } from "./terminal-output-normalization";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;

export function hasClaudeWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return /yes,?\s*i\s*trust\s*this\s*folder/u.test(normalized) || /trust\s+this\s+folder/u.test(normalized);
}

export function shouldAutoConfirmClaudeWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	return agentId === "claude" && isKanbanTaskWorktreeWorkingDirectoryPath(cwd);
}

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
