// 单一真源：所有「Kanban UI 代替用户按下某个键」时发往 PTY 的控制字节序列。
//
// 投递链路与用户在物理键盘上按下同一个键完全等价，不需要任何服务端改动：
//   sendTaskSessionInput(taskId, sequence, { appendNewline: false })
//     -> TerminalController.input()  (terminal-controller-registry.ts)
//     -> xterm terminal.input()
//     -> terminal.onData
//     -> IO WebSocket 裸字节
//     -> session-manager.writeInput -> node-pty
//
// 方向键一律用 CSI 形式（ESC [ A）而非 application-cursor-key 形式（ESC O A）。
// 全屏 TUI 可能通过 DECCKM 切到 application 形式，而 xterm 没有公开 API 暴露该模式状态，
// 故无法按当前模式动态选择。选 CSI 是因为 agent TUI 侧的按键解析（Claude Code 的 Ink、
// 以及一切基于 Node readline `emitKeypressEvents` 的实现）对两种形式都识别，
// 而 CSI 是不依赖终端模式的那一种。

/**
 * Ctrl+C。移动端只靠这一个键覆盖两种诉求，因此不再单独提供「按一次 ESC」按钮：
 * 有回合在生成时它打断该回合；没有回合在跑时它清除当前输入行。
 */
export const TERMINAL_INTERRUPT_AND_CLEAR_INPUT_LINE_SEQUENCE = "\u0003";

/** 连续两次 ESC —— Claude Code 用它进入 rewind（回溯会话历史）界面。 */
export const TERMINAL_REWIND_DOUBLE_ESCAPE_SEQUENCE = "\u001b\u001b";

export const TERMINAL_ARROW_UP_SEQUENCE = "\u001b[A";
export const TERMINAL_ARROW_DOWN_SEQUENCE = "\u001b[B";
export const TERMINAL_ARROW_RIGHT_SEQUENCE = "\u001b[C";
export const TERMINAL_ARROW_LEFT_SEQUENCE = "\u001b[D";

/** 回车。裸 CR 而非 LF —— 与既有程序化提交路径（use-board-interactions / use-git-actions）一致。 */
export const TERMINAL_SUBMIT_CARRIAGE_RETURN_SEQUENCE = "\r";

export const TERMINAL_TAB_SEQUENCE = "\t";

/** Shift+Tab（CSI Z，back-tab）。Claude Code 用它反向循环权限/计划模式。 */
export const TERMINAL_BACK_TAB_SEQUENCE = "\u001b[Z";

export type TerminalControlKeyId =
	| "interrupt_and_clear_input_line"
	| "rewind_double_escape"
	| "arrow_up"
	| "arrow_down"
	| "arrow_left"
	| "arrow_right"
	| "submit"
	| "tab"
	| "back_tab";

export interface TerminalControlKeyDefinition {
	id: TerminalControlKeyId;
	/** 按钮上的可见文字。方向键用箭头字形，其余用短标签。 */
	label: string;
	/** 无障碍标签：说清这个键对 agent 做什么，触摸端没有 hover tooltip 可依赖。 */
	accessibleDescription: string;
	sequence: string;
	/**
	 * 误触代价是否明显高于其余键（当前只有 Ctrl+C：它会打断正在生成的回合）。
	 * 用于让键帽换用告警配色，在密排的按键簇里拉开视觉距离。
	 */
	isDestructive: boolean;
	/**
	 * 按住是否连发（对齐物理键盘的 typematic 重复）。
	 *
	 * 只有方向键开：在 AskUserQuestion 的长选项列表或 rewind 历史里逐下点按翻十几项非常折磨人。
	 * 其余键一律关 —— Ctrl+C 连发会把打断信号刷屏、Enter 连发会重复提交、Tab/⇧Tab 连发会把
	 * 权限/计划模式循环到用户没预期的档位，这些都是不可逆或代价明显高于省下几次点按的操作。
	 */
	supportsAutoRepeatOnLongPress: boolean;
}

export const TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID: Record<TerminalControlKeyId, TerminalControlKeyDefinition> = {
	interrupt_and_clear_input_line: {
		id: "interrupt_and_clear_input_line",
		label: "Ctrl+C",
		accessibleDescription: "Interrupt the agent, or clear the current input line",
		sequence: TERMINAL_INTERRUPT_AND_CLEAR_INPUT_LINE_SEQUENCE,
		isDestructive: true,
		supportsAutoRepeatOnLongPress: false,
	},
	rewind_double_escape: {
		id: "rewind_double_escape",
		label: "Esc Esc",
		accessibleDescription: "Open the rewind history view (double escape)",
		sequence: TERMINAL_REWIND_DOUBLE_ESCAPE_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: false,
	},
	arrow_up: {
		id: "arrow_up",
		label: "↑",
		accessibleDescription: "Arrow up",
		sequence: TERMINAL_ARROW_UP_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: true,
	},
	arrow_down: {
		id: "arrow_down",
		label: "↓",
		accessibleDescription: "Arrow down",
		sequence: TERMINAL_ARROW_DOWN_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: true,
	},
	arrow_left: {
		id: "arrow_left",
		label: "←",
		accessibleDescription: "Arrow left",
		sequence: TERMINAL_ARROW_LEFT_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: true,
	},
	arrow_right: {
		id: "arrow_right",
		label: "→",
		accessibleDescription: "Arrow right",
		sequence: TERMINAL_ARROW_RIGHT_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: true,
	},
	submit: {
		id: "submit",
		label: "Enter",
		accessibleDescription: "Submit the current selection or input",
		sequence: TERMINAL_SUBMIT_CARRIAGE_RETURN_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: false,
	},
	tab: {
		id: "tab",
		label: "Tab",
		accessibleDescription: "Tab",
		sequence: TERMINAL_TAB_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: false,
	},
	back_tab: {
		id: "back_tab",
		label: "⇧Tab",
		accessibleDescription: "Shift tab (reverse cycle)",
		sequence: TERMINAL_BACK_TAB_SEQUENCE,
		isDestructive: false,
		supportsAutoRepeatOnLongPress: false,
	},
};

// ---------------------------------------------------------------------------
// 虚拟按键条布局
//
// 方向键必须排成实体键盘那样的倒 T 形簇，而不是摊平在一行里：拇指靠的是空间记忆而非读标签，
// 「↑ 在上、↓ 在下、左右分居两侧」的相对位置本身就是可供性。摊成一行后四个键退化成一排等价
// 方块，每次都得先读字形再点，且横向拉满还会把整条按键条撑得又高又空。
// ---------------------------------------------------------------------------

/** 方向键簇的物理排布（倒 T 形）。`null` 是占位空格，用于把 ↑ 顶在中列。 */
export const TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS: readonly (readonly (TerminalControlKeyId | null)[])[] =
	[
		[null, "arrow_up", null],
		["arrow_left", "arrow_down", "arrow_right"],
	];

/** 动作键，排成 2×2 与方向键簇等高，占住按键条的另一半宽度。 */
export const TERMINAL_VIRTUAL_KEY_BAR_ACTION_KEY_IDS: readonly TerminalControlKeyId[] = [
	"interrupt_and_clear_input_line",
	"rewind_double_escape",
	"tab",
	"back_tab",
];

/** Enter 紧邻方向键簇右侧且占满两行高：它是「导航到目标后确认」这条动作链的终点。 */
export const TERMINAL_VIRTUAL_KEY_BAR_SUBMIT_KEY_ID: TerminalControlKeyId = "submit";
