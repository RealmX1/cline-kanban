import { useLayoutEffect, useRef } from "react";
import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import { Button } from "@/components/ui/button";
import { useTaskConversationHistory } from "@/hooks/use-task-conversation-history";

export function ReadOnlyTaskConversationHistoryPanel({
	workspaceId,
	workspaceTaskId,
	taskConversationSessionId,
	onRestoreTask,
}: {
	workspaceId: string | null;
	workspaceTaskId: string;
	taskConversationSessionId: string;
	onRestoreTask?: () => void;
}) {
	const history = useTaskConversationHistory({ workspaceId, workspaceTaskId, taskConversationSessionId });
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const olderPageScrollHeightRef = useRef<number | null>(null);
	const initiallyScrolledIdentityRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (history.error || !history.page) olderPageScrollHeightRef.current = null;
	}, [history.error, history.page]);
	useLayoutEffect(() => {
		const container = scrollContainerRef.current;
		if (!container || !history.page) return;
		if (olderPageScrollHeightRef.current !== null) {
			container.scrollTop += container.scrollHeight - olderPageScrollHeightRef.current;
			olderPageScrollHeightRef.current = null;
		} else if (initiallyScrolledIdentityRef.current !== history.identity) {
			container.scrollTop = container.scrollHeight;
			initiallyScrolledIdentityRef.current = history.identity;
		}
	}, [history.identity, history.page]);
	return (
		<section
			aria-label="会话历史"
			data-read-only-task-conversation-history=""
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0"
		>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-text-secondary">
				<span className="font-medium text-text-primary">会话历史</span>
				<span>Done · 只读</span>
				<Button
					size="sm"
					variant="ghost"
					className="ml-auto"
					disabled={history.isLoading}
					onClick={() => {
						initiallyScrolledIdentityRef.current = null;
						void history.refresh();
					}}
				>
					刷新历史
				</Button>
				{onRestoreTask ? (
					<Button size="sm" variant="ghost" onClick={onRestoreTask}>
						恢复任务
					</Button>
				) : null}
			</div>
			<div ref={scrollContainerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
				<p className="text-xs text-text-secondary">任务已完成。恢复任务后可继续对话。</p>
				{history.page?.nextCursor ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={history.isLoading}
						onClick={() => {
							olderPageScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? null;
							void history.loadOlder();
						}}
					>
						加载更早记录
					</Button>
				) : null}
				{history.isLoading ? (
					<p role="status" className="text-sm text-text-secondary">
						正在读取会话历史…
					</p>
				) : null}
				{history.error || history.page?.notice ? (
					<p role="status" className="whitespace-pre-wrap text-sm text-text-secondary">
						{history.error ?? history.page?.notice}
					</p>
				) : null}
				{history.page?.availability === "available" &&
				history.page.messages.length === 0 &&
				!history.page.nextCursor ? (
					<p className="text-sm text-text-secondary">这条会话尚无聊天记录。</p>
				) : null}
				{history.page?.messages.map((message) => (
					<div key={message.id} data-history-message-role={message.role} className="min-w-0">
						{message.role === "tool" ? (
							<details className="rounded-md border border-border px-2 py-1 text-sm text-text-secondary">
								<summary className="cursor-pointer">{message.meta?.toolName ?? "工具记录"}</summary>
								<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-text-primary">
									{message.content}
								</pre>
							</details>
						) : (
							<ClineChatMessageItem message={message} />
						)}
					</div>
				))}
			</div>
		</section>
	);
}
