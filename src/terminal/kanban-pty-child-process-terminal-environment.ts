// Kanban 拉起的每条 PTY 子进程（agent TUI 与 shell 终端）的环境变量构造。
//
// 从 session-manager.ts 抽出：runtime 进程内 spawn 与 agent session PTY host 代 spawn（热重启方案）
// 都必须用同一份环境；host 不能自己再拼一遍，否则两条路径起出来的 agent 看到的终端身份会漂移。

import {
	AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
	AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
} from "../agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";

export interface TerminalEnvironmentOptions {
	forceColor: boolean;
}

// Kanban 的 PTY 是一个全新的终端（前端 xterm.js），不是宿主 tmux / screen / zellij 的 pane，也不是
// 宿主 iTerm 的会话。Kanban 运行时自己常跑在 tmux 里，若把这些宿主身份变量原样继承给子进程，就是
// 在对 agent 撒谎。真实事故：Codex 0.158 起，只要看到 TMUX/TMUX_PANE 就去 `tmux display-message
// -p '#{mouse}'` 探测（上游 codex-rs/tui/src/tui/tmux.rs），宿主 tmux `mouse off` → 放弃鼠标捕获、
// 改开 ?1007 alternate scroll → xterm.js 在 alt buffer 里把滚轮翻译成 ↑/↓ → 滚轮不再滚 transcript，
// 而是翻输入框的历史 prompt。TERM_PROGRAM 已被覆盖为 kanban，同源的 *_VERSION / 会话 id 等一并剥掉。
// 只从继承的 process.env 基底里剔除：调用方经 sources 显式传入的同名键仍生效。
// 刻意不剥 TERMINFO_DIRS 这类 terminfo 查找路径——那是能力数据库位置，不是终端身份。
const INHERITED_HOST_TERMINAL_IDENTITY_ENV_KEYS_STRIPPED_FROM_KANBAN_PTY: readonly string[] = [
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
	"TERM_PROGRAM_VERSION",
	"TERM_SESSION_ID",
	"ITERM_SESSION_ID",
	"LC_TERMINAL",
	"LC_TERMINAL_VERSION",
	"TERM_FEATURES",
];

// 「这条会话由哪个 agent session PTY host 托管」的绑定只属于被托管的那条会话本身（host 模式下由 runtime 在
// spawn 时显式写入）。runtime 自己若跑在某条 hosted 会话里（例如在 agent 里起的隔离实例），会继承外层会话的
// 绑定；原样传下去，内层 agent 的 hook 在内层 runtime 不可达时就会存进外层会话的 spool、被外层 runtime 应用。
const INHERITED_AGENT_SESSION_PTY_HOST_BINDING_ENV_KEYS_STRIPPED_FROM_KANBAN_PTY: readonly string[] = [
	AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
	AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
];

export function buildTerminalEnvironment(
	options: TerminalEnvironmentOptions,
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	const inheritedProcessEnvWithoutHostTerminalIdentity: Record<string, string | undefined> = { ...process.env };
	for (const key of [
		...INHERITED_HOST_TERMINAL_IDENTITY_ENV_KEYS_STRIPPED_FROM_KANBAN_PTY,
		...INHERITED_AGENT_SESSION_PTY_HOST_BINDING_ENV_KEYS_STRIPPED_FROM_KANBAN_PTY,
	]) {
		delete inheritedProcessEnvWithoutHostTerminalIdentity[key];
	}
	const env: Record<string, string | undefined> = {
		...inheritedProcessEnvWithoutHostTerminalIdentity,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
	// source 里值为 undefined 的键，语义是「抹掉继承自 process.env 的这一项」，必须真正删键：
	// node-pty 会把留下来的 undefined 序列化成**字符串 "undefined"** 传给子进程，而这对任何
	// 「只看变量存不存在」的消费者都是 truthy —— 等于把「抹除」写成了「设置成开」，与本意反号。
	// 真实用例：Kanban 自己可能跑在一个 Claude Code 会话里，继承了它注入的 CLAUDE_CODE_* 变量，
	// adapter 需要把这些污染抹掉才能按 Kanban 自己的意图起 agent（见 agent-session-adapters 的
	// resolveClaudeCodeTerminalRenderingModeEnv）。
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete env[key];
		}
	}
	if (options.forceColor) {
		env.CLICOLOR = "1";
		env.CLICOLOR_FORCE = "1";
		env.FORCE_COLOR = "3";
		delete env.NO_COLOR;
		delete env.NODE_DISABLE_COLORS;
	}
	return env;
}
