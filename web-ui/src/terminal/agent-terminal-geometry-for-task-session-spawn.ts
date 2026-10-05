import { loadDetailTerminalPanelWidth } from "@/resize/detail-terminal-panel-width";
import { MIN_DETAIL_DIFF_PANEL_WIDTH_PX } from "@/resize/use-card-detail-layout";
import {
	clampPanelWidthToWindow,
	estimateTaskAgentTerminalGeometry,
	type TaskSessionGeometry,
} from "@/runtime/task-session-geometry";
import { getTerminalGeometry } from "@/terminal/terminal-geometry-registry";

// 起 agent 会话时给 PTY 的尺寸：终端已挂载过就用实测的 per-task 几何；从没挂载过就按用户持久化的详情终端面板
// 宽度估算，并用当前窗口宽度做上界——TUI 按启动宽度硬折行历史，起错宽度之后的 resize 修不回来。
// 浏览器直接起会话（runtime.startTaskSession）与经 taskCardAction 起会话共用这一份估算。
//
// 持久化宽度被钳在 [320, 1400]，但没有钳到**当前**窗口：宽窗口下存的宽度可能超过窄窗口能显示的宽度（详情页把
// agent 面板渲染成 min(persisted, container − MIN_DETAIL_DIFF_PANEL_WIDTH_PX)）。`window.innerWidth` 只是（尚未
// 挂载的）详情容器宽度的宽松上界；clampPanelWidthToWindow 在拿不到窗口宽度时回落到持久化宽度，所以不会比改动前更窄。
export function resolveAgentTerminalGeometryForTaskSessionSpawn(taskId: string): TaskSessionGeometry {
	const windowDisplayableTerminalPanelWidth = clampPanelWidthToWindow(
		loadDetailTerminalPanelWidth(),
		MIN_DETAIL_DIFF_PANEL_WIDTH_PX,
		window.innerWidth,
	);
	return (
		getTerminalGeometry(taskId) ??
		estimateTaskAgentTerminalGeometry(windowDisplayableTerminalPanelWidth, window.innerHeight)
	);
}
