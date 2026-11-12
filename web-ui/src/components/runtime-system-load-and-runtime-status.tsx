import * as Popover from "@radix-ui/react-popover";
import { Activity, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useRuntimeSystemLoadAndRuntimeStatus } from "@/stores/runtime-system-load-and-runtime-status-store";

const UNAVAILABLE = "暂不可用";
function formatGigabytes(bytes: number): string {
	return `${Number((bytes / 1024 ** 3).toFixed(1))}`;
}
function formatUptime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	return days > 0
		? `${days} 天 ${hours % 24} 小时`
		: hours > 0
			? `${hours} 小时 ${minutes % 60} 分钟`
			: `${minutes} 分钟`;
}

export function RuntimeSystemLoadAndRuntimeStatus({ isMobile }: { isMobile: boolean }) {
	const { snapshot, connectionState } = useRuntimeSystemLoadAndRuntimeStatus();
	const [isStale, setIsStale] = useState(false);
	useEffect(() => {
		if (!snapshot) {
			setIsStale(false);
			return;
		}
		const remaining = snapshot.sampledAtEpochMs + 15_000 - Date.now();
		setIsStale(remaining < 0);
		if (remaining < 0) return;
		const timer = window.setTimeout(() => setIsStale(true), remaining + 1);
		return () => window.clearTimeout(timer);
	}, [snapshot]);
	const cpu = snapshot?.cpuUsagePercent == null ? UNAVAILABLE : `${Math.round(snapshot.cpuUsagePercent)}%`;
	const memory = snapshot?.memory
		? `${formatGigabytes(snapshot.memory.usedBytes)}/${formatGigabytes(snapshot.memory.totalBytes)} GB`
		: UNAVAILABLE;
	const connectionLabel = { connecting: "连接中", connected: "已连接", reconnecting: "重连中" }[connectionState];
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<Button
					variant="ghost"
					size="sm"
					icon={<Activity size={16} aria-hidden="true" />}
					aria-label="查看系统负载与运行状态"
					data-verification-anchor="runtime-system-load-and-runtime-status"
					className={cn(
						"shrink-0 tabular-nums",
						isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME,
						(isStale || connectionState === "reconnecting") && "text-status-orange",
					)}
				>
					{!isMobile ? (
						<span className="whitespace-nowrap">
							系统<span className="hidden xl:inline"> · CPU {cpu}</span>
							<span className="hidden 2xl:inline"> · 内存 {memory}</span>
							{isStale ? " · 数据已过期" : ""}
						</span>
					) : null}
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					collisionPadding={12}
					aria-label="系统负载与运行状态"
					className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-border-bright bg-surface-2 p-4 text-sm text-text-primary"
				>
					<div className="mb-3 flex items-center justify-between gap-3">
						<h2 className="font-semibold">系统与运行状态</h2>
						<Popover.Close asChild>
							<Button
								variant="ghost"
								size="sm"
								icon={<X size={16} />}
								aria-label="关闭系统概况"
								className={cn(isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
							/>
						</Popover.Close>
					</div>
					<dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-3 tabular-nums">
						<dt className="text-text-secondary">整机 CPU</dt>
						<dd className="text-right">{cpu}</dd>
						<dt className="text-text-secondary">内存（含缓存）</dt>
						<dd className="text-right">{memory}</dd>
						<dt className="text-text-secondary">磁盘可用</dt>
						<dd className="text-right">
							{snapshot?.disk ? `${formatGigabytes(snapshot.disk.availableBytes)} GB` : UNAVAILABLE}
						</dd>
						<dt className="text-text-secondary">Kanban 连接</dt>
						<dd className={cn("text-right", connectionState !== "connected" && "text-status-orange")}>
							{connectionLabel}
						</dd>
						<dt className="text-text-secondary">运行时长</dt>
						<dd className="text-right">
							{snapshot?.runtimeUptimeSeconds == null
								? UNAVAILABLE
								: formatUptime(snapshot.runtimeUptimeSeconds)}
						</dd>
						<dt className="text-text-secondary">活跃 Agent 会话</dt>
						<dd className="text-right">{snapshot?.liveAgentSessionCount ?? UNAVAILABLE}</dd>
					</dl>
					<p
						className={cn(
							"mt-4 border-t border-border pt-3 text-xs",
							isStale ? "text-status-orange" : "text-text-secondary",
						)}
						role="status"
					>
						{isStale ? "数据已过期，等待更新" : "每 5 秒更新 · 运行 Kanban 的宿主机"}
					</p>
					<p className="mt-1 text-xs text-text-secondary">磁盘指数据目录所在卷；内存用量含缓存。</p>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
