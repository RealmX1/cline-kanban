import type { RuntimeAgentId } from "../core/api-contract";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { normalizeTerminalText, stripAnsiAndControl } from "./terminal-output-normalization";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;

export function hasClaudeWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return /yes,?\s*i\s*trust\s*this\s*folder/u.test(normalized) || /trust\s+this\s+folder/u.test(normalized);
}

function isTaskWorktreePath(path: string): boolean {
	const worktreesRoot = `${getTaskWorktreesHomePath().replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	const normalizedPath = `${path.replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	if (process.platform === "win32") {
		return normalizedPath.toLowerCase().startsWith(worktreesRoot.toLowerCase());
	}
	return normalizedPath.startsWith(worktreesRoot);
}

export function shouldAutoConfirmClaudeWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	return agentId === "claude" && isTaskWorktreePath(cwd);
}

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
