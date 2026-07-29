import { useCallback } from "react";

import { showAppToast } from "@/components/app-toaster";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID,
	TERMINAL_VIRTUAL_KEY_BAR_ACTION_ROW_KEY_IDS,
	TERMINAL_VIRTUAL_KEY_BAR_NAVIGATION_ROW_KEY_IDS,
	type TerminalControlKeyDefinition,
	type TerminalControlKeyId,
} from "@/terminal/terminal-control-key-sequences";
import { getTerminalController } from "@/terminal/terminal-controller-registry";

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
 * `terminal-control-key-sequences.ts`。
 *
 * 直接走 `TerminalController` 而非 `sendTaskSessionInput` 的 HTTP 回落：本面板与它要驱动的
 * 终端同处移动端 Focus View 的 tab 树内（切 tab 只是 `display:none`，终端始终挂载），
 * 故 controller 必定在位；真的取不到时只可能是终端尚未连上，此时提示用户比静默无响应更好。
 */
export function TerminalVirtualKeyInputBar({ taskId, disabled }: TerminalVirtualKeyInputBarProps) {
	const sendControlKeySequence = useCallback(
		(sequence: string) => {
			const didSend = getTerminalController(taskId)?.input(sequence) ?? false;
			if (!didSend) {
				showAppToast({ intent: "warning", message: "Terminal is not connected yet." }, "virtual-key-not-connected");
			}
		},
		[taskId],
	);

	return (
		<div className="flex shrink-0 flex-col gap-1 border-t border-border bg-surface-1 px-2 py-1.5">
			<TerminalVirtualKeyRow
				keyIds={TERMINAL_VIRTUAL_KEY_BAR_NAVIGATION_ROW_KEY_IDS}
				onSendControlKeySequence={sendControlKeySequence}
				disabled={disabled}
			/>
			<TerminalVirtualKeyRow
				keyIds={TERMINAL_VIRTUAL_KEY_BAR_ACTION_ROW_KEY_IDS}
				onSendControlKeySequence={sendControlKeySequence}
				disabled={disabled}
			/>
		</div>
	);
}

interface TerminalVirtualKeyRowProps {
	keyIds: readonly TerminalControlKeyId[];
	onSendControlKeySequence: (sequence: string) => void;
	disabled?: boolean;
}

function TerminalVirtualKeyRow({ keyIds, onSendControlKeySequence, disabled }: TerminalVirtualKeyRowProps) {
	return (
		<div className="flex items-center gap-1">
			{keyIds.map((keyId) => {
				const keyDefinition = TERMINAL_CONTROL_KEY_DEFINITIONS_BY_ID[keyId];
				return (
					<Button
						key={keyId}
						variant={isDestructiveControlKey(keyDefinition) ? "danger" : "default"}
						size="md"
						disabled={disabled}
						onClick={() => onSendControlKeySequence(keyDefinition.sequence)}
						aria-label={keyDefinition.accessibleDescription}
						className={cn("flex-1 font-mono", MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
					>
						{keyDefinition.label}
					</Button>
				);
			})}
		</div>
	);
}

// Ctrl+C 会打断正在生成的回合，误触代价明显高于其余键，故单独着色以拉开视觉距离。
function isDestructiveControlKey(keyDefinition: TerminalControlKeyDefinition): boolean {
	return keyDefinition.id === "interrupt_and_clear_input_line";
}
