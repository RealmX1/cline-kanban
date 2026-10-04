import { X } from "lucide-react";
import { type ReactElement, useState } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { loadDetailTaskCardsPanelRatioPreference } from "@/resize/use-card-detail-layout";

/**
 * 从 Focus View 跨项目打开任务、目标项目 board 还没加载出来的这段时间里，顶替详情页的外壳。
 *
 * 在途全程都由它顶替详情页（见 use-cross-project-recently-active-task-switcher-host）：切项目开始时 board 不清空，
 * 留着旧详情页的话它会撑过整个 WS 重连、一点点掉内容，快照到达那一帧还会拿旧卡配新项目去挂终端。外壳按详情页
 * 同一比例摆左栏——与 Board Scope 下 Focus View 的左栏一样，就是跨项目切换面板本身（数据来自全局的 projects
 * 广播，切项目时不清空；滚动位置等临时状态经 cross-project-task-switcher-panel-view-continuity-store 接上），
 * 右侧显示正在打开哪个任务；用户可以在这期间继续点别的任务改主意，或 Cancel 回到发起时的任务。
 */
export function FocusViewCrossProjectTaskOpenInTransitShell({
	host,
	targetProjectName,
	targetTaskTitle,
	onCancel,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	targetProjectName: string | null;
	targetTaskTitle: string | null;
	onCancel: () => void;
}): ReactElement {
	const [taskCardsPanelRatio] = useState(loadDetailTaskCardsPanelRatioPreference);
	return (
		<div
			className="flex min-h-0 flex-1 overflow-hidden bg-surface-0"
			data-testid="focus-view-cross-project-task-open-in-transit-shell"
		>
			<div
				className="flex min-h-0 min-w-0 flex-col border-r border-border"
				style={{ width: `${(taskCardsPanelRatio * 100).toFixed(1)}%` }}
			>
				<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} />
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 text-text-secondary">
				<div className="flex items-center gap-2 text-sm">
					<Spinner size={16} />
					<span>
						Opening <span className="font-semibold text-text-primary">{targetTaskTitle ?? "task"}</span>
						{targetProjectName ? (
							<>
								{" "}
								in <span className="font-semibold text-text-primary">{targetProjectName}</span>
							</>
						) : null}
						…
					</span>
				</div>
				<Button variant="ghost" size="sm" icon={<X size={14} />} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
