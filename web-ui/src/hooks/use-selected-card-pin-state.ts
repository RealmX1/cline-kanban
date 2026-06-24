import type { RefObject } from "react";
import { useEffect, useState } from "react";

/**
 * Focus View 左侧列表中「被选中卡」相对滚动视口的钉住位置：
 * - `hidden`：选中卡（含其 CSS sticky 吸附位）还有任一像素在视口内 → 无需浮动钉住条，
 *   交给列内 CSS sticky 处理。
 * - `pinTop`：选中卡整体已滚出视口「上」沿（连同其所在 stage 一起被滚过）。
 * - `pinBottom`：选中卡整体在视口「下」沿之外。
 *
 * CSS sticky 只能在卡所属 stage 的 containing block 内吸附；一旦滚过该 stage 进入下一个 stage，
 * 选中卡就脱离 sticky 范围而消失。本 hook 侦测「整卡完全越界」并判定顶/底沿，交由浮动钉住条
 * 接管跨 stage 的持续可见，与列内 CSS sticky 无缝衔接（任一像素可见即 `hidden`）。
 *
 * 实现要点：状态以**实时几何**（`getBoundingClientRect`）为唯一真相，而非
 * `IntersectionObserver` 的 `isIntersecting`。原因是 IO 仅在「相交比例跨越阈值」时回调——当滚动
 * 被一次性大幅跳转（拖拽滚动条、`scrollTop=` 直接赋值）使卡片从视口「下方」瞬移到「上方」时，
 * 相交比例始终为 0、IO 不回调，pin 方向会停留在过时值。改为「滚动/尺寸/DOM 变化 → rAF 合并后
 * 读两次 rect 直接判定」，对突变跳转与连续滚动同样正确，且 rAF 合并保证不抖。
 */
export type SelectedCardPinState = "hidden" | "pinTop" | "pinBottom";

function escapeAttributeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export interface UseSelectedCardPinStateOptions {
	/** 被选中任务的 id；用于在滚动容器内定位真实卡片元素（`data-task-id`）。 */
	selectedTaskId: string;
	/** 滚动容器（`.kb-detail-task-list-scroll`）的 ref，作为几何判定的视口基准。 */
	scrollRootRef: RefObject<HTMLElement | null>;
	/** 为 `false` 时（如拖拽进行中，真实卡会被 portal 到 body 致目标丢失）暂停侦测并归为 `hidden`。 */
	enabled?: boolean;
}

export function useSelectedCardPinState({
	selectedTaskId,
	scrollRootRef,
	enabled = true,
}: UseSelectedCardPinStateOptions): SelectedCardPinState {
	const [pinState, setPinState] = useState<SelectedCardPinState>("hidden");

	useEffect(() => {
		if (!enabled) {
			setPinState("hidden");
			return;
		}
		const root = scrollRootRef.current;
		if (!root) {
			setPinState("hidden");
			return;
		}
		const selector = `[data-task-id="${escapeAttributeValue(selectedTaskId)}"]`;

		let frameId = 0;
		let target: Element | null = root.querySelector(selector);

		const resolveTarget = (): void => {
			if (!target || !target.isConnected || !root.contains(target)) {
				target = root.querySelector(selector);
			}
		};

		const computeNow = (): void => {
			frameId = 0;
			resolveTarget();
			if (!target) {
				// 选中卡尚未渲染（渐进渲染）/ 不在滚动容器内：归 hidden，待 DOM 变化重解析。
				setPinState("hidden");
				return;
			}
			const cardRect = target.getBoundingClientRect();
			// 折叠 stage（display:none）或未布局元素：尺寸为 0，视为不可见而非误钉到顶。
			if (cardRect.width === 0 && cardRect.height === 0) {
				setPinState("hidden");
				return;
			}
			const rootRect = root.getBoundingClientRect();
			if (cardRect.bottom <= rootRect.top) {
				setPinState("pinTop");
				return;
			}
			if (cardRect.top >= rootRect.bottom) {
				setPinState("pinBottom");
				return;
			}
			// 与视口仍有交叠（含 sticky 吸附位）→ 列内 CSS sticky 保证可见，浮动条让位。
			setPinState("hidden");
		};

		const scheduleCompute = (): void => {
			if (frameId !== 0) {
				return;
			}
			frameId = window.requestAnimationFrame(computeNow);
		};

		// 初次同步求值，避免首帧闪一帧 hidden。
		computeNow();

		// 滚动是主信号：覆盖连续滚动，也覆盖滚动条拖拽/编程式 scrollTop 的一次性大跳转。
		root.addEventListener("scroll", scheduleCompute, { passive: true });
		window.addEventListener("resize", scheduleCompute);
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleCompute);
		resizeObserver?.observe(root);
		// DOM/文本变化：渐进渲染挂载选中卡、stage 折叠展开、上方卡片活动文案换行改高度而推动选中卡。
		// `attributeFilter: ["style"]` 专门捕获 ColumnSection 折叠时对 section 包裹层的
		// `display:none`↔`block` 内联样式翻转（一次纯属性变更，不引发 childList）——否则当用户在「选中卡
		// 滚出视口、其 stage 卡头仍可见」时折叠该 stage，pin 状态不会重算，会残留一张已隐藏卡的克隆。
		// 仅过滤 style（不监听 class）以避开 hover 等高频 className 抖动带来的无谓回调。
		const mutationObserver = new MutationObserver(() => {
			resolveTarget();
			scheduleCompute();
		});
		mutationObserver.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["style"],
		});

		return () => {
			if (frameId !== 0) {
				window.cancelAnimationFrame(frameId);
			}
			root.removeEventListener("scroll", scheduleCompute);
			window.removeEventListener("resize", scheduleCompute);
			resizeObserver?.disconnect();
			mutationObserver.disconnect();
		};
	}, [selectedTaskId, enabled, scrollRootRef]);

	return pinState;
}
