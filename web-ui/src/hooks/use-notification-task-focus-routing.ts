import { useCallback, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { buildProjectPathname } from "@/hooks/app-utils";
import { requestWorkspaceTabFocusViaServiceWorker } from "@/utils/workspace-tab-focus-via-service-worker";

// 应用内通知点击（铃铛面板 / 通知完整日志）定位 task 的「发送侧」路由，与「接收侧」
// use-notification-task-focus.ts（监听 SW 转发的 focus-task-from-notification）成对：
//  ① 同项目：交给 openTaskInProjectInPlace 的同项目分支选中（找不到卡时提示、不清掉当前 Focus View）；
//  ② 本 tab 正切向目标项目途中：交给原地跳转（它挂 pending、目标 board 加载出该任务后再选中）；
//  ③ 真·跨项目：经 SW 中转定位既有目标项目标签页，聚焦成功时本 tab 保持不动；没有开着目标项目的标签页、
//     浏览器不许切过去（当前 Chromium 的常态）、或机制不可用时，在本 tab **原地跳转**——与跨项目切换面板、Board Overview 走同一条
//     openTaskInProjectInPlace（use-cross-project-task-open-in-project.ts），不再新开深链标签页：
//     一个标签页管全部项目是一等用法（docs/context-cross-project-recently-active-task-switcher.md）。
export function useNotificationTaskFocusRouting(input: {
	currentProjectId: string | null;
	isProjectSwitching: boolean;
	navigationCurrentProjectId: string | null;
	openTaskInProjectInPlace: (workspaceId: string, taskId: string) => void;
}): { focusNotificationTask: (workspaceId: string, taskId: string) => void } {
	const { currentProjectId, isProjectSwitching, navigationCurrentProjectId, openTaskInProjectInPlace } = input;

	// 迟到降级守卫（两把锁，缺一不可）：分支③的 .then 回调最长 ~1.5s 后才 resolve
	//（WORKSPACE_TAB_FOCUS_RESPONSE_TIMEOUT_MS 超时兜底），而降级会写 pending 并 in-tab
	// 切项目。这 1.5s 窗口内：
	//  - 用户又点击了别的通知 → token 锁：每次 focusNotificationTask 调用递增 token，
	//    回调仅当自己仍是最新调用时才允许降级（乱序 resolve 时保证「最新点击胜出」——
	//    只靠导航意图校验会让早点击的降级先落地、反过来否决晚点击）；
	//  - 用户显式切了项目（项目切换器不经过本 hook，token 不变）→ 导航意图锁：镜像最新
	//    navigationCurrentProjectId 的 ref，回调降级前校验导航意图与点击时刻一致。
	// 任一锁失效 → 静默放弃降级，绝不用陈旧闭包覆盖更新的导航意图、劫持当前标签页。
	const latestFocusNotificationTaskInvocationTokenRef = useRef(0);
	const latestNavigationCurrentProjectIdRef = useRef(navigationCurrentProjectId);
	// render 期同步赋值即 react-use useLatest 的标准实现（本地 wrapper 未导出该 hook）。
	latestNavigationCurrentProjectIdRef.current = navigationCurrentProjectId;

	const focusNotificationTask = useCallback(
		(workspaceId: string, taskId: string) => {
			// 每次通知点击都是更新的导航意图：递增 token，使所有仍在途的旧分支③回调失效。
			latestFocusNotificationTaskInvocationTokenRef.current += 1;
			const invocationTokenForThisNotificationClick = latestFocusNotificationTaskInvocationTokenRef.current;
			const navigationCurrentProjectIdAtNotificationClickTime = navigationCurrentProjectId;
			// ① 目标项目已在本 tab 完全落地（loaded 且非切换中）→ 交给统一入口的同项目分支选中——与下方 pending-effect
			// 同轴（currentProjectId）。若只看 navigationCurrentProjectId（导航意图），切换在途时会
			// 过早 setSelectedTaskId，随后被 useDetailTaskNavigation 切项目的 closeDetail 清掉且无
			// pending 恢复，通知点击打不开详情。
			if (workspaceId === currentProjectId && !isProjectSwitching) {
				openTaskInProjectInPlace(workspaceId, taskId);
				return;
			}
			// ② 本 tab 的导航意图已指向目标（正切向目标项目途中）→ 原地跳转只挂 pending 待落地选中
			// （它调的 handleSelectProject 对相等 projectId 自带 no-op 守卫，不会重复切）。
			if (workspaceId === navigationCurrentProjectId) {
				openTaskInProjectInPlace(workspaceId, taskId);
				return;
			}
			// ③ 真·跨项目：SW 中转定位目标项目的既有标签页；本 tab 不切项目。
			// helper 从此处到 postMessage 全程同步，保持点击 transient activation 有效。
			void requestWorkspaceTabFocusViaServiceWorker({
				workspaceId,
				taskId,
				workspacePathname: buildProjectPathname(workspaceId),
			}).then((result) => {
				if (result === "focused-existing-tab") {
					// 目标标签页已被聚焦并收到选中消息，本 tab 无事可做。
					return;
				}
				if (result === "task-selected-in-background-tab") {
					// 浏览器拒绝页面发起的跨 tab 聚焦（Chromium 只在 notificationclick 内允许，
					// 见 public/sw.js 注释）；任务已在目标标签页后台就位，引导用户手动切换。
					showAppToast(
						{
							message:
								"已在目标项目的标签页中打开该任务，请手动切换到该标签页查看（浏览器不允许页面自动切换标签页）。",
						},
						"notification-task-selected-in-background-tab",
					);
					return;
				}
				// no-existing-tab / existing-tab-focus-denied-by-browser（有目标 tab 但浏览器不许切过去，
				// SW 没把消息投给它）/ mechanism-unavailable（无 controller / 旧 SW 超时 / SW 异常）
				// → 本 tab 原地跳转。
				// 仅此分支需要迟到守卫：focused-existing-tab 零副作用；task-selected-in-background-tab
				// 只弹 toast（任务确已在目标 tab 后台就位，陈述迟到也依然为真，且不动本 tab 导航）。
				// 唯有此处会在 1.5s 往返之后 in-tab 切项目。
				const invocationSupersededByNewerNotificationClick =
					latestFocusNotificationTaskInvocationTokenRef.current !== invocationTokenForThisNotificationClick;
				const navigationIntentChangedSinceNotificationClick =
					latestNavigationCurrentProjectIdRef.current !== navigationCurrentProjectIdAtNotificationClickTime;
				if (invocationSupersededByNewerNotificationClick || navigationIntentChangedSinceNotificationClick) {
					// 迟到的降级不得覆盖更新的点击 / 显式导航 → 静默放弃。
					return;
				}
				openTaskInProjectInPlace(workspaceId, taskId);
			});
		},
		[currentProjectId, isProjectSwitching, navigationCurrentProjectId, openTaskInProjectInPlace],
	);

	return { focusNotificationTask };
}
