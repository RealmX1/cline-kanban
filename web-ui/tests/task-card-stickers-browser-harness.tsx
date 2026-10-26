import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardCard } from "../src/components/board-card";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "../src/components/task-card-body-visual-density-context";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createTaskStickerBrowserFixtureCard } from "./task-card-stickers-browser-fixture";
import "../src/styles/globals.css";

function Harness() {
	const [navigationCount, setNavigationCount] = useState(0);
	const [dragCount, setDragCount] = useState(0);
	const bottom = new URLSearchParams(location.search).has("bottom");
	const startsWithoutStickers = new URLSearchParams(location.search).has("empty");
	const [columnId, setColumnId] = useState<"review" | "validation">("review");
	return (
		<TooltipProvider>
			<TaskCommentsDialogProvider currentWorkspaceId="sticker-workspace">
				<main className="min-h-screen bg-surface-0 p-6 text-text-primary">
					<label className="block">
						当前输入
						<input aria-label="当前输入" className="ml-2 border border-border bg-surface-1" />
					</label>
					<output aria-label="卡片跳转次数">{navigationCount}</output>
					<output aria-label="拖拽次数">{dragCount}</output>
					<button
						type="button"
						className="ml-4"
						onClick={() => setColumnId((value) => (value === "review" ? "validation" : "review"))}
					>
						切换任务 Stage
					</button>
					<div className={bottom ? "fixed bottom-3 left-6 w-80" : "mt-8 flex flex-wrap items-start gap-8"}>
						<section data-sticker-host="board" className="w-80 overflow-hidden">
							<DragDropContext onDragEnd={() => setDragCount((value) => value + 1)}>
								<Droppable droppableId="sticker-test-column">
									{(provided) => (
										<div ref={provided.innerRef} {...provided.droppableProps}>
											<BoardCard
												index={0}
												card={{
													...createTaskStickerBrowserFixtureCard("main-task"),
													...(startsWithoutStickers ? { taskStickerEntries: undefined } : {}),
												}}
												columnId={columnId}
												onClick={() => setNavigationCount((value) => value + 1)}
											/>
											{provided.placeholder}
										</div>
									)}
								</Droppable>
							</DragDropContext>
							<p data-sticker-adjacent-element="" className="mt-8">
								相邻卡片位置参照
							</p>
						</section>
						{!bottom ? (
							<>
								<section data-sticker-host="focus" className="w-72">
									<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
										<TaskCardBody
											card={createTaskStickerBrowserFixtureCard("focus-task")}
											columnId="review"
											onClick={() => setNavigationCount((value) => value + 1)}
										/>
									</TaskCardBodyVisualDensityProvider>
								</section>
								<section data-sticker-host="pinboard" className="w-72">
									<TaskCardBody
										card={createTaskStickerBrowserFixtureCard("pin-task")}
										columnId="review"
										renderRole="pinned_card_copy_in_task_pinboard"
									/>
								</section>
								<Popover.Root>
									<Popover.Trigger className="border border-border p-2">打开嵌套预览</Popover.Trigger>
									<Popover.Portal>
										<Popover.Content
											data-sticker-preview-host=""
											side="bottom"
											className="z-50 w-80 overflow-hidden bg-surface-1 p-3"
										>
											<TaskCardBody
												card={createTaskStickerBrowserFixtureCard("preview-task")}
												columnId="review"
												renderRole="task_card_copy_in_related_task_preview"
											/>
										</Popover.Content>
									</Popover.Portal>
								</Popover.Root>
							</>
						) : null}
					</div>
				</main>
			</TaskCommentsDialogProvider>
		</TooltipProvider>
	);
}
const mountElement = document.body.appendChild(document.createElement("div"));
createRoot(mountElement).render(<Harness />);
