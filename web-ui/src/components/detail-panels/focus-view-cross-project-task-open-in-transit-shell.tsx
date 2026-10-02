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
 * 切项目会清空 board、关掉详情页（use-detail-task-navigation），没有它的话左栏会先闪成目标项目的看板、
 * 再在 board 加载完后重新挂回 Focus View。外壳按详情页同一比例摆一个只读 All projects 左栏（数据来自全局的
 * projects 广播，切项目时不清空），右侧显示正在打开哪个任务；用户可以在这期间继续点别的任务改主意。
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
				<div className="mx-2 mt-2 flex h-7 shrink-0 items-center rounded-md border border-border bg-surface-1 px-2 text-xs font-semibold text-text-primary">
					All projects
				</div>
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
