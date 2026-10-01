import { type RefObject, useEffect } from "react";

/**
 * 「视口底边 → 虚拟按键条顶边」的距离，以 CSS 变量发布在 `<html>` 上。
 *
 * 验证面板和引导浮层使用 fixed 定位，需要读取按键条的实测让位量，避免挡住方向键和 Enter。
 * 按键条布局变化时持续更新，消费方不再硬编码按键条高度。
 *
 * 发布的量**不是**按键条自身高度：`agent-terminal-panel.tsx` 在按键条之后还会渲染 lastError
 * 横幅与 review 动作块（Commit / Open PR / Move Card To Validation / Move Card To Done），
 * 在 review / validation 两列这些兄弟节点真实存在，按键条并不贴着视口底。发布高度等于默认
 * 「按键条紧贴视口底」，一旦下方有兄弟内容，浮层就少抬了正好那么多、重新压回按键上。
 *
 * 变量未定义时消费方一律回落到 `0px`（见 globals.css 的 `.kb-viewport-bottom-verification-floating-panel`），
 * 所以桌面端与任何没有按键条的视图都保持原来的位置，不需要额外分支。
 */
export const TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME =
	"--kb-terminal-virtual-key-bar-viewport-bottom-inset";

/**
 * 实测「视口底边 → 按键条顶边」的像素距离，即 fixed 浮层想完全避开按键条所需的最小抬升量。
 *
 * 基准取 `documentElement.clientHeight` 而非 `window.innerHeight` / `visualViewport.height`：
 * 消费方是 `position: fixed` + `bottom: calc(... + var(...))`，其包含块是 layout viewport（ICB），
 * 而 `getBoundingClientRect()` 用的正是同一套视口坐标系，两边同源相减才得到真实间距。
 * `innerHeight` 含滚动条尺寸，`visualViewport` 描述的是 pinch-zoom / 软键盘之后的可视窗口——
 * fixed 元素并不以它为基准，混进来只会引入固定偏差。
 *
 * 刻意写成不依赖模块作用域的纯函数：`tests/verification-floating-panel-clears-virtual-key-bar.spec.ts`
 * 会把它整段序列化进浏览器执行，测的必须是这里的真实口径而不是测试里抄的一份副本。
 */
export function measureTerminalVirtualKeyBarViewportBottomInsetPx(barElement: HTMLElement): number {
	const fixedPositioningViewportHeightPx = barElement.ownerDocument.documentElement.clientHeight;
	const barTopEdgeOffsetFromViewportTopPx = barElement.getBoundingClientRect().top;
	return Math.max(0, Math.round(fixedPositioningViewportHeightPx - barTopEdgeOffsetFromViewportTopPx));
}

/**
 * 把 `barElementRef` 指向的按键条的视口底部让位量持续同步到上面那个 CSS 变量，卸载时清除。
 *
 * 全部实测而非算常量：按键条高度会随字号缩放、安全区内边距、以及将来增删按键而变，它离视口底
 * 多远更是随下方兄弟节点增删而变，实测才不会与 浮层 的让位量脱节。
 *
 * 观察面比「只盯按键条自己」宽，因为要发布的量会在按键条自身尺寸没变时改变：
 * - `ResizeObserver` 盯按键条**及其下方所有兄弟节点**（lastError 横幅、review 动作块……），
 *   任何一块变高变矮都会推动按键条顶边相对视口底的位置；父容器一并盯着，捕获整面板的伸缩。
 * - `MutationObserver` 盯父容器的 childList：兄弟节点是条件渲染的，增删时要重新登记观察对象
 *   （ResizeObserver 不会自动跟上一个尚未存在的节点）。
 * - `resize` 事件捕获视口本身的变化（旋屏、移动端地址栏收展）。
 */
export function usePublishTerminalVirtualKeyBarViewportBottomInset(barElementRef: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const barElement = barElementRef.current;
		if (!barElement || typeof ResizeObserver === "undefined") {
			return;
		}
		const rootElementStyle = document.documentElement.style;
		const publishCurrentViewportBottomInset = (): void => {
			rootElementStyle.setProperty(
				TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME,
				`${measureTerminalVirtualKeyBarViewportBottomInsetPx(barElement)}px`,
			);
		};

		const barParentElement = barElement.parentElement;
		const resizeObserver = new ResizeObserver(publishCurrentViewportBottomInset);
		const reobserveBarAndEverythingStackedBelowIt = (): void => {
			resizeObserver.disconnect();
			resizeObserver.observe(barElement);
			if (barParentElement) {
				resizeObserver.observe(barParentElement);
			}
			for (
				let siblingBelowBar = barElement.nextElementSibling;
				siblingBelowBar !== null;
				siblingBelowBar = siblingBelowBar.nextElementSibling
			) {
				resizeObserver.observe(siblingBelowBar);
			}
			publishCurrentViewportBottomInset();
		};
		reobserveBarAndEverythingStackedBelowIt();

		let siblingListMutationObserver: MutationObserver | null = null;
		if (barParentElement && typeof MutationObserver !== "undefined") {
			siblingListMutationObserver = new MutationObserver(reobserveBarAndEverythingStackedBelowIt);
			siblingListMutationObserver.observe(barParentElement, { childList: true });
		}

		window.addEventListener("resize", publishCurrentViewportBottomInset);

		return () => {
			resizeObserver.disconnect();
			siblingListMutationObserver?.disconnect();
			window.removeEventListener("resize", publishCurrentViewportBottomInset);
			rootElementStyle.removeProperty(TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME);
		};
	}, [barElementRef]);
}
