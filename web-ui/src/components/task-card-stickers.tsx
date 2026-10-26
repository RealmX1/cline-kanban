import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronUp, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
	resolveTaskStickerOverlayExplicitActivationSource,
	type TaskCardStickersController,
} from "@/hooks/use-task-card-stickers";

export function TaskCardStickers({ controller }: { controller: TaskCardStickersController }) {
	const titleId = useId();
	const { entries, editor, open, isSaving, readOnly } = controller;
	const latestEditedEntry = editor
		? entries.find((entry) => entry.taskStickerEntryId === editor.taskStickerEntryId)
		: undefined;
	return (
		<Popover.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !editor && !isSaving) controller.close();
			}}
		>
			<Popover.Anchor virtualRef={controller.cardElementRef} />
			{entries.length > 0 ? (
				<button
					type="button"
					aria-label={`便签 ${entries.length}`}
					aria-expanded={open}
					aria-haspopup="dialog"
					data-task-sticker-stub=""
					className="before:absolute before:-inset-x-2 before:-inset-y-3 absolute bottom-0 left-3 z-10 inline-flex translate-y-1/2 items-center gap-1 rounded border border-border-bright bg-surface-3 px-1.5 text-[10px] leading-4 text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
					onPointerDown={(event) => {
						controller.beginPointerInteraction(event.pointerType);
						event.stopPropagation();
					}}
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Escape") {
							event.preventDefault();
							controller.close(true);
						}
					}}
					onClick={(event) => {
						event.stopPropagation();
						controller.activate(resolveTaskStickerOverlayExplicitActivationSource(event), event.currentTarget);
					}}
				>
					<StickyNote size={10} />
					便签 {entries.length}
				</button>
			) : null}
			{open ? (
				<Popover.Portal>
					<Popover.Content
						ref={controller.overlayElementRef}
						side="bottom"
						align="start"
						sideOffset={8}
						collisionPadding={12}
						aria-labelledby={titleId}
						aria-modal={false}
						data-task-sticker-overlay=""
						className="max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 p-3 text-sm text-text-primary"
						onOpenAutoFocus={(event) => {
							if (!controller.keyboardOpened.current || editor) event.preventDefault();
						}}
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							if (controller.returnFocusOnClose.current) controller.explicitOpenerRef.current?.focus();
						}}
						onEscapeKeyDown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							controller.close(true);
						}}
						onInteractOutside={(event) => {
							if (editor || isSaving || controller.cardElementRef.current?.contains(event.target as Node))
								event.preventDefault();
						}}
						onPointerEnter={controller.pointerEnter}
						onPointerLeave={controller.pointerLeave}
						onBlurCapture={controller.scheduleClose}
						onPointerDown={(event) => {
							controller.beginPointerInteraction(event.pointerType);
							event.stopPropagation();
						}}
						onMouseDown={(event) => event.stopPropagation()}
						onClick={(event) => event.stopPropagation()}
						onDoubleClick={(event) => event.stopPropagation()}
						onKeyDown={(event) => {
							controller.beginKeyboardInteraction();
							event.stopPropagation();
							if (event.key === "Escape") {
								event.preventDefault();
								controller.close(true);
							}
						}}
					>
						<div className="mb-2 flex shrink-0 items-center justify-between gap-2">
							<h3 id={titleId} className="flex items-center gap-1.5 text-sm font-medium">
								<StickyNote size={14} />
								任务便签 <span className="text-xs">{entries.length}</span>
							</h3>
							<div className="flex items-center gap-1">
								{!readOnly ? (
									<Button
										size="xs"
										variant="ghost"
										icon={<Plus size={12} />}
										disabled={isSaving || editor !== null}
										onClick={(event) =>
											controller.startNew(
												undefined,
												resolveTaskStickerOverlayExplicitActivationSource(event),
											)
										}
									>
										添加便签
									</Button>
								) : null}
								<Button
									size="xs"
									variant="ghost"
									icon={<X size={12} />}
									aria-label="关闭便签"
									onClick={() => controller.close(true)}
								/>
							</div>
						</div>
						<div
							ref={(scrollViewport) => {
								const textarea = controller.textareaRef.current;
								if (!scrollViewport || !textarea || !controller.focusEditorWhenMounted.current) return;
								// 首次挂载需等浮层定位并限制高度，且只滚动这个内部视口。
								requestAnimationFrame(() => {
									if (
										!scrollViewport.isConnected ||
										controller.textareaRef.current !== textarea ||
										!controller.focusEditorWhenMounted.current
									)
										return;
									textarea.focus({ preventScroll: true });
									scrollViewport.scrollTop = scrollViewport.scrollHeight;
									controller.focusEditorWhenMounted.current = false;
								});
							}}
							className="min-h-0 overflow-y-auto overscroll-contain"
							aria-busy={isSaving}
						>
							{entries.map((entry) => (
								<div
									key={entry.taskStickerEntryId}
									data-task-sticker-entry-id={entry.taskStickerEntryId}
									className="border-t border-divider py-2 first:border-t-0"
								>
									<div className="flex items-start gap-1">
										<Button
											size="xs"
											variant="ghost"
											aria-label={entry.isCollapsed ? "展开便签" : "收起便签"}
											aria-expanded={!entry.isCollapsed}
											icon={entry.isCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
											disabled={isSaving}
											onClick={() =>
												void controller.mutate({
													operation: "set_collapsed",
													taskStickerEntryId: entry.taskStickerEntryId,
													isCollapsed: !entry.isCollapsed,
												})
											}
										/>
										{entry.isCollapsed ? (
											<p className="min-w-0 flex-1 truncate py-0.5">{entry.stickerText.split(/\r?\n/)[0]}</p>
										) : (
											<span className="flex-1 py-0.5 text-xs text-text-primary">便签</span>
										)}
										{!readOnly ? (
											<>
												<Button
													size="xs"
													variant="ghost"
													icon={<Pencil size={12} />}
													aria-label="编辑便签"
													disabled={isSaving || editor !== null}
													onClick={() => controller.startEditing(entry)}
												/>
												<Button
													size="xs"
													variant="ghost"
													icon={<Trash2 size={12} />}
													aria-label="删除便签"
													disabled={isSaving || editor !== null}
													onClick={() =>
														void controller.mutate({
															operation: "delete",
															taskStickerEntryId: entry.taskStickerEntryId,
															expectedStickerText: entry.stickerText,
														})
													}
												/>
											</>
										) : null}
									</div>
									{!entry.isCollapsed ? (
										<p className="whitespace-pre-wrap break-words px-1 pt-1 leading-relaxed [overflow-wrap:anywhere]">
											{entry.stickerText}
										</p>
									) : null}
								</div>
							))}
							{entries.length === 0 && !editor ? (
								<p className="py-3 text-xs">添加便签，记录需要随时查看的事项。</p>
							) : null}
							{editor ? (
								<div className="space-y-2 border-t border-divider pt-2">
									<label className="block text-xs" htmlFor={`${titleId}-draft`}>
										{editor.expectedStickerText === null ? "新便签" : "编辑便签"}
									</label>
									<textarea
										id={`${titleId}-draft`}
										ref={controller.textareaRef}
										aria-label="便签正文"
										rows={4}
										value={editor.stickerText}
										disabled={isSaving}
										onChange={(event) => controller.setDraftText(event.target.value)}
										className="w-full resize-y rounded-md border border-border-bright bg-surface-0 p-2 text-sm text-text-primary focus:border-accent focus:outline-none"
									/>
									{latestEditedEntry && latestEditedEntry.stickerText !== editor.expectedStickerText ? (
										<div className="space-y-1 text-xs">
											<p className="whitespace-pre-wrap break-words">
												最新正文：{latestEditedEntry.stickerText}
											</p>
											<Button
												size="xs"
												onClick={() =>
													controller.adoptLatestTextAsEditBaseline(latestEditedEntry.stickerText)
												}
											>
												已核对最新正文，继续编辑草稿
											</Button>
										</div>
									) : null}
									<div className="flex gap-2">
										<Button
											size="sm"
											disabled={isSaving || !editor.stickerText.trim()}
											onClick={controller.saveDraft}
										>
											{isSaving ? "正在保存…" : "保存便签"}
										</Button>
										<Button size="sm" variant="ghost" disabled={isSaving} onClick={controller.cancelEditing}>
											取消编辑
										</Button>
									</div>
								</div>
							) : null}
							{controller.error ? (
								<div role="alert" className="mt-2 space-y-1 text-xs text-status-red">
									<p>{controller.error}</p>
									<Button
										size="xs"
										variant="ghost"
										disabled={isSaving || controller.isLoading}
										onClick={() => {
											const failedMutation = controller.failedMutation;
											if (!failedMutation) void controller.readLatest();
											else if (
												editor &&
												(failedMutation.operation === "create" ||
													failedMutation.operation === "update_text")
											)
												controller.saveDraft();
											else void controller.mutate(failedMutation);
										}}
									>
										重试
									</Button>
								</div>
							) : null}
						</div>
					</Popover.Content>
				</Popover.Portal>
			) : null}
		</Popover.Root>
	);
}
