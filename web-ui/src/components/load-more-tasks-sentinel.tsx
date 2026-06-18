import { forwardRef } from "react";

/**
 * 渐进渲染列表底部的「加载更多」哨兵。
 *
 * - 作为 IntersectionObserver 的观察目标：滚动到底部时进入视口即触发追加渲染。
 * - 同时是一个可点击的兜底入口：键盘 / 无障碍场景，或 IntersectionObserver 不可用时，
 *   用户可点击它手动展开下一批。
 *
 * 由 {@link useProgressiveRenderCount} 提供 ref 与 `revealMore`。
 */
export const LoadMoreTasksSentinel = forwardRef<HTMLDivElement, { remainingCount: number; onReveal: () => void }>(
	function LoadMoreTasksSentinel({ remainingCount, onReveal }, ref) {
		return (
			<div ref={ref} className="flex justify-center pt-1 pb-0.5">
				<button
					type="button"
					onClick={onReveal}
					className="rounded-md px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-secondary"
				>
					还有 {remainingCount} 个 · 滚动或点击加载
				</button>
			</div>
		);
	},
);
