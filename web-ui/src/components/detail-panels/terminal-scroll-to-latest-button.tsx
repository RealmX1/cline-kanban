import { ArrowDownToLine } from "lucide-react";

import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface TerminalScrollToLatestButtonProps {
	/** 视口是否已从最新输出处滚开。为 false 时不渲染 —— 贴底时这个按钮没有意义。 */
	isScrolledAwayFromLatest: boolean;
	onScrollToLatest: () => void;
}

/**
 * 浮在滚动区右下角的「跳到最新」按钮。xterm 终端与 transcript 阅读视图共用：
 * 两处都是「内容会持续增长、用户可能已经翻到上面」的滚动区，回到最新的诉求相同。
 *
 * 触屏上没有 hover tooltip 可依赖，故图标旁保留可见文字。
 */
export function TerminalScrollToLatestButton({
	isScrolledAwayFromLatest,
	onScrollToLatest,
}: TerminalScrollToLatestButtonProps) {
	const isMobile = useIsMobile();

	if (!isScrolledAwayFromLatest) {
		return null;
	}

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
			<Button
				variant="default"
				size={isMobile ? "md" : "sm"}
				icon={<ArrowDownToLine size={isMobile ? 16 : 14} />}
				onClick={onScrollToLatest}
				aria-label="Scroll to latest output"
				className={cn("pointer-events-auto shadow-lg", isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
			>
				Latest
			</Button>
		</div>
	);
}
