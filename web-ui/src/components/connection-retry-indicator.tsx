// 顶栏「重连中」指示器：当有终端 agent 因瞬时连接错误正在自动续跑重试时，
// 显示一个橙色计数按钮，点开是重试列表（每项含任务名、下一次重试倒计时、
// 单任务「立即续跑」），底部「全部立即续跑」。
//
// 自身无数据获取：重试会话视图与续跑回调由 App.tsx 从 workspace 范围的 sessions 派生后下传。

import * as RadixPopover from "@radix-ui/react-popover";
import { PlugZap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useInterval } from "@/utils/react-use";

export interface ConnectionRetrySessionView {
	taskId: string;
	taskTitle: string;
	retryCount: number;
	nextAttemptAt: number | null;
}

function formatNextAttempt(nextAttemptAt: number | null, nowMs: number): string {
	if (nextAttemptAt === null) {
		return "等待提示符就绪";
	}
	const remainingMs = nextAttemptAt - nowMs;
	if (remainingMs <= 0) {
		return "即将续跑…";
	}
	const remainingSeconds = Math.ceil(remainingMs / 1000);
	if (remainingSeconds < 60) {
		return `约 ${remainingSeconds}s 后续跑`;
	}
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	return `约 ${minutes}m${seconds > 0 ? ` ${seconds}s` : ""} 后续跑`;
}

export function ConnectionRetryIndicator({
	sessions,
	onContinue,
}: {
	sessions: ConnectionRetrySessionView[];
	onContinue: (taskIds: string[]) => void;
}): React.ReactElement | null {
	const [open, setOpen] = useState(false);
	// 每秒重渲染一次，让倒计时随时间走动；无重试会话时停掉计时器。
	const [nowMs, setNowMs] = useState(() => Date.now());
	useInterval(
		() => {
			setNowMs(Date.now());
		},
		sessions.length > 0 ? 1000 : null,
	);

	if (sessions.length === 0) {
		return null;
	}

	const allTaskIds = sessions.map((session) => session.taskId);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`${sessions.length} 个任务正在重连中`}
					className="ml-0.5 inline-flex items-center gap-1 h-8 px-2 rounded-md border border-status-orange/30 bg-status-orange/10 text-xs text-status-orange transition-colors hover:bg-status-orange/15 focus:outline-none focus:ring-2 focus:ring-border-focus"
				>
					<PlugZap size={14} className="animate-pulse" />
					<span className="font-mono">{sessions.length}</span>
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="end"
					sideOffset={5}
					className="z-50 w-[320px] rounded-lg border border-border bg-surface-2 p-2 shadow-xl"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="px-1.5 py-1">
						<p className="m-0 text-[13px] font-semibold text-text-primary">连接中断 · 自动续跑中</p>
						<p className="m-0 mt-0.5 text-[12px] text-text-secondary">
							检测到瞬时连接错误，正按指数退避自动续跑。恢复后自动停止。
						</p>
					</div>
					<div className="mt-1 max-h-[260px] overflow-y-auto">
						{sessions.map((session) => (
							<div
								key={session.taskId}
								className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-3"
							>
								<div className="min-w-0 flex-1">
									<p className="m-0 truncate text-[13px] text-text-primary" title={session.taskTitle}>
										{session.taskTitle}
									</p>
									<p className="m-0 text-[12px] text-text-tertiary">
										已续跑 {session.retryCount} 次 · {formatNextAttempt(session.nextAttemptAt, nowMs)}
									</p>
								</div>
								<Button size="sm" variant="default" onClick={() => onContinue([session.taskId])}>
									立即续跑
								</Button>
							</div>
						))}
					</div>
					<div className="mt-1 border-t border-border pt-1.5">
						<Button size="sm" variant="primary" fill onClick={() => onContinue(allTaskIds)}>
							全部立即续跑（{sessions.length}）
						</Button>
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
