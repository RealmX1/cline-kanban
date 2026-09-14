import { useCallback } from "react";

// 引导定位框架的锚点契约（plan Stage 4）：目标 UI 元素挂 `data-verification-anchor="<key>"`，
// 引导人工型验证的 guidance.anchor.anchorKey 指向该 key；触发时 spotlightAnchor 把元素滚入视野并临时高亮。
// 用 data 属性而非 CSS selector：class / DOM 结构重构不破锚点契约，更健壮。
export const VERIFICATION_ANCHOR_ATTR = "data-verification-anchor";

// 元素被 spotlight 时临时挂的类（样式在 globals.css，几秒后由 spotlightAnchor 摘除）。
export const VERIFICATION_SPOTLIGHT_CLASS = "verification-spotlight-active";

// 默认高亮持续时长。
const DEFAULT_SPOTLIGHT_DURATION_MS = 2800;

// 每个元素上「到点摘掉高亮类」的在途定时器。同一元素被再次 spotlight 时必须先撤掉旧的，
// 否则上一次留下的定时器会在旧时刻把新一轮高亮提前掐灭（连点同一目标时必现）。
const pendingSpotlightRemovalTimerByElement = new WeakMap<Element, number>();

// ── 稳定 key 构造器：目标组件与 authoring skill 共用同一套命名，避免手写魔法字符串 ──

// 看板列上的任务卡（BoardCard）。
export function boardTaskCardAnchorKey(taskId: string): string {
	return `board-task-card:${taskId}`;
}

// 看板某一列容器。
// 注意：这是「按需扩展」键——当前没有任何看板列容器组件默认挂 `data-verification-anchor`。
// 创作列级引导验证时，须在同一变更内给目标列容器挂上本 key 对应的锚点属性，
// 否则 spotlightAnchor 必然未命中、只能走降级路径。
export function boardColumnAnchorKey(columnId: string): string {
	return `board-column:${columnId}`;
}

// Focus / Detail 视图的任务详情容器。
export function taskDetailAnchorKey(taskId: string): string {
	return `task-detail:${taskId}`;
}

// 验证面板内某任务卡。
export function verificationPanelTaskAnchorKey(taskId: string): string {
	return `verification-panel-task:${taskId}`;
}

// 顶栏里打开任务 Spotlight 搜索的常驻入口。单例、不带 id：全局同时只存在一个。
// 它的真机可达性（窄屏是否被顶栏左区裁掉、触控目标是否够大）只有真实设备才验得到，
// 因此这个锚点由引导人工型验证消费。
export function topBarTaskSpotlightSearchTriggerAnchorKey(): string {
	return "top-bar-task-spotlight-search-trigger";
}

// 顶栏里的应用内通知中心铃铛。单例、不带 id：全局同时只存在一个。
// 它背后的「全部历史」弹窗要验的东西（真实多 repo 历史的时间排序、跨重启的已读持久化、
// 真浏览器里的 header 布局）都只有真实运行实例才验得到，因此这个锚点由引导人工型验证消费。
export function topBarNotificationCenterBellTriggerAnchorKey(): string {
	return "top-bar-notification-center-bell-trigger";
}

// 把某 anchorKey 对应的元素滚入视野并临时高亮。返回是否命中元素（未命中 → 调用方走降级路径）。
// 用 querySelectorAll + getAttribute 精确比对，避免 agent 自由字符串 key 进 CSS 选择器时的转义问题。
// 可重播：对同一元素连续调用时，每一次都会从头重放脉冲动画并重新计时，而不是被上一次的残留状态吞掉。
export function spotlightAnchor(anchorKey: string, options?: { durationMs?: number }): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	let matchedTarget: Element | null = null;
	for (const candidate of document.querySelectorAll(`[${VERIFICATION_ANCHOR_ATTR}]`)) {
		if (candidate.getAttribute(VERIFICATION_ANCHOR_ATTR) === anchorKey) {
			matchedTarget = candidate;
			break;
		}
	}
	if (!matchedTarget) {
		return false;
	}
	const spotlightTargetElement = matchedTarget;
	spotlightTargetElement.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

	const pendingRemovalTimer = pendingSpotlightRemovalTimerByElement.get(spotlightTargetElement);
	if (pendingRemovalTimer !== undefined) {
		window.clearTimeout(pendingRemovalTimer);
		pendingSpotlightRemovalTimerByElement.delete(spotlightTargetElement);
	}
	// 高亮类若还留在元素上，单纯 add 是空操作、CSS 脉冲动画不会重新播放；
	// 必须「摘掉 → 强制一次同步重排 → 挂回」，getBoundingClientRect 就是那次强制重排。
	spotlightTargetElement.classList.remove(VERIFICATION_SPOTLIGHT_CLASS);
	spotlightTargetElement.getBoundingClientRect();
	spotlightTargetElement.classList.add(VERIFICATION_SPOTLIGHT_CLASS);

	const durationMs = options?.durationMs ?? DEFAULT_SPOTLIGHT_DURATION_MS;
	pendingSpotlightRemovalTimerByElement.set(
		spotlightTargetElement,
		window.setTimeout(() => {
			pendingSpotlightRemovalTimerByElement.delete(spotlightTargetElement);
			spotlightTargetElement.classList.remove(VERIFICATION_SPOTLIGHT_CLASS);
		}, durationMs),
	);
	return true;
}

// spotlightAnchor 的 hook 包装（稳定引用，供组件在 effect / callback 里用）。
export function useSpotlightAnchor(): (anchorKey: string, options?: { durationMs?: number }) => boolean {
	return useCallback(
		(anchorKey: string, options?: { durationMs?: number }) => spotlightAnchor(anchorKey, options),
		[],
	);
}
