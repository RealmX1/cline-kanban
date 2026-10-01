import { ChevronDown, ChevronUp, MemoryStick } from "lucide-react";
import { type ReactElement, useState } from "react";

import { formatResourceUsageKibibytesCompact } from "@/components/task-card-resource-usage-pill";
import { Button } from "@/components/ui/button";
import { useTaskResourceUsageSnapshotValue } from "@/stores/task-resource-usage-snapshot-store";

// 任务详情里的「资源占用」小节：卡片药丸的展开版——按进程分类拆开的内存、各 MCP 实例、残留进程。
// 数据是运行时进程树采样器每 15 秒推来的实时快照；历史走势请用 `kanban diagnostics task-resource-usage-report`。

const PROCESS_CLASSIFICATION_LABEL: Record<string, string> = {
	agent_harness_root_process: "agent harness 本体",
	mcp_server_launcher_wrapper_process: "MCP 启动器（npx / uvx）",
	mcp_server_process: "MCP server",
	agent_harness_helper_process: "harness 辅助进程",
	agent_shell_tool_command_process: "agent 运行的命令",
	kanban_hook_cli_process: "Kanban hook CLI",
	nested_agent_harness_process: "嵌套 agent（claude -p 等）",
	user_shell_terminal_root_process: "用户终端 shell",
	user_shell_terminal_descendant_process: "用户终端里的程序（dev server 等）",
	kanban_runtime_spawned_task_process: "Kanban 为该任务启动的进程",
	orphaned_process_recovered_by_kanban_environment_variables: "残留进程（重启前遗留）",
};

function formatTokenCountCompact(tokenCount: number): string {
	if (tokenCount >= 1_000_000) {
		return `${(tokenCount / 1_000_000).toFixed(1)}M`;
	}
	if (tokenCount >= 1_000) {
		return `${Math.round(tokenCount / 1_000)}k`;
	}
	return String(tokenCount);
}

export function TaskResourceUsageDetailPanel({ taskCardId }: { taskCardId: string }): ReactElement | null {
	const snapshot = useTaskResourceUsageSnapshotValue(taskCardId);
	const [isBreakdownVisible, setIsBreakdownVisible] = useState(false);
	if (!snapshot || snapshot.attributedProcessCount === 0) {
		return null;
	}
	const classificationRows = Object.entries(
		snapshot.residentSetSizeKibibytesSumUpperBoundByProcessClassification,
	).sort((left, right) => right[1] - left[1]);
	return (
		<section className="shrink-0 border-b border-border" aria-label="资源占用">
			<div className="flex items-center gap-2 px-3 py-1">
				<MemoryStick size={14} className="shrink-0 text-text-secondary" />
				<button
					type="button"
					className="min-w-0 flex-1 cursor-pointer text-left text-[11px] text-text-secondary tabular-nums hover:text-text-primary"
					onClick={() => setIsBreakdownVisible((value) => !value)}
				>
					资源占用 · {snapshot.attributedProcessCount} 个进程 · RSS 上界{" "}
					{formatResourceUsageKibibytesCompact(snapshot.residentSetSizeKibibytesSumUpperBound)}
					{snapshot.cpuPercentOfOneCoreOverLastSampleInterval !== null
						? ` · CPU ${Math.round(snapshot.cpuPercentOfOneCoreOverLastSampleInterval)}%`
						: ""}
					{snapshot.survivedSessionRootExitProcessCount > 0 ? (
						<span className="text-status-orange"> · 残留 {snapshot.survivedSessionRootExitProcessCount} 个</span>
					) : null}
				</button>
				<Button
					variant="ghost"
					size="xs"
					icon={isBreakdownVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					onClick={() => setIsBreakdownVisible((value) => !value)}
					aria-label={isBreakdownVisible ? "收起资源占用明细" : "展开资源占用明细"}
				/>
			</div>
			{isBreakdownVisible ? (
				<div className="space-y-2 border-t border-border px-3 py-2 text-[11px] text-text-secondary tabular-nums">
					<table className="w-full">
						<tbody>
							{classificationRows.map(([classification, residentSetSizeKibibytes]) => (
								<tr key={classification}>
									<td className="py-0.5 pr-2">
										{PROCESS_CLASSIFICATION_LABEL[classification] ?? classification}
									</td>
									<td className="py-0.5 pr-2 text-right">
										{snapshot.processCountByProcessClassification[classification] ?? 0}
									</td>
									<td className="py-0.5 text-right">
										{formatResourceUsageKibibytesCompact(residentSetSizeKibibytes)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{snapshot.mcpServerInstances.length > 0 ? (
						<p>
							MCP：
							{snapshot.mcpServerInstances
								.map(
									(instance) =>
										`${instance.mcpServerInstanceLabel} ${formatResourceUsageKibibytesCompact(instance.residentSetSizeKibibytesSum)}`,
								)
								.join("，")}
						</p>
					) : null}
					{snapshot.agentHarnessRootPhysicalFootprintBytes !== null ? (
						<p>
							harness 根进程 footprint（整机真实代价，每 10 分钟采一次）：
							{formatResourceUsageKibibytesCompact(
								Math.round(snapshot.agentHarnessRootPhysicalFootprintBytes / 1024),
							)}
						</p>
					) : null}
					{snapshot.modelTokenUsageAcrossTaskSessions ? (
						<p>
							模型 token（{snapshot.modelTokenUsageAcrossTaskSessions.sessionCount} 个会话累计）：输入{" "}
							{formatTokenCountCompact(snapshot.modelTokenUsageAcrossTaskSessions.cumulativeInputTokens)} ·
							缓存写{" "}
							{formatTokenCountCompact(
								snapshot.modelTokenUsageAcrossTaskSessions.cumulativeCacheCreationInputTokens,
							)}{" "}
							· 缓存读{" "}
							{formatTokenCountCompact(
								snapshot.modelTokenUsageAcrossTaskSessions.cumulativeCacheReadInputTokens,
							)}{" "}
							· 输出 {formatTokenCountCompact(snapshot.modelTokenUsageAcrossTaskSessions.cumulativeOutputTokens)}
						</p>
					) : null}
					{snapshot.latestWorktreeDiskUsageBytes != null ? (
						<p>
							worktree 磁盘（不含软链的依赖，最近一次测量）：
							{formatResourceUsageKibibytesCompact(Math.round(snapshot.latestWorktreeDiskUsageBytes / 1024))}
						</p>
					) : null}
					{snapshot.survivedSessionRootExitProcessCount > 0 ? (
						<p className="text-status-orange">
							会话已结束、仍在运行的残留进程 {snapshot.survivedSessionRootExitProcessCount} 个，合计{" "}
							{formatResourceUsageKibibytesCompact(snapshot.survivedSessionRootExitResidentSetSizeKibibytesSum)}
							——通常是 agent 用后台方式启动、会话结束时没被一并结束的命令。
						</p>
					) : null}
					<p className="text-text-tertiary">RSS 求和含多个进程共享的页，是上界。</p>
				</div>
			) : null}
		</section>
	);
}
