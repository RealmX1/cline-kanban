import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useTaskRetainedCommittedLineChangeHistory } from "@/hooks/use-task-retained-committed-line-change-history";
import type { RuntimeTaskRetainedCommittedLineChangeSummary } from "@/runtime/types";

export function TaskRetainedCommittedLineChangeIndicator({
	workspaceId,
	taskId,
	baseRef,
	summary,
	showCommittedChangeBackground = false,
}: {
	workspaceId: string | null;
	taskId: string;
	baseRef: string;
	summary?: RuntimeTaskRetainedCommittedLineChangeSummary;
	showCommittedChangeBackground?: boolean;
}): React.ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverContentRef = useRef<HTMLDivElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isPinnedOpenRef = useRef(false);
	const historyVersion = summary?.historyVersion ?? "unavailable";
	const { history, hasError, retry } = useTaskRetainedCommittedLineChangeHistory({
		workspaceId,
		taskId,
		baseRef,
		historyVersion,
		isOpen,
	});
	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	};
	useEffect(
		() => () => {
			if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		},
		[],
	);
	const scheduleClose = () => {
		clearCloseTimer();
		if (!isPinnedOpenRef.current) closeTimerRef.current = setTimeout(() => setIsOpen(false), 200);
	};
	const isComplete = summary?.status === "complete";
	const visibleSummary = isComplete ? `已提交 +${summary.additions} −${summary.deletions}` : "已提交 —";
	const additionsTextColorClassName = showCommittedChangeBackground
		? "text-[color-mix(in_oklab,var(--color-status-green)_30%,var(--color-text-primary))]"
		: "text-status-green";
	const deletionsTextColorClassName = showCommittedChangeBackground
		? "text-[color-mix(in_oklab,var(--color-status-red)_30%,var(--color-text-primary))]"
		: "text-status-red";
	return (
		<span
			className="inline-flex align-baseline whitespace-nowrap font-mono"
			data-task-retained-committed-line-change-indicator=""
		>
			<button
				ref={triggerRef}
				type="button"
				className={cn(
					"inline-flex cursor-pointer items-baseline gap-1 rounded-sm text-inherit focus-visible:outline-2 focus-visible:outline-accent",
					showCommittedChangeBackground &&
						"bg-status-blue/30 px-0.5 text-text-primary ring-1 ring-inset ring-status-blue/70",
				)}
				aria-label={visibleSummary}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				onPointerEnter={() => {
					clearCloseTimer();
					setIsOpen(true);
				}}
				onPointerLeave={scheduleClose}
				onFocus={() => {
					clearCloseTimer();
					setIsOpen(true);
				}}
				onMouseDown={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					clearCloseTimer();
					isPinnedOpenRef.current = true;
					setIsOpen(true);
				}}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						clearCloseTimer();
						isPinnedOpenRef.current = true;
						setIsOpen(true);
						popoverContentRef.current?.focus();
					}
					if (event.key === "Escape") {
						isPinnedOpenRef.current = false;
						setIsOpen(false);
					}
				}}
			>
				<span>已提交</span>{" "}
				{isComplete ? (
					<>
						<span className={additionsTextColorClassName}>+{summary.additions}</span>{" "}
						<span className={deletionsTextColorClassName}>−{summary.deletions}</span>
					</>
				) : (
					<span>—</span>
				)}
			</button>
			{/* 只有展开时挂 Radix 上下文与明细 DOM，数百张闲置卡片不挂常驻浮层。 */}
			{isOpen ? (
				<Popover.Root
					open
					onOpenChange={(open) => {
						setIsOpen(open);
						if (!open) isPinnedOpenRef.current = false;
					}}
				>
					<Popover.Anchor virtualRef={triggerRef} />
					<Popover.Portal>
						<Popover.Content
							ref={popoverContentRef}
							side="bottom"
							align="start"
							sideOffset={5}
							aria-label="任务已提交增删行明细"
							className="z-50 max-h-[min(24rem,70dvh)] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-border bg-surface-2 p-3 text-xs text-text-primary shadow-lg"
							onOpenAutoFocus={(event) => {
								if (!isPinnedOpenRef.current) event.preventDefault();
							}}
							onCloseAutoFocus={(event) => event.preventDefault()}
							onEscapeKeyDown={() => {
								if (popoverContentRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
							}}
							onPointerEnter={clearCloseTimer}
							onPointerLeave={scheduleClose}
							onClick={(event) => event.stopPropagation()}
							onPointerDown={(event) => event.stopPropagation()}
							onKeyDown={(event) => event.stopPropagation()}
						>
							<div className="mb-2 font-medium">任务已提交累计</div>
							{workspaceId === null ? (
								<p>暂无法确定任务所属项目</p>
							) : hasError ? (
								<p>
									明细加载失败{" "}
									<button type="button" className="text-accent underline" onClick={retry}>
										重试
									</button>
								</p>
							) : !history ? (
								<p role="status">正在读取提交明细…</p>
							) : (
								<>
									{history.summary.status === "unavailable" ? (
										<p>历史记录不足，暂无法可靠统计。</p>
									) : (
										<>
											<div className="mb-2 font-mono">
												{history.summary.commitCount} 次提交 ·{" "}
												<span className="text-status-green">+{history.summary.additions}</span>{" "}
												<span className="text-status-red">−{history.summary.deletions}</span>
											</div>
											{history.summary.historyVersion !== historyVersion ? (
												<p className="mb-2">
													{isComplete
														? "提交历史已更新，卡片总计正在刷新。"
														: "当前统计暂不可用，以下是最后保存的记录。"}
												</p>
											) : null}
											{history.commits.length === 0 ? (
												<p>尚无已提交改动。</p>
											) : (
												<ol className="space-y-2">
													{history.commits.map((commit) => (
														<li
															key={commit.commitSha}
															className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5"
														>
															<span className="min-w-0 break-words">
																{commit.subject || "无标题提交"}
															</span>
															<span className="whitespace-nowrap font-mono">
																<span className="text-status-green">+{commit.additions}</span>{" "}
																<span className="text-status-red">−{commit.deletions}</span>
															</span>
															<span className="col-span-2 text-text-secondary">
																<code>{commit.commitSha.slice(0, 8)}</code> ·{" "}
																{new Date(commit.committedAtMs).toLocaleString("zh-CN")}
															</span>
														</li>
													))}
												</ol>
											)}
										</>
									)}
									<p className="mt-2 text-text-secondary">
										逐提交加和，不含当前 dirty、base 同步 merge 和二进制文件行数。
									</p>
								</>
							)}
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			) : null}
		</span>
	);
}
