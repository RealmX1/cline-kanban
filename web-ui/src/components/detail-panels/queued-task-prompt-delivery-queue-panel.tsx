// 详情视图的 Queue 面板：这个任务（会话）排着哪些「等 agent 这一轮结束再发」的 prompt，以及它们此刻为什么
// 还没发。数据来自服务端投影（正文截断预览 + 阻塞原因），动作全部是发给服务端的意图。
//
// 两条刻意的交互选择：
//   - 重排用「上移 / 下移」按钮，不用拖拽：对着一个会自己推流刷新的列表做 DnD，是「我拖了它又弹回去」的
//     经典来源；
//   - 合并开关画在**相邻两行之间**（链条图标），点亮即「这两条作为一条消息发出」。默认全部断开 ⇒ 一轮一条。
//
// 程序化条目（`kanban task message --deliver-when-agent-idle`，例：RVF 决策点边界标记）也会出现在这里：
// 挂「Automated · <source>」徽标，永远独占一次投递——它两侧的合并开关禁用，链条竖线也不跨过它
// （与服务端 collectQueuedTaskPromptDeliveryChainFromHead 同一口径）。

import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	Bot,
	Check,
	ChevronDown,
	ChevronUp,
	FileText,
	Link2,
	Link2Off,
	RotateCcw,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { QueuedTaskPromptDeliveryQueueController } from "@/hooks/use-queued-task-prompt-delivery-queue-controller";
import {
	describeQueuedTaskPromptDeliveryStatusChip,
	describeQueuedTaskPromptDispatchBlockReason,
	isQueuedTaskPromptDeliveryInFlight,
	isQueuedTaskPromptDeliveryTerminal,
	type QueuedTaskPromptDeliveryStatusChipTone,
} from "@/runtime/queued-task-prompt-delivery-status-wording";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

const STATUS_CHIP_TONE_CLASS: Record<QueuedTaskPromptDeliveryStatusChipTone, string> = {
	neutral: "border-border-bright bg-surface-3 text-text-secondary",
	warning: "border-status-orange/40 bg-status-orange/10 text-status-orange",
	active: "border-accent/40 bg-accent/10 text-accent",
	success: "border-status-green/40 bg-status-green/10 text-status-green",
	danger: "border-status-red/40 bg-status-red/10 text-status-red",
	muted: "border-border bg-surface-2 text-text-tertiary",
};

function QueuedPromptStatusChip({
	projection,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
}): React.ReactElement {
	const chip = describeQueuedTaskPromptDeliveryStatusChip(projection);
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded border px-1.5 text-[10px] leading-4 font-medium",
				STATUS_CHIP_TONE_CLASS[chip.tone],
			)}
		>
			{chip.label}
		</span>
	);
}

function QueuedPromptTextPreview({
	projection,
	fetchFullText,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	fetchFullText: (queueEntryId: string) => Promise<string | null>;
}): React.ReactElement {
	const [fullText, setFullText] = useState<string | null>(null);
	const [isExpanded, setIsExpanded] = useState(false);
	const isTruncated = projection.textLength > projection.textPreview.length;
	const handleToggle = async () => {
		if (isExpanded) {
			setIsExpanded(false);
			return;
		}
		setIsExpanded(true);
		if (fullText === null) {
			setFullText(await fetchFullText(projection.queueEntryId));
		}
	};
	return (
		<div className="min-w-0">
			<p
				className={cn(
					"whitespace-pre-wrap break-words text-xs leading-5 text-text-primary",
					!isExpanded && "line-clamp-3",
				)}
			>
				{isExpanded && fullText !== null ? fullText : projection.textPreview}
			</p>
			{isTruncated || projection.textPreview.split("\n").length > 3 ? (
				<button
					type="button"
					className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-text-tertiary hover:text-text-primary"
					onClick={() => void handleToggle()}
				>
					{isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
					{isExpanded ? "Collapse" : `Show full prompt (${projection.textLength} chars)`}
				</button>
			) : null}
		</div>
	);
}

function isProgrammaticInjectionProjection(projection: RuntimeQueuedTaskPromptDeliveryProjection): boolean {
	return projection.programmaticInjectionSource != null;
}

function QueuedPromptSourceBadge({
	projection,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
}): React.ReactElement | null {
	if (projection.programmaticInjectionSource != null) {
		return (
			<Tooltip content="Queued by an automation to be delivered once the agent is idle. It is always sent as its own message, and gives up at the automation's deadline instead of interrupting the agent.">
				<span className="inline-flex items-center gap-1 text-[10px] leading-4 text-text-tertiary">
					<Bot size={10} />
					Automated · {projection.programmaticInjectionSource}
				</span>
			</Tooltip>
		);
	}
	if (projection.sourcePromptLibraryEntryId === null) {
		return null;
	}
	return (
		<span className="inline-flex items-center gap-1 text-[10px] leading-4 text-text-tertiary">
			<FileText size={10} />
			From prompt library
			{projection.sourcePromptLibraryEntryTextChangedSinceEnqueue === true ? (
				<Tooltip content="The library prompt was edited after this was queued. The queued text is the version you queued.">
					<span className="text-status-orange">· library prompt has changed since</span>
				</Tooltip>
			) : null}
		</span>
	);
}

function PendingQueuedPromptRow({
	isTaskAgentExecutionDisabled,
	projection,
	position,
	isFirstPending,
	isLastPending,
	isChainedFromPrevious,
	isChainedToNext,
	controller,
}: {
	isTaskAgentExecutionDisabled: boolean;
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	position: number;
	isFirstPending: boolean;
	isLastPending: boolean;
	isChainedFromPrevious: boolean;
	isChainedToNext: boolean;
	controller: QueuedTaskPromptDeliveryQueueController;
}): React.ReactElement {
	const isInFlight = isQueuedTaskPromptDeliveryInFlight(projection);
	const blockReasonWording = describeQueuedTaskPromptDispatchBlockReason(projection.dispatchBlockReason);
	return (
		<div
			data-queued-prompt-entry-id={projection.queueEntryId}
			className={cn(
				"group relative rounded-md border border-border bg-surface-2 px-2 py-1.5",
				(isChainedFromPrevious || isChainedToNext) && "border-l-2 border-l-accent",
				projection.awaitsHumanReconfirmationAfterRuntimeRestart && "border-status-orange/50",
			)}
		>
			<div className="mb-1 flex items-center gap-1.5">
				<span className="text-[10px] leading-4 tabular-nums text-text-tertiary">#{position}</span>
				<QueuedPromptStatusChip projection={projection} />
				<QueuedPromptSourceBadge projection={projection} />
				<div className="ml-auto flex items-center gap-0.5">
					<Tooltip content="Move up">
						<Button
							variant="ghost"
							size="xs"
							icon={<ArrowUp size={12} />}
							aria-label="Move queued prompt up"
							disabled={isFirstPending || isInFlight}
							onClick={() => void controller.moveQueuedPromptDelivery(projection.queueEntryId, "up")}
						/>
					</Tooltip>
					<Tooltip content="Move down">
						<Button
							variant="ghost"
							size="xs"
							icon={<ArrowDown size={12} />}
							aria-label="Move queued prompt down"
							disabled={isLastPending || isInFlight}
							onClick={() => void controller.moveQueuedPromptDelivery(projection.queueEntryId, "down")}
						/>
					</Tooltip>
					<Tooltip
						content={
							isInFlight
								? "Try to stop it. If it was already pasted into the agent's input, it is too late."
								: "Cancel — it will not be sent"
						}
					>
						<Button
							variant="ghost"
							size="xs"
							icon={<X size={12} />}
							aria-label="Cancel queued prompt"
							className="hover:text-status-red"
							onClick={() => void controller.cancelQueuedPromptDelivery(projection.queueEntryId)}
						/>
					</Tooltip>
				</div>
			</div>
			<QueuedPromptTextPreview projection={projection} fetchFullText={controller.fetchFullText} />
			{projection.awaitsHumanReconfirmationAfterRuntimeRestart ? (
				<div className="mt-1 flex items-center gap-1.5 text-[11px] leading-4 text-status-orange">
					<AlertTriangle size={12} className="shrink-0" />
					<span className="flex-1">Queued before Kanban restarted. Still needed?</span>
					<Button
						variant="ghost"
						size="xs"
						icon={<Check size={12} />}
						disabled={isTaskAgentExecutionDisabled}
						onClick={() =>
							void controller.reconfirmQueuedPromptDeliveriesAfterRuntimeRestart([projection.queueEntryId])
						}
					>
						Keep
					</Button>
				</div>
			) : blockReasonWording ? (
				<p className="mt-1 text-[11px] leading-4 text-text-tertiary">{blockReasonWording}</p>
			) : null}
			{projection.lastDeliveryFailureNote && !isInFlight ? (
				<p className="mt-1 text-[11px] leading-4 text-text-tertiary">
					Last attempt: {projection.lastDeliveryFailureNote}
				</p>
			) : null}
		</div>
	);
}

function MergeWithNextToggle({
	projection,
	nextProjection,
	controller,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	nextProjection: RuntimeQueuedTaskPromptDeliveryProjection;
	controller: QueuedTaskPromptDeliveryQueueController;
}): React.ReactElement {
	// 任一侧是程序化条目：它永远独占一次投递，服务端在它前面断链、也不许点亮它自己的开关。
	const isFrozenBecauseEitherSideIsAutomated =
		isProgrammaticInjectionProjection(projection) || isProgrammaticInjectionProjection(nextProjection);
	const isMerged = projection.deliverTogetherWithNextQueuedEntry && !isFrozenBecauseEitherSideIsAutomated;
	// 任一侧已在发送：那一串在认领时就冻结了，此时改开关只会让界面与实际发出去的不一致（服务端同样拒绝）。
	const isFrozenBecauseEitherSideIsSending =
		isQueuedTaskPromptDeliveryInFlight(projection) || isQueuedTaskPromptDeliveryInFlight(nextProjection);
	return (
		<div className="flex items-center justify-center">
			<Tooltip
				content={
					isFrozenBecauseEitherSideIsAutomated
						? "Automated deliveries are always sent as their own message."
						: isFrozenBecauseEitherSideIsSending
							? "Already being sent — the grouping can no longer change."
							: isMerged
								? "These two will be sent as one message. Click to send them in separate turns."
								: "Send this and the next one together as one message"
				}
			>
				<Button
					variant="ghost"
					size="xs"
					icon={isMerged ? <Link2 size={12} /> : <Link2Off size={12} />}
					aria-label={isMerged ? "Unlink from next queued prompt" : "Link with next queued prompt"}
					aria-pressed={isMerged}
					disabled={isFrozenBecauseEitherSideIsAutomated || isFrozenBecauseEitherSideIsSending}
					className={cn("h-4", isMerged ? "text-accent" : "text-text-tertiary")}
					onClick={() => void controller.setQueuedPromptDeliveryMergeWithNext(projection.queueEntryId, !isMerged)}
				/>
			</Tooltip>
		</div>
	);
}

function SettledQueuedPromptRow({
	isTaskAgentExecutionDisabled,
	projection,
	controller,
}: {
	isTaskAgentExecutionDisabled: boolean;
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	controller: QueuedTaskPromptDeliveryQueueController;
}): React.ReactElement {
	return (
		<div
			data-queued-prompt-entry-id={projection.queueEntryId}
			className="rounded-md border border-border bg-surface-1 px-2 py-1.5"
		>
			<div className="mb-1 flex items-center gap-1.5">
				<QueuedPromptStatusChip projection={projection} />
				<QueuedPromptSourceBadge projection={projection} />
				<div className="ml-auto flex items-center gap-0.5">
					{projection.deliveryState === "settled_failed" ? (
						<Tooltip
							content={
								isProgrammaticInjectionProjection(projection)
									? "Queue it again at the end as your own prompt (the automation is not told)"
									: "Queue it again at the end"
							}
						>
							<Button
								variant="ghost"
								size="xs"
								icon={<RotateCcw size={12} />}
								disabled={isTaskAgentExecutionDisabled}
								onClick={() => void controller.retrySettledFailedQueuedPromptDelivery(projection.queueEntryId)}
							>
								Requeue
							</Button>
						</Tooltip>
					) : null}
					<Tooltip content="Remove from this list">
						<Button
							variant="ghost"
							size="xs"
							icon={<X size={12} />}
							aria-label="Dismiss settled queued prompt"
							onClick={() => void controller.dismissSettledQueuedPromptDelivery(projection.queueEntryId)}
						/>
					</Tooltip>
				</div>
			</div>
			<p className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
				{projection.textPreview}
			</p>
			{projection.deliveryState === "settled_failed" && projection.lastDeliveryFailureNote ? (
				<p className="mt-1 text-[11px] leading-4 text-status-red">{projection.lastDeliveryFailureNote}</p>
			) : null}
			{projection.deliveryState === "expired" && isProgrammaticInjectionProjection(projection) ? (
				<p className="mt-1 text-[11px] leading-4 text-text-tertiary">
					The agent never became idle before the automation's deadline, so it was not sent.
				</p>
			) : null}
		</div>
	);
}

export function QueuedTaskPromptDeliveryQueuePanel({
	isTaskAgentExecutionDisabled = false,
	controller,
	headerContent,
}: {
	isTaskAgentExecutionDisabled?: boolean;
	controller: QueuedTaskPromptDeliveryQueueController;
	headerContent?: ReactNode;
}): React.ReactElement {
	const pending = controller.projections.filter((projection) => !isQueuedTaskPromptDeliveryTerminal(projection));
	const settled = controller.projections.filter((projection) => isQueuedTaskPromptDeliveryTerminal(projection));
	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
				{headerContent ?? (
					<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">Queue</span>
				)}
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pt-1 pb-3">
				{isTaskAgentExecutionDisabled ? (
					<p className="px-1 py-2 text-xs text-text-secondary">
						任务已完成，恢复任务后可继续投递。现有队列记录仍可查看和取消。
					</p>
				) : null}
				{pending.length === 0 ? (
					<p className="px-1 py-2 text-xs leading-5 text-text-tertiary">
						Queue a prompt from the Prompts tab to send it after the agent finishes its current turn.
					</p>
				) : (
					pending.map((projection, index) => {
						const previousPendingProjection = pending[index - 1];
						const nextPendingProjection = pending[index + 1];
						// 竖线只画真的会一起发出的那几条：程序化条目两侧的链在服务端就是断的。
						const isChainedToNext =
							nextPendingProjection !== undefined &&
							projection.deliverTogetherWithNextQueuedEntry &&
							!isProgrammaticInjectionProjection(projection) &&
							!isProgrammaticInjectionProjection(nextPendingProjection);
						const isChainedFromPrevious =
							previousPendingProjection?.deliverTogetherWithNextQueuedEntry === true &&
							!isProgrammaticInjectionProjection(previousPendingProjection) &&
							!isProgrammaticInjectionProjection(projection);
						return (
							<div key={projection.queueEntryId} className="flex flex-col gap-1">
								<PendingQueuedPromptRow
									isTaskAgentExecutionDisabled={isTaskAgentExecutionDisabled}
									projection={projection}
									position={index + 1}
									isFirstPending={index === 0}
									isLastPending={index === pending.length - 1}
									isChainedFromPrevious={isChainedFromPrevious}
									isChainedToNext={isChainedToNext}
									controller={controller}
								/>
								{nextPendingProjection ? (
									<MergeWithNextToggle
										projection={projection}
										nextProjection={nextPendingProjection}
										controller={controller}
									/>
								) : null}
							</div>
						);
					})
				)}
				{settled.length > 0 ? (
					<div className="mt-3 flex flex-col gap-1">
						<span className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
							Recent
						</span>
						{settled.map((projection) => (
							<SettledQueuedPromptRow
								isTaskAgentExecutionDisabled={isTaskAgentExecutionDisabled}
								key={projection.queueEntryId}
								projection={projection}
								controller={controller}
							/>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
