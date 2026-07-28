import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";

/**
 * 项目编组热键的键串与展示标签的唯一来源：注册（react-hotkeys-hook）、槽位单元格提示、
 * 侧栏快捷键帮助面板三处都从这里取，避免键串与文案各写一份后悄悄漂移。
 *
 * 跳转 `mod+shift+1..9`，绑定 `mod+alt+1..9`。react-hotkeys-hook 的 `mod` 会自行映射成
 * mac 的 metaKey / 其它平台的 ctrlKey。
 */
export function buildProjectNumericSlotGroupJumpHotkeyBinding(slotNumber: ProjectNumericSlotGroupNumber): string {
	return `mod+shift+${slotNumber}`;
}

export function buildProjectNumericSlotGroupBindHotkeyBinding(slotNumber: ProjectNumericSlotGroupNumber): string {
	return `mod+alt+${slotNumber}`;
}

const MODIFIER_SYMBOL = isMacPlatform ? "⌘" : modifierKeyLabel;
const SHIFT_SYMBOL = isMacPlatform ? "⇧" : "Shift";
const ALT_SYMBOL = isMacPlatform ? "⌥" : "Alt";

export function formatProjectNumericSlotGroupJumpHotkeyLabel(slotNumber: ProjectNumericSlotGroupNumber): string {
	return `${MODIFIER_SYMBOL}${isMacPlatform ? "" : "+"}${SHIFT_SYMBOL}+${slotNumber}`;
}

export function formatProjectNumericSlotGroupBindHotkeyLabel(slotNumber: ProjectNumericSlotGroupNumber): string {
	return `${MODIFIER_SYMBOL}${isMacPlatform ? "" : "+"}${ALT_SYMBOL}+${slotNumber}`;
}

/**
 * macOS 把 ⌘⇧3 / ⌘⇧4 / ⌘⇧5 占作系统截图，键在 OS 层就被吞掉，网页永远收不到——这是代码侧无解的限制。
 *
 * 处理方式：这三个槽位照常可绑定、表格内点击照常可跳转，只在热键提示处标灰并说明，
 * 而不是把 mac 阉割成「只有 6 个槽位」那种残缺形态。
 */
const MAC_SCREENSHOT_PREEMPTED_SLOT_NUMBERS: readonly ProjectNumericSlotGroupNumber[] = [3, 4, 5];

export function isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem(
	slotNumber: ProjectNumericSlotGroupNumber,
): boolean {
	return isMacPlatform && MAC_SCREENSHOT_PREEMPTED_SLOT_NUMBERS.includes(slotNumber);
}

export function describeProjectNumericSlotGroupJumpHotkey(slotNumber: ProjectNumericSlotGroupNumber): string {
	const jumpHotkeyLabel = formatProjectNumericSlotGroupJumpHotkeyLabel(slotNumber);
	if (isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem(slotNumber)) {
		return `${jumpHotkeyLabel} is reserved by macOS for screenshots — click the row to switch instead.`;
	}
	return `Jump to this project with ${jumpHotkeyLabel}`;
}
