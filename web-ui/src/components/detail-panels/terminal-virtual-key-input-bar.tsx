import { type ReactElement, useCallback, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TerminalVirtualKeyCapButton } from "@/components/detail-panels/terminal-virtual-key-cap-button";
import {
	TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID,
	TERMINAL_VIRTUAL_KEY_BAR_ACTION_KEY_IDS,
	TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS,
	TERMINAL_VIRTUAL_KEY_BAR_SUBMIT_KEY_ID,
	type TerminalControlKeyDefinition,
} from "@/terminal/terminal-control-key-sequences";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { usePublishTerminalVirtualKeyBarViewportBottomInset } from "@/terminal/terminal-virtual-key-bar-viewport-bottom-inset";

/** 键帽高度。低于 44px 共享下限是刻意的，理由见 `TerminalVirtualKeyCapButton` 的注释。 */
const KEY_CAP_HEIGHT_CLASS_NAME = "h-9";
/** Enter 跨两行：两个 h-9（36px）加中间 2px 的间隙。 */
const SUBMIT_KEY_CAP_HEIGHT_CLASS_NAME = "h-[74px]";

// 横向宽度预算（改键帽尺寸前先算一遍）：动作栅格 2×58+2 ≈ 118，方向键簇 3×40+4 = 124，
// Enter 48，两处 gap 8+4，容器左右内边距 16 —— 合计约 318px，最窄的在用机型（320pt）也不溢出。
// 这条按键条一旦横向溢出，被挤出去的恰恰是最右侧的 Enter，而它是「导航到目标后确认」的终点。

interface TerminalVirtualKeyInputBarProps {
	taskId: string;
	disabled?: boolean;
}

/**
 * 触屏软键盘上不存在的终端控制键的代理面板。
 *
 * 移动端读 agent TUI 时最缺的三件事各对应这里的一组键：中断/清行（Ctrl+C）、进入 rewind
 * （连续两次 ESC）、以及在 AskUserQuestion / rewind 列表里移动光标并确认（方向键 + Enter）。
 * 按下即把对应字节序列发往 PTY，与在物理键盘上按同一个键完全等价 —— 序列定义与投递链路见
 * `terminal-control-key-sequences.ts`，长按连发见 `use-auto-repeating-press.ts`。
 *
 * 布局分两半：左半是 2×2 的动作键，右半是倒 T 形方向键簇 + 跨两行的 Enter。两半各占一侧、
 * 中间留空，而不是把每个键 `flex-1` 拉满 —— 拉满会让四个方向键退化成一排等宽方块，既丢掉
 * 「上下左右」的空间记忆，又在小屏上撑出大片无意义留白。
 *
 * 直接走 `TerminalController` 而非 `sendTaskSessionInput` 的 HTTP 回落：本面板与它要驱动的
 * 终端同处移动端 Focus View 的 tab 树内（切 tab 只是 `display:none`，终端始终挂载），
 * 故 controller 必定在位；真的取不到时只可能是终端尚未连上，此时提示用户比静默无响应更好。
 */
export function TerminalVirtualKeyInputBar({ taskId, disabled }: TerminalVirtualKeyInputBarProps): ReactElement {
	const barElementRef = useRef<HTMLDivElement | null>(null);
	usePublishTerminalVirtualKeyBarViewportBottomInset(barElementRef);

	const handlePressKey = useCallback(
		(keyDefinition: TerminalControlKeyDefinition) => {
			const didSend = getTerminalController(taskId)?.input(keyDefinition.sequence) ?? false;
			if (!didSend) {
				showAppToast({ intent: "warning", message: "Terminal is not connected yet." }, "virtual-key-not-connected");
			}
		},
		[taskId],
	);

	return (
		<div
			ref={barElementRef}
			className="flex shrink-0 items-start justify-between gap-2 border-t border-border bg-surface-1 px-2 py-1.5"
		>
			<div className="grid grid-cols-2 gap-0.5">
				{TERMINAL_VIRTUAL_KEY_BAR_ACTION_KEY_IDS.map((keyId) => (
					<TerminalVirtualKeyCapButton
						key={keyId}
						keyDefinition={TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[keyId]}
						onPressKey={handlePressKey}
						disabled={disabled}
						className={`${KEY_CAP_HEIGHT_CLASS_NAME} min-w-[58px] px-1.5 text-[11px]`}
					/>
				))}
			</div>
			<div className="flex items-start gap-1">
				<div className="grid grid-cols-3 gap-0.5">
					{TERMINAL_VIRTUAL_KEY_BAR_DIRECTIONAL_CLUSTER_ROWS.flatMap((clusterRow, clusterRowIndex) =>
						clusterRow.map((keyId, columnIndex) =>
							keyId === null ? (
								// 倒 T 形的空位。渲染成空 div 而不是靠 col-start 定位，网格结构一眼可读。
								<div key={`empty-${clusterRowIndex}-${columnIndex}`} aria-hidden="true" />
							) : (
								<TerminalVirtualKeyCapButton
									key={keyId}
									keyDefinition={TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[keyId]}
									onPressKey={handlePressKey}
									disabled={disabled}
									className={`${KEY_CAP_HEIGHT_CLASS_NAME} w-10 text-sm`}
								/>
							),
						),
					)}
				</div>
				<TerminalVirtualKeyCapButton
					keyDefinition={TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[TERMINAL_VIRTUAL_KEY_BAR_SUBMIT_KEY_ID]}
					onPressKey={handlePressKey}
					disabled={disabled}
					className={`${SUBMIT_KEY_CAP_HEIGHT_CLASS_NAME} w-12`}
				/>
			</div>
		</div>
	);
}
