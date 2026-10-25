// 详情视图的 Queue 面板：这个任务（会话）排着哪些「等 agent 这一轮结束再发」的 prompt，以及它们此刻为什么
// 还没发。数据来自服务端投影（正文截断预览 + 阻塞原因）；投递顺序修改发给服务端，时间排序与复制只读。
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
	Copy,
	FileText,
	Link2,
	Link2Off,
	RotateCcw,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { QueuedTaskPromptDeliveryQueueController } from "@/hooks/use-queued-task-prompt-delivery-queue-controller";
import type { QueuedTaskPromptDeliveryDebugReference } from "@/runtime/queued-task-prompt-delivery-debug-reference";
import {
	describeQueuedTaskPromptDeliveryStatusChip,
	describeQueuedTaskPromptDispatchBlockReason,
	describeTaskPromptDeliveryMessageType,
	isQueuedTaskPromptDeliveryInFlight,
	isQueuedTaskPromptDeliveryTerminal,
	isTaskPromptDeliveryWaitingForAgentTurn,
	type QueuedTaskPromptDeliveryStatusChipTone,
} from "@/runtime/queued-task-prompt-delivery-status-wording";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";
import { useDocumentEvent, useInterval } from "@/utils/react-use";
import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";

const STATUS_CHIP_TONE_CLASS: Record<QueuedTaskPromptDeliveryStatusChipTone, string> = {
	neutral: "border-border-bright bg-surface-3 text-text-secondary",
	warning: "border-status-orange/40 bg-status-orange/10 text-status-orange",
	active: "border-accent/40 bg-accent/10 text-accent",
	success: "border-status-green/40 bg-status-green/10 text-status-green",
	danger: "border-status-red/40 bg-status-red/10 text-status-red",
	muted: "border-border bg-surface-2 text-text-tertiary",
};

type QueuedPromptDisplayOrder = "delivery_order" | "last_attempt_newest_first" | "enqueued_oldest_first";

function resolveQueuedPromptLastAttemptTimestamp(projection: RuntimeQueuedTaskPromptDeliveryProjection): number | null {
	return projection.deliveryAttemptCount > 0 &&
		typeof projection.lastAttemptedAt === "number" &&
		Number.isFinite(new Date(projection.lastAttemptedAt).getTime())
		? projection.lastAttemptedAt
		: null;
}

function describeQueuedPromptTimeSinceLastAttempt(
	projection: RuntimeQueuedTaskPromptDeliveryProjection,
	nowEpochMs: number,
): string {
	if (projection.deliveryAttemptCount === 0) return "尚未尝试";
	const lastAttemptedAt = resolveQueuedPromptLastAttemptTimestamp(projection);
	if (lastAttemptedAt === null) return "时间未知";
	const elapsedSeconds = Math.floor(Math.max(0, nowEpochMs - lastAttemptedAt) / 1_000);
	if (elapsedSeconds < 60) return `${elapsedSeconds} 秒`;
	if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)} 分钟`;
	if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)} 小时`;
	return `${Math.floor(elapsedSeconds / 86_400)} 天`;
}

function compareQueuedPromptDisplayTimestamps(
	left: RuntimeQueuedTaskPromptDeliveryProjection,
	right: RuntimeQueuedTaskPromptDeliveryProjection,
	displayOrder: QueuedPromptDisplayOrder,
): number {
	if (displayOrder === "enqueued_oldest_first") return left.enqueuedAt - right.enqueuedAt;
	const leftTimestamp = resolveQueuedPromptLastAttemptTimestamp(left);
	const rightTimestamp = resolveQueuedPromptLastAttemptTimestamp(right);
	if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
	if (rightTimestamp === null) return -1;
	return rightTimestamp - leftTimestamp;
}

function useQueuedPromptDeliveryElapsedClock(
	projections: readonly RuntimeQueuedTaskPromptDeliveryProjection[],
): number {
	const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
	const [isDocumentVisible, setIsDocumentVisible] = useState(() => document.visibilityState !== "hidden");
	useDocumentEvent("visibilitychange", () => {
		setIsDocumentVisible(document.visibilityState !== "hidden");
		setNowEpochMs(Date.now());
	});
	const hasKnownLastAttempt = projections.some(
		(projection) => resolveQueuedPromptLastAttemptTimestamp(projection) !== null,
	);
	useInterval(() => setNowEpochMs(Date.now()), isDocumentVisible && hasKnownLastAttempt ? 1_000 : null);
	return nowEpochMs;
}

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

function QueuedPromptDeliveryTimestamp({ timestamp }: { timestamp: number | null | undefined }): React.ReactElement {
	const date = typeof timestamp === "number" ? new Date(timestamp) : null;
	if (date === null || !Number.isFinite(date.getTime())) {
		return <span>时间未知</span>;
	}
	return (
		<time dateTime={date.toISOString()} title={date.toISOString()}>
			{date.toLocaleString(undefined, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false,
				timeZoneName: "short",
			})}
		</time>
	);
}

function QueuedPromptDeliveryMetadata({
	projection,
	nowEpochMs,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	nowEpochMs: number;
}): React.ReactElement {
	const resultTimeLabel = {
		settled_delivered: "送达时间",
		settled_failed: "失败时间",
		cancelled: "取消时间",
		expired: "过期时间",
		queued: "到期时间",
		claimed_for_dispatch: "到期时间",
		handed_to_transport: "到期时间",
	}[projection.deliveryState];
	const resultTimestamp =
		projection.deliveryState === "expired" || !isQueuedTaskPromptDeliveryTerminal(projection)
			? projection.expiresAt
			: projection.settledAt;
	return (
		<dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-4 text-text-secondary">
			<div className="min-w-0 break-words">
				<dt className="inline">距上次尝试：</dt>
				<dd className="inline tabular-nums">{describeQueuedPromptTimeSinceLastAttempt(projection, nowEpochMs)}</dd>
			</div>
			<div className="min-w-0 break-words">
				<dt className="inline">
					{isTaskPromptDeliveryWaitingForAgentTurn(projection) ? "入队时间：" : "登记时间："}
				</dt>
				<dd className="inline tabular-nums">
					<QueuedPromptDeliveryTimestamp timestamp={projection.enqueuedAt} />
				</dd>
			</div>
			<div className="min-w-0 break-words">
				<dt className="inline">最近投递：</dt>
				<dd className="inline tabular-nums">
					{projection.deliveryAttemptCount === 0 ? (
						"尚未尝试"
					) : (
						<QueuedPromptDeliveryTimestamp timestamp={projection.lastAttemptedAt} />
					)}
				</dd>
			</div>
			<div className="min-w-0 break-words">
				<dt className="inline">{resultTimeLabel}：</dt>
				<dd className="inline tabular-nums">
					<QueuedPromptDeliveryTimestamp timestamp={resultTimestamp} />
				</dd>
			</div>
		</dl>
	);
}

function QueuedPromptTextPreviewAndFullTextCopy({
	projection,
	fetchFullText,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	fetchFullText: (queueEntryId: string) => Promise<string | null>;
}): React.ReactElement {
	const [preparedFullText, setPreparedFullText] = useState<{
		queueEntryId: string;
		fetchFullText: typeof fetchFullText;
		text: string | null;
		isLoading: boolean;
	} | null>(null);
	const [isExpanded, setIsExpanded] = useState(false);
	const [readRetryGeneration, setReadRetryGeneration] = useState(0);
	const [copyFeedback, setCopyFeedback] = useState("");
	const [showManualCopy, setShowManualCopy] = useState(false);
	const requestGeneration = useRef(0);
	const isCurrentPreparedText =
		preparedFullText?.queueEntryId === projection.queueEntryId && preparedFullText.fetchFullText === fetchFullText;
	const fullText = isCurrentPreparedText ? preparedFullText.text : null;
	const isLoading = !isCurrentPreparedText || preparedFullText.isLoading;
	useEffect(() => {
		const generation = ++requestGeneration.current;
		const readIdentity = { queueEntryId: projection.queueEntryId, fetchFullText };
		setPreparedFullText({ ...readIdentity, text: null, isLoading: true });
		setIsExpanded(false);
		setCopyFeedback("");
		setShowManualCopy(false);
		void fetchFullText(projection.queueEntryId)
			.catch(() => null)
			.then((text) => {
				if (generation === requestGeneration.current)
					setPreparedFullText({ ...readIdentity, text, isLoading: false });
			});
		return () => {
			requestGeneration.current += 1;
		};
	}, [fetchFullText, projection.queueEntryId, readRetryGeneration]);
	const copyFullText = async () => {
		if (fullText === null) return;
		const generation = requestGeneration.current;
		setCopyFeedback("");
		setShowManualCopy(false);
		try {
			// 正文提前准备好；复制调用留在本次点击栈内，兼容 HTTP 环境的同步降级。
			await writeTextToSystemClipboardWithInsecureContextFallback(fullText);
			if (generation === requestGeneration.current) setCopyFeedback("已复制全文");
		} catch {
			if (generation === requestGeneration.current) {
				setCopyFeedback("复制失败，可重试或在下方选择全文手动复制。");
				setShowManualCopy(true);
			}
		}
	};
	const isTruncated =
		projection.textLength > projection.textPreview.length ||
		(fullText !== null && fullText !== projection.textPreview);
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
			<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
				<Button
					variant="ghost"
					size="xs"
					icon={<Copy size={12} />}
					disabled={fullText === null}
					onClick={() => void copyFullText()}
				>
					复制全文
				</Button>
				{isTruncated || projection.textPreview.split("\n").length > 3 ? (
					<Button
						variant="ghost"
						size="xs"
						icon={isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
						disabled={fullText === null}
						onClick={() => setIsExpanded(!isExpanded)}
					>
						{isExpanded ? "收起全文" : `展开全文（${projection.textLength} 字符）`}
					</Button>
				) : null}
				{isLoading ? (
					<span className="text-[11px] text-text-secondary">读取全文中…</span>
				) : fullText === null ? (
					<>
						<span className="text-[11px] text-status-orange">无法读取全文。</span>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => setReadRetryGeneration((generation) => generation + 1)}
						>
							重新读取全文
						</Button>
					</>
				) : null}
				<span role="status" className="text-[11px] text-text-secondary">
					{copyFeedback}
				</span>
			</div>
			{showManualCopy && fullText !== null ? (
				<textarea
					aria-label="可手动复制的 Prompt 全文"
					readOnly
					value={fullText}
					className="mt-1 min-h-24 w-full rounded border border-border bg-surface-1 p-2 text-xs text-text-primary"
					onFocus={(event) => event.currentTarget.select()}
				/>
			) : null}
		</div>
	);
}

function QueuedPromptDebugReferenceDisclosure({
	projection,
	fetchDebugReference,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	fetchDebugReference: QueuedTaskPromptDeliveryQueueController["fetchDebugReference"];
}): React.ReactElement {
	const disclosureId = useId();
	const [isExpanded, setIsExpanded] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [reference, setReference] = useState<QueuedTaskPromptDeliveryDebugReference | null>(null);
	const [feedback, setFeedback] = useState("");
	const requestGeneration = useRef(0);
	useEffect(() => {
		setIsExpanded(false);
		setIsLoading(false);
		setReference(null);
		setFeedback("");
		return () => {
			requestGeneration.current += 1;
		};
	}, [fetchDebugReference, projection.queueEntryId]);
	const loadReference = async () => {
		const generation = ++requestGeneration.current;
		setIsLoading(true);
		setReference(null);
		setFeedback("");
		try {
			const preparedReference = await fetchDebugReference(projection);
			if (generation === requestGeneration.current) setReference(preparedReference);
		} catch {
			if (generation === requestGeneration.current) setFeedback("无法准备调试引用，请重新读取。");
		} finally {
			if (generation === requestGeneration.current) setIsLoading(false);
		}
	};
	const toggleDisclosure = () => {
		setIsExpanded(!isExpanded);
		if (isExpanded) {
			requestGeneration.current += 1;
			setIsLoading(false);
		} else {
			void loadReference();
		}
	};
	const copyReference = async () => {
		if (!reference) return;
		const generation = requestGeneration.current;
		try {
			// 用户点击后立即调用，确保缺少 Clipboard API 时的同步复制降级仍在手势调用栈内。
			await writeTextToSystemClipboardWithInsecureContextFallback(reference.text);
			if (generation === requestGeneration.current) setFeedback("已复制引用与检索指导。");
		} catch {
			if (generation === requestGeneration.current) setFeedback("复制失败，请在文本框中选择引用并手动复制。");
		}
	};
	return (
		<div className="mt-1 min-w-0">
			<Button
				variant="ghost"
				size="xs"
				aria-expanded={isExpanded}
				aria-controls={disclosureId}
				onClick={toggleDisclosure}
			>
				{isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}调试引用
			</Button>
			{isExpanded ? (
				<div id={disclosureId} className="mt-1 flex min-w-0 flex-col gap-1.5">
					{isLoading ? (
						<p role="status" className="text-[11px] text-text-secondary">
							正在读取调试快照…
						</p>
					) : null}
					{reference?.notice ? (
						<p className="text-[11px] leading-4 text-text-secondary">{reference.notice}</p>
					) : null}
					{reference ? (
						<textarea
							aria-label="Prompt Queue 调试引用"
							readOnly
							rows={8}
							value={reference.text}
							wrap="off"
							className="w-full min-w-0 resize-y rounded border border-border bg-surface-1 p-2 font-mono text-[11px] leading-4 text-text-primary focus-visible:outline focus-visible:outline-border-focus"
						/>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="ghost"
							size="xs"
							icon={<Copy size={12} />}
							disabled={!reference || isLoading}
							onClick={() => void copyReference()}
						>
							复制引用与检索指导
						</Button>
						<Button variant="ghost" size="xs" disabled={isLoading} onClick={() => void loadReference()}>
							重新读取
						</Button>
					</div>
					{feedback ? (
						<p role="status" className="text-[11px] leading-4 text-text-secondary">
							{feedback}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function isProgrammaticInjectionProjection(projection: RuntimeQueuedTaskPromptDeliveryProjection): boolean {
	return (
		projection.programmaticInjectionSource != null ||
		projection.managedDelivery?.messageType === "programmatic_injection"
	);
}

function QueuedPromptSourceBadge({
	projection,
}: {
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
}): React.ReactElement | null {
	const source = projection.managedDelivery?.sourceLabel ?? projection.programmaticInjectionSource;
	const strategy = projection.managedDelivery?.deliveryStrategy ?? "after_agent_turn";
	return (
		<span
			className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] leading-4 text-text-secondary"
			data-delivery-message-type={projection.managedDelivery?.messageType}
		>
			{isProgrammaticInjectionProjection(projection) ? (
				<Bot size={11} className="shrink-0" />
			) : (
				<FileText size={11} className="shrink-0" />
			)}
			<span>{describeTaskPromptDeliveryMessageType(projection)}</span>
			{source ? <span className="break-all">· {source}</span> : null}
			<span>· {strategy === "immediate" ? "即时" : strategy === "session_startup" ? "启动时提交" : "等待空闲"}</span>
			{(projection.managedDelivery?.imageAttachmentCount ?? 0) > 0 ? (
				<span>· {projection.managedDelivery?.imageAttachmentCount} 个附件</span>
			) : null}
			{projection.sourcePromptLibraryEntryTextChangedSinceEnqueue ? (
				<Tooltip content="库中正文已修改，本次投递仍使用登记时的版本。">
					<span className="text-status-orange">· 库条目已修改</span>
				</Tooltip>
			) : null}
		</span>
	);
}

function PendingQueuedPromptRow({
	isTaskAgentExecutionDisabled,
	projection,
	nowEpochMs,
	allowDeliveryOrderEditing,
	position,
	isFirstPending,
	isLastPending,
	isChainedFromPrevious,
	isChainedToNext,
	controller,
}: {
	isTaskAgentExecutionDisabled: boolean;
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	nowEpochMs: number;
	allowDeliveryOrderEditing: boolean;
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
			<div className="mb-1 flex flex-wrap items-center gap-1.5">
				{isTaskPromptDeliveryWaitingForAgentTurn(projection) ? (
					<span className="text-[10px] leading-4 tabular-nums text-text-tertiary">投递 #{position}</span>
				) : null}
				<QueuedPromptStatusChip projection={projection} />
				<QueuedPromptSourceBadge projection={projection} />
				<span className="text-[11px] leading-4 tabular-nums text-text-secondary">
					尝试次数：{projection.deliveryAttemptCount}
				</span>
				<div className="ml-auto flex items-center gap-0.5">
					{allowDeliveryOrderEditing && isTaskPromptDeliveryWaitingForAgentTurn(projection) ? (
						<>
							<Tooltip content="上移">
								<Button
									variant="ghost"
									size="xs"
									icon={<ArrowUp size={12} />}
									aria-label="Move queued prompt up"
									disabled={isFirstPending || isInFlight}
									onClick={() => void controller.moveQueuedPromptDelivery(projection.queueEntryId, "up")}
								/>
							</Tooltip>
							<Tooltip content="下移">
								<Button
									variant="ghost"
									size="xs"
									icon={<ArrowDown size={12} />}
									aria-label="Move queued prompt down"
									disabled={isLastPending || isInFlight}
									onClick={() => void controller.moveQueuedPromptDelivery(projection.queueEntryId, "down")}
								/>
							</Tooltip>
						</>
					) : null}
					{isTaskPromptDeliveryWaitingForAgentTurn(projection) ||
					projection.managedDelivery?.cancellationSupported ? (
						<Tooltip content={isInFlight ? "尝试取消；若消息已经提交，则无法撤回。" : "取消，不再发送"}>
							<Button
								variant="ghost"
								size="xs"
								icon={<X size={12} />}
								aria-label="Cancel queued prompt"
								className="hover:text-status-red"
								onClick={() => void controller.cancelQueuedPromptDelivery(projection.queueEntryId)}
							/>
						</Tooltip>
					) : null}
				</div>
			</div>
			<QueuedPromptTextPreviewAndFullTextCopy projection={projection} fetchFullText={controller.fetchFullText} />
			<QueuedPromptDeliveryMetadata projection={projection} nowEpochMs={nowEpochMs} />
			<QueuedPromptDebugReferenceDisclosure
				projection={projection}
				fetchDebugReference={controller.fetchDebugReference}
			/>
			{projection.awaitsHumanReconfirmationAfterRuntimeRestart ? (
				<div className="mt-1 flex items-center gap-1.5 text-[11px] leading-4 text-status-orange">
					<AlertTriangle size={12} className="shrink-0" />
					<span className="flex-1">此消息在重启前排入，是否保留？</span>
					<Button
						variant="ghost"
						size="xs"
						icon={<Check size={12} />}
						disabled={isTaskAgentExecutionDisabled}
						onClick={() =>
							void controller.reconfirmQueuedPromptDeliveriesAfterRuntimeRestart([projection.queueEntryId])
						}
					>
						保留
					</Button>
				</div>
			) : blockReasonWording ? (
				<p className="mt-1 text-[11px] leading-4 text-text-tertiary">{blockReasonWording}</p>
			) : null}
			{projection.lastDeliveryFailureNote && !isInFlight ? (
				<p className="mt-1 text-[11px] leading-4 text-text-tertiary">
					上次尝试： {projection.lastDeliveryFailureNote}
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
	nowEpochMs,
	controller,
}: {
	isTaskAgentExecutionDisabled: boolean;
	projection: RuntimeQueuedTaskPromptDeliveryProjection;
	nowEpochMs: number;
	controller: QueuedTaskPromptDeliveryQueueController;
}): React.ReactElement {
	return (
		<div
			data-queued-prompt-entry-id={projection.queueEntryId}
			className="rounded-md border border-border bg-surface-1 px-2 py-1.5"
		>
			<div className="mb-1 flex flex-wrap items-center gap-1.5">
				<QueuedPromptStatusChip projection={projection} />
				<QueuedPromptSourceBadge projection={projection} />
				<span className="text-[11px] leading-4 tabular-nums text-text-secondary">
					尝试次数：{projection.deliveryAttemptCount}
				</span>
				<div className="ml-auto flex items-center gap-0.5">
					{projection.deliveryState === "settled_failed" && isTaskPromptDeliveryWaitingForAgentTurn(projection) ? (
						<Tooltip
							content={
								isProgrammaticInjectionProjection(projection)
									? "作为人工消息重新排队，原自动调用方不会收到新回执"
									: "重新排到队尾"
							}
						>
							<Button
								variant="ghost"
								size="xs"
								icon={<RotateCcw size={12} />}
								disabled={isTaskAgentExecutionDisabled}
								onClick={() => void controller.retrySettledFailedQueuedPromptDelivery(projection.queueEntryId)}
							>
								重新排队
							</Button>
						</Tooltip>
					) : null}
					<Tooltip content="从列表移除">
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
			<QueuedPromptTextPreviewAndFullTextCopy projection={projection} fetchFullText={controller.fetchFullText} />
			<QueuedPromptDeliveryMetadata projection={projection} nowEpochMs={nowEpochMs} />
			<QueuedPromptDebugReferenceDisclosure
				projection={projection}
				fetchDebugReference={controller.fetchDebugReference}
			/>
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
	const [selectedMessageTypeLabel, setSelectedMessageTypeLabel] = useState("all");
	const [displayOrder, setDisplayOrder] = useState<QueuedPromptDisplayOrder>("delivery_order");
	const allowDeliveryOrderEditing = displayOrder === "delivery_order";
	const nowEpochMs = useQueuedPromptDeliveryElapsedClock(controller.projections);
	const messageTypeLabels = [...new Set(controller.projections.map(describeTaskPromptDeliveryMessageType))];
	useEffect(() => {
		if (
			selectedMessageTypeLabel !== "all" &&
			!controller.projections.some(
				(projection) => describeTaskPromptDeliveryMessageType(projection) === selectedMessageTypeLabel,
			)
		)
			setSelectedMessageTypeLabel("all");
	}, [controller.projections, selectedMessageTypeLabel]);
	const filtered = controller.projections.filter(
		(projection) =>
			selectedMessageTypeLabel === "all" ||
			describeTaskPromptDeliveryMessageType(projection) === selectedMessageTypeLabel,
	);
	const waitingQueueEntryIdsBeforeMessageTypeFilter = controller.projections
		.filter(
			(projection) =>
				!isQueuedTaskPromptDeliveryTerminal(projection) && isTaskPromptDeliveryWaitingForAgentTurn(projection),
		)
		.map((projection) => projection.queueEntryId);
	const pending = filtered
		.filter((projection) => !isQueuedTaskPromptDeliveryTerminal(projection))
		.sort((left, right) =>
			allowDeliveryOrderEditing
				? Number(isTaskPromptDeliveryWaitingForAgentTurn(right)) -
					Number(isTaskPromptDeliveryWaitingForAgentTurn(left))
				: compareQueuedPromptDisplayTimestamps(left, right, displayOrder),
		);
	const settled = filtered
		.filter(isQueuedTaskPromptDeliveryTerminal)
		.slice()
		.sort((left, right) =>
			allowDeliveryOrderEditing
				? (right.settledAt ?? right.enqueuedAt) - (left.settledAt ?? left.enqueuedAt)
				: compareQueuedPromptDisplayTimestamps(left, right, displayOrder),
		);
	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
				{headerContent ?? (
					<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">Queue</span>
				)}
				<select
					aria-label="按消息类型筛选"
					value={selectedMessageTypeLabel}
					onChange={(event) => setSelectedMessageTypeLabel(event.target.value)}
					className="min-w-0 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary"
				>
					<option value="all">全部类型</option>
					{messageTypeLabels.map((label) => (
						<option key={label} value={label}>
							{label}
						</option>
					))}
				</select>
				<select
					aria-label="队列显示顺序"
					value={displayOrder}
					onChange={(event) => {
						const value = event.target.value;
						if (
							value === "delivery_order" ||
							value === "last_attempt_newest_first" ||
							value === "enqueued_oldest_first"
						)
							setDisplayOrder(value);
					}}
					className="min-w-0 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary"
				>
					<option value="delivery_order">实际投递顺序</option>
					<option value="last_attempt_newest_first">最近尝试在前</option>
					<option value="enqueued_oldest_first">最早入队在前</option>
				</select>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pt-1 pb-3">
				{!allowDeliveryOrderEditing ? (
					<p className="px-1 py-1 text-[11px] text-text-secondary">
						当前仅调整显示；切回“实际投递顺序”可上移、下移或合并消息。
					</p>
				) : null}
				{isTaskAgentExecutionDisabled ? (
					<p className="px-1 py-2 text-xs text-text-secondary">
						任务已完成，恢复任务后可继续投递。现有队列记录仍可查看和取消。
					</p>
				) : null}
				{pending.length === 0 ? (
					<p className="px-1 py-2 text-xs leading-5 text-text-tertiary">
						当前没有待投递消息。Kanban 的即时注入、人工发送及排队消息都会在此显示。
					</p>
				) : (
					pending.map((projection, index) => {
						const waitingQueueEntryIndex = waitingQueueEntryIdsBeforeMessageTypeFilter.indexOf(
							projection.queueEntryId,
						);
						// 筛选不能改变合并对象：只连接仍可见、且在完整等待队列里也相邻的两条。
						const previousPendingProjection =
							allowDeliveryOrderEditing &&
							pending[index - 1]?.queueEntryId ===
								waitingQueueEntryIdsBeforeMessageTypeFilter[waitingQueueEntryIndex - 1]
								? pending[index - 1]
								: undefined;
						const nextPendingProjection =
							allowDeliveryOrderEditing &&
							pending[index + 1]?.queueEntryId ===
								waitingQueueEntryIdsBeforeMessageTypeFilter[waitingQueueEntryIndex + 1]
								? pending[index + 1]
								: undefined;
						// 竖线只画真的会一起发出的那几条：程序化条目两侧的链在服务端就是断的。
						const isChainedToNext =
							nextPendingProjection !== undefined &&
							isTaskPromptDeliveryWaitingForAgentTurn(projection) &&
							isTaskPromptDeliveryWaitingForAgentTurn(nextPendingProjection) &&
							projection.deliverTogetherWithNextQueuedEntry &&
							!isProgrammaticInjectionProjection(projection) &&
							!isProgrammaticInjectionProjection(nextPendingProjection);
						const isChainedFromPrevious =
							previousPendingProjection?.deliverTogetherWithNextQueuedEntry === true &&
							isTaskPromptDeliveryWaitingForAgentTurn(projection) &&
							isTaskPromptDeliveryWaitingForAgentTurn(previousPendingProjection) &&
							!isProgrammaticInjectionProjection(previousPendingProjection) &&
							!isProgrammaticInjectionProjection(projection);
						return (
							<div key={projection.queueEntryId} className="flex flex-col gap-1">
								<PendingQueuedPromptRow
									isTaskAgentExecutionDisabled={isTaskAgentExecutionDisabled}
									projection={projection}
									nowEpochMs={nowEpochMs}
									allowDeliveryOrderEditing={allowDeliveryOrderEditing}
									position={waitingQueueEntryIndex + 1}
									isFirstPending={waitingQueueEntryIndex === 0}
									isLastPending={
										waitingQueueEntryIndex === waitingQueueEntryIdsBeforeMessageTypeFilter.length - 1
									}
									isChainedFromPrevious={isChainedFromPrevious}
									isChainedToNext={isChainedToNext}
									controller={controller}
								/>
								{nextPendingProjection &&
								isTaskPromptDeliveryWaitingForAgentTurn(projection) &&
								isTaskPromptDeliveryWaitingForAgentTurn(nextPendingProjection) ? (
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
							最近结果
						</span>
						{settled.map((projection) => (
							<SettledQueuedPromptRow
								isTaskAgentExecutionDisabled={isTaskAgentExecutionDisabled}
								key={projection.queueEntryId}
								projection={projection}
								nowEpochMs={nowEpochMs}
								controller={controller}
							/>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
