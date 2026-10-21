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

// 顶栏项目切换器的触发按钮（范围控件：首行 All projects = Board Scope，其余为单个项目）。全局单例、不带 id。
// 跨项目切换面板的部署后引导验证（真实 Claude 回合结束进倒计时区、跨项目原地跳转不闪退）从这里起步。
export function topBarProjectSwitcherBoardOrSingleProjectScopeTriggerAnchorKey(): string {
	return "top-bar-project-switcher-board-or-single-project-scope-trigger";
}

// 顶栏的 All projects ⇄ 单项目切换按钮（Layers，与 ⌘⇧E 同一处理器）。只在看板页（非 Focus View）渲染，全局单例、不带 id。
// All projects 首页（跨项目切换面板分区横排的列看板）的部署后引导验证从这里起步。
export function topBarBoardScopeAllProjectsToggleButtonAnchorKey(): string {
	return "top-bar-board-scope-all-projects-toggle-button";
}

// 跨项目「最近活跃任务」切换面板里 Running / 缓存倒计时 / 剩余区的一行（Pinned 区的行不带它：Pinned 点击后
// 要跳到的正是下方区里的这一行）。taskId 跨项目会撞号，必须带 workspaceId。
export function crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId: string, taskId: string): string {
	return `cross-project-task-switcher-section-row:${workspaceId}:${taskId}`;
}

// All projects Focus View 的焦点任务展示与 Sticky 共用面板。副本不输出本体卡锚点。
export function crossProjectTaskSwitcherFocusedTaskVisibilityPanelAnchorKey(): string {
	return "cross-project-task-switcher-focused-task-visibility-panel";
}

// 看板某一列容器。
// 主看板的列容器（board-column.tsx）已挂本锚点；Focus View 的列面板（column-context-panel.tsx）仍未挂——
// 创作指向 Focus View 列的引导验证时，须在同一变更内给那边补上，否则 spotlightAnchor 只能走降级路径。
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

export function topBarTaskLookupWorkbenchTriggerAnchorKey(): string {
	return "top-bar-task-lookup-workbench-trigger";
}

// 顶栏里的应用内通知中心铃铛。单例、不带 id：全局同时只存在一个。
// 它背后的「全部历史」弹窗要验的东西（真实多 repo 历史的时间排序、跨重启的已读持久化、
// 真浏览器里的 header 布局）都只有真实运行实例才验得到，因此这个锚点由引导人工型验证消费。
export function topBarNotificationCenterBellTriggerAnchorKey(): string {
	return "top-bar-notification-center-bell-trigger";
}

// 详情视图里 Queue 页签的触发器（排队 prompt）。挂在**页签**上而不是队列面板上：用户可能停在 Prompts /
// Comments tab，页签条在三个 tab 下都渲染，闪它才是「从哪都看得见」。kanban 重启后聚焦任务时，
// 用它播 5 秒提醒「重启前排的，确认一下还要不要」。
export function queuedTaskPromptDeliveryQueueTabAnchorKey(taskId: string): string {
	return `queued-prompt-queue-tab:${taskId}`;
}

// 把某 anchorKey 对应的元素滚入视野并临时高亮。返回是否命中元素（未命中 → 调用方走降级路径）。
// 用 querySelectorAll + getAttribute 精确比对，避免 agent 自由字符串 key 进 CSS 选择器时的转义问题。
// 可重播：对同一元素连续调用时，每一次都会从头重放脉冲动画并重新计时，而不是被上一次的残留状态吞掉。
export interface SpotlightAnchorOptions {
	durationMs?: number;
	// 换一种高亮样式。默认是 Post-Deploy Verification 的蓝色导航脉冲；别的用途（例：排队 prompt 重启后的
	// warning 色提醒）用自己的 class——两件事共用一个 class，将来任一方调时长 / 配色都会串味。
	spotlightClassName?: string;
	// true（默认）= 平滑滚到视野中央；false = 不滚；"only_if_out_of_view" = 只在它不在视野里时就近滚一下
	// （例：详情头部的页签——常驻可见时一动不动，窄屏横向溢出的页签条里被挤出去时才滚回来）。
	scrollIntoView?: boolean | "only_if_out_of_view";
	// 高亮之前先确认它**真的**呈现在用户眼前：有面积、落在视口里、没被 display/visibility 藏起来、也没被
	// 模态层盖住。不满足时不挂高亮、返回 false。给「高亮了就算用户看见了」这类调用方用。
	requireVisibleToUser?: boolean;
}

// 元素此刻是否真的呈现在用户眼前。只看几何与遮挡，不看颜色对比度之类的主观因素。
export function isElementVisibleToUserInViewport(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return false;
	}
	const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
	const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
	if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) {
		return false;
	}
	const computedStyle = window.getComputedStyle(element);
	if (computedStyle.visibility === "hidden" || computedStyle.display === "none") {
		return false;
	}
	// 被模态层 / 浮层盖住：视口里那一点最上面的元素不是它（也不在它里面）。
	if (typeof document.elementFromPoint === "function") {
		const probeX = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
		const probeY = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);
		const topmostElement = document.elementFromPoint(probeX, probeY);
		if (topmostElement !== null && topmostElement !== element && !element.contains(topmostElement)) {
			return false;
		}
	}
	return true;
}

export function spotlightAnchor(anchorKey: string, options?: SpotlightAnchorOptions): boolean {
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
	const spotlightClassName = options?.spotlightClassName ?? VERIFICATION_SPOTLIGHT_CLASS;
	const scrollIntoViewMode = options?.scrollIntoView ?? true;
	if (scrollIntoViewMode === "only_if_out_of_view") {
		if (!isElementVisibleToUserInViewport(spotlightTargetElement)) {
			// 即时滚动（不是 smooth）：下面紧接着要同步判断它是否已经进入视野。
			spotlightTargetElement.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
		}
	} else if (scrollIntoViewMode) {
		spotlightTargetElement.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
	}
	if (options?.requireVisibleToUser && !isElementVisibleToUserInViewport(spotlightTargetElement)) {
		return false;
	}

	const pendingRemovalTimer = pendingSpotlightRemovalTimerByElement.get(spotlightTargetElement);
	if (pendingRemovalTimer !== undefined) {
		window.clearTimeout(pendingRemovalTimer);
		pendingSpotlightRemovalTimerByElement.delete(spotlightTargetElement);
	}
	// 高亮类若还留在元素上，单纯 add 是空操作、CSS 脉冲动画不会重新播放；
	// 必须「摘掉 → 强制一次同步重排 → 挂回」，getBoundingClientRect 就是那次强制重排。
	spotlightTargetElement.classList.remove(spotlightClassName);
	spotlightTargetElement.getBoundingClientRect();
	spotlightTargetElement.classList.add(spotlightClassName);

	const durationMs = options?.durationMs ?? DEFAULT_SPOTLIGHT_DURATION_MS;
	pendingSpotlightRemovalTimerByElement.set(
		spotlightTargetElement,
		window.setTimeout(() => {
			pendingSpotlightRemovalTimerByElement.delete(spotlightTargetElement);
			spotlightTargetElement.classList.remove(spotlightClassName);
		}, durationMs),
	);
	return true;
}

// spotlightAnchor 的 hook 包装（稳定引用，供组件在 effect / callback 里用）。
export function useSpotlightAnchor(): (anchorKey: string, options?: SpotlightAnchorOptions) => boolean {
	return useCallback((anchorKey: string, options?: SpotlightAnchorOptions) => spotlightAnchor(anchorKey, options), []);
}
