import { loadDetailTerminalPanelWidth } from "@/resize/detail-terminal-panel-width";
import { MIN_DETAIL_DIFF_PANEL_WIDTH_PX } from "@/resize/use-card-detail-layout";
import {
	clampPanelWidthToWindow,
	estimateTaskAgentTerminalGeometry,
	type TaskSessionGeometry,
} from "@/runtime/task-session-geometry";
import { getTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { matchesMobileViewportNow } from "@/utils/mobile-viewport-breakpoint";

// 起 agent 会话时给 PTY 的尺寸：终端已挂载过就用实测的 per-task 几何；从没挂载过就按用户持久化的详情终端面板
// 宽度估算，并用当前窗口宽度做上界——TUI 按启动宽度硬折行历史，起错宽度之后的 resize 修不回来。
// 浏览器直接起会话（runtime.startTaskSession）与经 taskCardAction 起会话共用这一份估算。
//
// 手机详情页的终端与 diff 分属不同 tab，终端使用整页宽度。后台启动时若仍扣掉桌面 diff 面板的 360px，
// 常见手机视口会被估成 1–3 列，Codex 无法显示就绪提示符，首条 prompt 便会等到打开详情后的 resize 才投递。
// 桌面仍按持久化面板宽度估算，并为并排 diff 留出空间。
export function resolveAgentTerminalGeometryForTaskSessionSpawn(taskId: string): TaskSessionGeometry {
	const measuredTerminalGeometry = getTerminalGeometry(taskId);
	if (measuredTerminalGeometry) return measuredTerminalGeometry;
	const windowDisplayableTerminalPanelWidth =
		matchesMobileViewportNow() && Number.isFinite(window.innerWidth) && window.innerWidth > 0
			? window.innerWidth
			: clampPanelWidthToWindow(loadDetailTerminalPanelWidth(), MIN_DETAIL_DIFF_PANEL_WIDTH_PX, window.innerWidth);
	return estimateTaskAgentTerminalGeometry(windowDisplayableTerminalPanelWidth, window.innerHeight);
}
