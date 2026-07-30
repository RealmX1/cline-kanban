import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import { useAutoRepeatingPress } from "@/hooks/use-auto-repeating-press";
import type { TerminalControlKeyDefinition } from "@/terminal/terminal-control-key-sequences";

interface TerminalVirtualKeyCapButtonProps {
	keyDefinition: TerminalControlKeyDefinition;
	onPressKey: (keyDefinition: TerminalControlKeyDefinition) => void;
	disabled?: boolean;
	className?: string;
}

/**
 * 虚拟按键条里的一枚键帽。
 *
 * 刻意不复用 `@/components/ui/button`：那套 `size` 预设把高度写死成 h-5/h-7/h-8，而 `cn()` 只是
 * 字符串拼接、不做 tailwind-merge，外部再传一个 h-* 只会得到两个同级冲突类、谁生效取决于
 * Tailwind 的产出顺序。键帽需要按网格精确定高（Enter 还要跨两行），加上长按连发与触屏长按
 * 系统行为抑制这些本就不属于通用按钮的行为，独立成一个域组件比跟基础按钮较劲更清楚。
 *
 * 尺寸低于共享的 44px 最小触控目标（`MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME`）是**刻意**的：
 * 那个下限针对的是顶栏里彼此不相干、误触代价高的图标按钮；这里是一簇同族、位置固定、
 * 误触即刻可见可撤（多按一次方向键而已）的键帽，键距比键面尺寸更能决定命中率。按 44px 排
 * 会把按键条撑到占掉小屏近四分之一的高度，反而挤走它要服务的终端内容。
 */
export function TerminalVirtualKeyCapButton({
	keyDefinition,
	onPressKey,
	disabled,
	className,
}: TerminalVirtualKeyCapButtonProps): ReactElement {
	const autoRepeatingPressBindings = useAutoRepeatingPress({
		onPress: () => onPressKey(keyDefinition),
		isAutoRepeatEnabled: keyDefinition.supportsAutoRepeatOnLongPress,
	});

	return (
		<button
			type="button"
			disabled={disabled}
			aria-label={keyDefinition.accessibleDescription}
			className={cn(
				"inline-flex select-none items-center justify-center rounded-md border font-mono text-xs font-medium",
				// touch-action:manipulation 去掉双击缩放判定带来的点击延迟，长按连发才跟手。
				"touch-manipulation",
				"disabled:pointer-events-none disabled:opacity-40",
				"focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
				keyDefinition.isDestructive
					? "border-status-red/30 bg-status-red/10 text-status-red active:bg-status-red/25"
					: "border-border-bright bg-surface-2 text-text-primary active:bg-surface-4",
				className,
			)}
			{...autoRepeatingPressBindings}
		>
			{keyDefinition.label}
		</button>
	);
}
