import type React from "react";
import { cn } from "@/components/ui/cn";

interface ShimmeringTextProps {
	text: string;
	/** 一次流光扫过的时长（秒）。 */
	durationSeconds?: number;
	className?: string;
	/** 高光带宽度系数，最终宽度 = text.length * spread（px）。 */
	spread?: number;
	color?: string;
	shimmerColor?: string;
}

/**
 * 文字流光。动画由 `globals.css` 的 `kb-text-shimmer-sweep` keyframe 驱动，
 * 组件本身不参与逐帧计算——这是刻意的：本组件的唯一使用者
 * （`cline-thinking-indicator.tsx`）在 agent 流式输出期间常驻挂载，
 * 换成 JS 动画库等于在最忙的时候常开一条主线程 rAF 循环。
 */
export function ShimmeringText({
	text,
	durationSeconds = 2,
	className,
	spread = 2,
	color,
	shimmerColor,
}: ShimmeringTextProps) {
	return (
		<span
			className={cn(
				"kb-text-shimmer-sweep relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
				"[--base-color:#6E7681] [--shimmer-color:#C9D1D9]",
				"[background-repeat:no-repeat,padding-box]",
				"[--shimmer-bg:linear-gradient(90deg,transparent_calc(50%-var(--spread)),var(--shimmer-color),transparent_calc(50%+var(--spread)))]",
				className,
			)}
			style={
				{
					"--spread": `${text.length * spread}px`,
					"--kb-text-shimmer-sweep-duration": `${durationSeconds}s`,
					...(color && { "--base-color": color }),
					...(shimmerColor && { "--shimmer-color": shimmerColor }),
					backgroundImage: "var(--shimmer-bg), linear-gradient(var(--base-color), var(--base-color))",
				} as React.CSSProperties
			}
		>
			{text}
		</span>
	);
}
