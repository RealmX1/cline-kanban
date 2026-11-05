import { ArrowDownToLine, ChevronDown, ChevronRight, RotateCcw, Search } from "lucide-react";
import { type MutableRefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSharedMobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";
import { useTaskConversationHistory } from "@/hooks/use-task-conversation-history";
import { useTaskConversationTranscriptDocumentVisibilityPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";

export function TaskConversationTranscriptDocumentReaderPanel({
	workspaceId,
	workspaceTaskId,
	taskConversationSessionId,
	nativeTranscriptBindingKey,
	isVisible = true,
	scrollContainerRef,
}: {
	workspaceId: string | null;
	workspaceTaskId: string;
	taskConversationSessionId: string;
	nativeTranscriptBindingKey?: string;
	isVisible?: boolean;
	scrollContainerRef?: MutableRefObject<HTMLElement | null>;
}) {
	const history = useTaskConversationHistory({
		workspaceId,
		workspaceTaskId,
		taskConversationSessionId,
		nativeTranscriptBindingKey,
		transcriptReadConsistency: "stable_snapshot",
	});
	const [visibility, setVisibility] = useTaskConversationTranscriptDocumentVisibilityPreference();
	const [searchQuery, setSearchQuery] = useState("");
	const [expandedMessageIds, setExpandedMessageIds] = useState<ReadonlySet<string>>(new Set());
	const [isScrolledAwayFromLatest, setIsScrolledAwayFromLatest] = useState(false);
	const documentScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const savedScrollTopRef = useRef(0);
	const olderPageAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
	const scrollToLatestAfterReadRef = useRef(true);
	const isMobile = useIsMobile();
	const controls = useSharedMobileFocusViewCollapsibleControls();
	const upperToolsExpanded = !controls?.isEnabled || controls.upperNavigationAndToolsExpanded;
	const messages = history.page?.messages;
	const visibleMessageIds = useMemo(() => {
		const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
		return new Set(
			(messages ?? [])
				.filter((message) => {
					if (visibility === "conversation_only" && !["user", "assistant"].includes(message.role)) return false;
					if (visibility === "conversation_and_tools" && !["user", "assistant", "tool"].includes(message.role))
						return false;
					return (
						!normalizedSearch ||
						`${message.meta?.toolName ?? ""}\n${message.content}`.toLocaleLowerCase().includes(normalizedSearch)
					);
				})
				.map((message) => message.id),
		);
	}, [messages, searchQuery, visibility]);

	useLayoutEffect(() => {
		const container = documentScrollContainerRef.current;
		if (!container || !isVisible || !history.page) return;
		if (olderPageAnchorRef.current && !history.isLoading) {
			const anchor = olderPageAnchorRef.current;
			container.scrollTop = anchor.scrollTop + container.scrollHeight - anchor.scrollHeight;
			olderPageAnchorRef.current = null;
		} else if (
			scrollToLatestAfterReadRef.current &&
			history.page.availability !== "unavailable" &&
			!history.isLoading &&
			!history.error
		) {
			container.scrollTop = container.scrollHeight;
			scrollToLatestAfterReadRef.current = false;
		} else container.scrollTop = savedScrollTopRef.current;
		savedScrollTopRef.current = container.scrollTop;
		setIsScrolledAwayFromLatest(container.scrollHeight - container.scrollTop - container.clientHeight > 40);
	}, [history.page, history.isLoading, history.error, isVisible]);

	return (
		<section
			aria-label="会话转录文档"
			data-task-conversation-transcript-document-reader=""
			className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0 text-text-primary"
		>
			<div
				className={cn(
					"shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2",
					upperToolsExpanded ? "flex" : "hidden",
				)}
			>
				<NativeSelect
					aria-label="阅读内容可见度"
					size="sm"
					value={visibility}
					className={cn(isMobile && "min-h-11")}
					onChange={(event) => {
						const value = event.target.value;
						if (value === "conversation_only" || value === "conversation_and_tools" || value === "all_records")
							setVisibility(value);
					}}
				>
					<option value="conversation_only">仅对话</option>
					<option value="conversation_and_tools">对话与工具</option>
					<option value="all_records">全部记录</option>
				</NativeSelect>
				<div className="relative flex min-w-32 flex-1 items-center">
					<Search size={14} aria-hidden className="pointer-events-none absolute left-2 text-text-secondary" />
					<input
						type="search"
						aria-label="搜索已加载记录"
						placeholder="搜索已加载记录"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						data-mobile-focus-view-idle-collapse-suspension=""
						className={cn(
							"w-full rounded-md border border-border bg-surface-2 py-1 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-primary focus-visible:outline-2 focus-visible:outline-accent",
							isMobile && "min-h-11",
						)}
					/>
				</div>
				<Button
					size={isMobile ? "md" : "sm"}
					variant="ghost"
					icon={<RotateCcw size={14} />}
					disabled={history.isLoading}
					onClick={() => {
						scrollToLatestAfterReadRef.current = true;
						void history.refresh().then((success) => {
							if (!success) scrollToLatestAfterReadRef.current = false;
						});
					}}
					className={cn(isMobile && "min-h-11")}
				>
					刷新到最新
				</Button>
				<p className="w-full text-xs text-text-secondary">
					稳定快照 · 已加载 {messages?.length ?? 0} 条，显示 {visibleMessageIds.size}{" "}
					条。仅搜索当前可见的已加载记录。
				</p>
			</div>
			<div
				ref={(element) => {
					documentScrollContainerRef.current = element;
					if (scrollContainerRef) scrollContainerRef.current = element;
				}}
				data-transcript-document-scroll-container=""
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
				onScroll={(event) => {
					if (!isVisible) return;
					const container = event.currentTarget;
					savedScrollTopRef.current = container.scrollTop;
					if (olderPageAnchorRef.current) olderPageAnchorRef.current.scrollTop = container.scrollTop;
					setIsScrolledAwayFromLatest(container.scrollHeight - container.scrollTop - container.clientHeight > 40);
				}}
			>
				<div className="mx-auto max-w-[75ch] space-y-4 px-3 py-4 sm:px-5">
					{history.page?.nextCursor ? (
						<Button
							size={isMobile ? "md" : "sm"}
							variant="ghost"
							disabled={history.isLoading}
							onClick={() => {
								const container = documentScrollContainerRef.current;
								if (container)
									olderPageAnchorRef.current = {
										scrollHeight: container.scrollHeight,
										scrollTop: container.scrollTop,
									};
								void history.loadOlder();
							}}
						>
							加载更早记录
						</Button>
					) : null}
					{history.isLoading ? (
						<p role="status" className="text-sm text-text-secondary">
							正在读取持久会话记录…
						</p>
					) : null}
					{history.error || history.page?.notice ? (
						<p role="status" className="whitespace-pre-wrap text-sm text-text-secondary">
							{history.error ?? history.page?.notice}
						</p>
					) : null}
					{history.page &&
					history.page.availability !== "unavailable" &&
					!history.isLoading &&
					visibleMessageIds.size === 0 ? (
						<p className="text-sm text-text-secondary">
							{messages?.length
								? "当前可见度与搜索条件下没有记录。"
								: "这条会话尚无已持久化的可读记录。落盘后可刷新到最新。"}
						</p>
					) : null}
					{messages?.map((message) => {
						const expanded = expandedMessageIds.has(message.id);
						const collapsible = message.role === "tool" || message.role === "reasoning";
						return (
							<div
								key={message.id}
								hidden={!visibleMessageIds.has(message.id)}
								data-history-message-role={message.role}
								data-history-message-id={message.id}
								className="min-w-0"
							>
								{collapsible ? (
									<>
										<button
											type="button"
											aria-expanded={expanded}
											className={cn(
												"flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent",
												isMobile && "min-h-11",
											)}
											onClick={() =>
												setExpandedMessageIds((current) => {
													const next = new Set(current);
													if (next.has(message.id)) next.delete(message.id);
													else next.add(message.id);
													return next;
												})
											}
										>
											{expanded ? (
												<ChevronDown size={14} aria-hidden />
											) : (
												<ChevronRight size={14} aria-hidden />
											)}
											<span className="min-w-0 break-words">
												{message.role === "reasoning" ? "可读推理" : message.meta?.toolName || "工具记录"}
											</span>
										</button>
										{expanded ? (
											message.role === "tool" ? (
												<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-1 p-3 text-xs">
													{message.content}
												</pre>
											) : (
												<ClineMarkdownContent content={message.content} />
											)
										) : null}
									</>
								) : (
									<ClineChatMessageItem message={message} />
								)}
							</div>
						);
					})}
				</div>
			</div>
			{isScrolledAwayFromLatest ? (
				<div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
					<Button
						variant="default"
						size={isMobile ? "md" : "sm"}
						icon={<ArrowDownToLine size={14} />}
						className="pointer-events-auto"
						onClick={() => {
							const container = documentScrollContainerRef.current;
							if (container) {
								container.scrollTop = container.scrollHeight;
								savedScrollTopRef.current = container.scrollTop;
							}
							setIsScrolledAwayFromLatest(false);
						}}
					>
						返回最新
					</Button>
				</div>
			) : null}
		</section>
	);
}
