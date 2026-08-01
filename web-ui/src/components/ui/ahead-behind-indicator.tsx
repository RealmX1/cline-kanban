import { ArrowDown, ArrowUp } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";

/** 选中高亮行（蓝底）上的柔和前景色；无对应设计 token，故内联。 */
const SELECTED_ROW_SUBTLE_TEXT_COLOR = "rgba(255, 255, 255, 0.64)";

export type AheadBehindIndicatorTone = "muted" | "semantic";

export interface AheadBehindIndicatorProps {
	/** 领先目标 ref 的提交数。0 / null / undefined 时该侧不渲染。 */
	ahead?: number | null;
	/** 落后目标 ref 的提交数。0 / null / undefined 时该侧不渲染。 */
	behind?: number | null;
	/**
	 * muted：两侧同为 tertiary 灰，用于本身已有强色彩语境、不需要区分两数的列表行。
	 * semantic：ahead 蓝、behind 橙，用于需要一眼分辨两个数字的紧凑行。橙作告警色暗示「该同步了」，
	 * 又不像红色那样读作错误；两者都避开 green/red，以免与同行的 `+新增 -删除` 行数统计撞色。
	 */
	tone?: AheadBehindIndicatorTone;
	/** 处于选中高亮行内时覆盖为柔和白，避免与选中底色抢对比度。 */
	isSelected?: boolean;
	iconSize?: number;
	/** 字号由宿主通过 className 决定（组件本身不设字号，以便继承所在行的排版）。 */
	className?: string;
}

/**
 * 与某个目标 ref 的双向分歧指示器：↑ 领先数、↓ 落后数。两侧均为 0 时整体不渲染。
 */
export function AheadBehindIndicator({
	ahead,
	behind,
	tone = "muted",
	isSelected = false,
	iconSize = 9,
	className,
}: AheadBehindIndicatorProps): React.ReactElement | null {
	if (!ahead && !behind) {
		return null;
	}
	const selectedTextStyle = isSelected ? { color: SELECTED_ROW_SUBTLE_TEXT_COLOR } : undefined;
	const aheadToneClassName = tone === "semantic" ? "text-status-blue" : "text-text-tertiary";
	const behindToneClassName = tone === "semantic" ? "text-status-orange" : "text-text-tertiary";
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-[3px]", className)} style={selectedTextStyle}>
			{ahead ? (
				<span className={cn("inline-flex items-center gap-px", !isSelected && aheadToneClassName)}>
					<ArrowUp size={iconSize} />
					{ahead}
				</span>
			) : null}
			{behind ? (
				<span className={cn("inline-flex items-center gap-px", !isSelected && behindToneClassName)}>
					<ArrowDown size={iconSize} />
					{behind}
				</span>
			) : null}
		</span>
	);
}
