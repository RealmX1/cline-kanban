import { MemoryStick } from "lucide-react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeLiveTaskResourceUsageSnapshot } from "@/runtime/types";
import { useTaskResourceUsageSnapshotValue } from "@/stores/task-resource-usage-snapshot-store";

export function formatResourceUsageKibibytesCompact(kibibytes: number): string {
	if (kibibytes >= 1024 * 1024) {
		return `${(kibibytes / (1024 * 1024)).toFixed(1)}G`;
	}
	return `${Math.max(1, Math.round(kibibytes / 1024))}M`;
}

export function buildTaskResourceUsagePillTooltipContent(snapshot: RuntimeLiveTaskResourceUsageSnapshot): string {
	const lines = [
		`进程 ${snapshot.attributedProcessCount} 个 · RSS 上界 ${formatResourceUsageKibibytesCompact(snapshot.residentSetSizeKibibytesSumUpperBound)}`,
	];
	if (snapshot.cpuPercentOfOneCoreOverLastSampleInterval !== null) {
		lines.push(`CPU ${snapshot.cpuPercentOfOneCoreOverLastSampleInterval}%（单核 = 100%）`);
	}
	if (snapshot.agentHarnessRootPhysicalFootprintBytes !== null) {
		lines.push(
			`harness 根进程 footprint ${formatResourceUsageKibibytesCompact(Math.round(snapshot.agentHarnessRootPhysicalFootprintBytes / 1024))}`,
		);
	}
	if (snapshot.survivedSessionRootExitProcessCount > 0) {
		lines.push(
			`⚠ 会话已结束仍在运行的残留进程 ${snapshot.survivedSessionRootExitProcessCount} 个（${formatResourceUsageKibibytesCompact(snapshot.survivedSessionRootExitResidentSetSizeKibibytesSum)}）`,
		);
	}
	lines.push("RSS 求和含共享页，是上界");
	return lines.join("\n");
}

/**
 * 卡片头部药丸条里的一段：这个 task 此刻的内存（进程树 RSS 上界）与 CPU。叶子组件自己按卡片 id 订阅
 * store，卡体不因每 15 秒的快照重渲染；没有归因到的进程（会话没在跑）时整段不渲染。
 * 有残留孤儿进程时整段转为警示色——它们是会话结束后仍在吃内存的泄漏。
 */
export function TaskCardResourceUsagePill({
	taskCardId,
	isTrashCard,
	revealHoverActionTooltip,
}: {
	taskCardId: string;
	isTrashCard: boolean;
	// 由 TaskCardBody 提供的 hover 门控（只在卡片 hover 时挂 tooltip），契约见那里的注释。
	revealHoverActionTooltip: (label: string | null) => string | undefined;
}): React.ReactElement | null {
	const snapshot = useTaskResourceUsageSnapshotValue(taskCardId);
	if (!snapshot || snapshot.attributedProcessCount === 0) {
		return null;
	}
	const hasSurvivingOrphanProcesses = snapshot.survivedSessionRootExitProcessCount > 0;
	return (
		<>
			<span className="text-text-tertiary">·</span>
			<Tooltip content={revealHoverActionTooltip(buildTaskResourceUsagePillTooltipContent(snapshot))}>
				<span
					data-task-resource-usage-pill=""
					className={cn(
						"inline-flex items-center gap-0.5 text-[10px] leading-none tabular-nums",
						hasSurvivingOrphanProcesses
							? "text-status-orange"
							: isTrashCard
								? "text-text-tertiary"
								: "text-text-secondary",
					)}
				>
					<MemoryStick size={8} className="shrink-0" />
					{formatResourceUsageKibibytesCompact(snapshot.residentSetSizeKibibytesSumUpperBound)}
					{snapshot.cpuPercentOfOneCoreOverLastSampleInterval !== null &&
					snapshot.cpuPercentOfOneCoreOverLastSampleInterval >= 1
						? ` ${Math.round(snapshot.cpuPercentOfOneCoreOverLastSampleInterval)}%`
						: null}
				</span>
			</Tooltip>
		</>
	);
}
