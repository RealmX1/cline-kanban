// 「当前视口是否为移动端」这一事实的单一真源。
//
// 该断点此前散落在四处各写各的：`use-is-mobile.ts` 的媒体查询串、`globals.css` 的三段
// `@media` 规则、`cline-chat-composer.tsx` 里一次性的裸 `matchMedia`。数值与 Tailwind 默认
// 的 `md` 同为 768px 属于巧合而非显式对齐，故这里把数值与查询串一并导出。
//
// CSS 侧无法 import 本模块，`globals.css` 的 `@media (max-width: 768px)` 仍是手写的平行副本；
// 改动断点时两侧必须一起改。

export const MOBILE_VIEWPORT_MAX_WIDTH_PX = 768;

export const MOBILE_VIEWPORT_MEDIA_QUERY = `(max-width: ${MOBILE_VIEWPORT_MAX_WIDTH_PX}px)`;

/**
 * 非响应式的即时查询，供无法使用 React hook 的场合（如 `PersistentTerminal` 这类
 * 长生命周期的普通类）。需要随断点变化重渲的组件一律用 `useIsMobile()`。
 */
export function matchesMobileViewportNow(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return window.matchMedia(MOBILE_VIEWPORT_MEDIA_QUERY).matches;
}
