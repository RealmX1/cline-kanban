// Kanban 为用户开的 shell 终端也是 terminal manager 里的「会话」，用合成的 taskId 标识：
//   - 首页底部终端：固定 id，作用域是整个 workspace；
//   - 卡片详情终端：前缀 + 卡片 id，cwd 是那张卡的 worktree。
// 这两个字面量原本只在 web-ui 里定义（persistent-terminal-manager.ts / use-terminal-panels.ts）；服务端
// 的资源占用归因需要按它们把 shell 及其后代（dev server 等）记到正确的 task / workspace 上。
// TODO(follow-up): web-ui 两处改为经 @runtime alias 引用本文件（需同步 tsconfig + vite + vitest 三处 alias）。

export const WORKSPACE_HOME_USER_SHELL_TERMINAL_SESSION_TASK_ID = "__home_terminal__";

export const TASK_CARD_DETAIL_USER_SHELL_TERMINAL_SESSION_TASK_ID_PREFIX = "__detail_terminal__:";

export function isWorkspaceHomeUserShellTerminalSessionTaskId(sessionTaskId: string): boolean {
	return sessionTaskId === WORKSPACE_HOME_USER_SHELL_TERMINAL_SESSION_TASK_ID;
}

// 不是卡片详情终端时返回 null。
export function parseTaskCardIdFromTaskCardDetailUserShellTerminalSessionTaskId(sessionTaskId: string): string | null {
	if (!sessionTaskId.startsWith(TASK_CARD_DETAIL_USER_SHELL_TERMINAL_SESSION_TASK_ID_PREFIX)) {
		return null;
	}
	const taskCardId = sessionTaskId.slice(TASK_CARD_DETAIL_USER_SHELL_TERMINAL_SESSION_TASK_ID_PREFIX.length);
	return taskCardId.length > 0 ? taskCardId : null;
}
