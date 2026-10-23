import { ArrowLeft, ExternalLink, Plus, Search, Send, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TaskWorkbench } from "@/components/detail-panels/task-workbench";
import { TaskLookupTurnExecutionDetails } from "@/components/task-lookup-turn-execution-details";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import { useFocusViewDesktopPanelArrangement } from "@/hooks/use-focus-view-desktop-panel-arrangement";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { TaskLookupWorkbenchController } from "@/hooks/use-task-lookup-workbench";
import { ResizeHandle } from "@/resize/resize-handle";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { TaskLookupCandidate } from "@/runtime/task-lookup-conversation-query";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { useJsonLocalStorageValue } from "@/utils/react-use";

type TaskLookupWorkbenchModule = "query_history" | "candidate_details" | "query_scope_and_executor";
const MODULE_LABELS: Record<TaskLookupWorkbenchModule, string> = {
	query_history: "查询会话",
	candidate_details: "候选详情",
	query_scope_and_executor: "检索范围与执行设置",
};
const DEFAULT_SLOTS: readonly [TaskLookupWorkbenchModule, TaskLookupWorkbenchModule] = [
	"query_history",
	"candidate_details",
];
const STATUS_LABELS = {
	running: "检索中",
	completed: "已完成",
	failed: "查询失败",
	cancelled: "已取消",
	interrupted: "已中断",
};
const STAGE_LABELS: Record<string, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	validation: "Validation",
	trash: "Done",
};
const conversationScrollPositions = new Map<string, number>();

function TaskLookupExecutorSettings({ controller }: { controller: TaskLookupWorkbenchController }) {
	const [agentId, setAgentId] = useState<"claude" | "codex">("codex");
	const [modelId, setModelId] = useState("");
	useEffect(() => {
		if (controller.executorSettings) {
			setAgentId(controller.executorSettings.agentId);
			setModelId(controller.executorSettings.modelId ?? "");
		}
	}, [controller.executorSettings]);
	return (
		<div className="space-y-3 border-t border-border pt-3">
			<p className="text-xs text-text-secondary">
				共享执行器设置，作用于 {controller.contextWorkspaceId} 的索引功能。
			</p>
			<label className="flex flex-col gap-1 text-xs">
				执行 Agent
				<select
					aria-label="查卡执行 Agent"
					value={agentId}
					onChange={(event) => setAgentId(event.target.value as "claude" | "codex")}
					className="h-11 rounded-md border border-border bg-surface-2 px-2 text-base md:h-9 md:text-xs"
				>
					<option value="codex">Codex</option>
					<option value="claude">Claude</option>
				</select>
			</label>
			<label className="flex flex-col gap-1 text-xs">
				模型
				<input
					aria-label="查卡模型"
					value={modelId}
					onChange={(event) => setModelId(event.target.value)}
					placeholder="使用 Agent 默认模型"
					className="h-11 min-w-0 rounded-md border border-border bg-surface-2 px-2 text-base placeholder:text-text-secondary md:h-9 md:text-sm"
				/>
			</label>
			<Button
				disabled={controller.isPending || !controller.executorSettings || controller.isRunning}
				onClick={() => void controller.saveExecutorSettings({ agentId, modelId: modelId.trim() || null })}
			>
				保存执行设置
			</Button>
		</div>
	);
}

export function TaskLookupWorkbenchView({
	controller,
	projects,
	onOpenTask,
	returnLabel = "返回任务",
}: {
	controller: TaskLookupWorkbenchController;
	projects: readonly { id: string; name: string }[];
	onOpenTask: (projectId: string, taskId: string) => void;
	returnLabel?: string;
}) {
	const isMobile = useIsMobile();
	const arrangement = useFocusViewDesktopPanelArrangement();
	const isBelow = arrangement.arrangement === "agent_above_workbench_below";
	const [agentRatio, setAgentRatio] = useJsonLocalStorageValue<number>(
		LocalStorageKey.TaskLookupAgentPanelRatio,
		0.65,
	);
	const [slotRatio, setSlotRatio] = useJsonLocalStorageValue<number>(
		LocalStorageKey.TaskLookupWorkbenchSlotRatio,
		0.5,
	);
	const [mobilePanel, setMobilePanel] = useState<"conversation" | TaskLookupWorkbenchModule>("conversation");
	const [previewRequestKey, setPreviewRequestKey] = useState(0);
	const layoutRef = useRef<HTMLDivElement>(null);
	const transcriptRef = useRef<HTMLDivElement>(null);
	const shouldFollowLatestTurnRef = useRef(true);
	const lastDisplayedTurnIdRef = useRef<string | undefined>(undefined);
	const { startDrag } = useResizeDrag();
	const conversationId = controller.conversation?.conversationId;
	const latestTurnIdForScrollRestorationRef = useRef<string | undefined>(undefined);
	latestTurnIdForScrollRestorationRef.current = controller.conversation?.turns.at(-1)?.turnId;
	useLayoutEffect(() => {
		const element = transcriptRef.current;
		if (element && conversationId) {
			element.scrollTop = conversationScrollPositions.get(conversationId) ?? element.scrollHeight;
			shouldFollowLatestTurnRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
			lastDisplayedTurnIdRef.current = latestTurnIdForScrollRestorationRef.current;
		}
	}, [conversationId, mobilePanel]);
	const latestTurnId = controller.conversation?.turns.at(-1)?.turnId;
	const conversationRevision = controller.conversation?.revision;
	useLayoutEffect(() => {
		const element = transcriptRef.current;
		if (!element || !conversationId) return;
		if (shouldFollowLatestTurnRef.current || latestTurnId !== lastDisplayedTurnIdRef.current) {
			element.scrollTop = element.scrollHeight;
			conversationScrollPositions.set(conversationId, element.scrollTop);
			shouldFollowLatestTurnRef.current = true;
		}
		lastDisplayedTurnIdRef.current = latestTurnId;
	}, [conversationId, latestTurnId, conversationRevision]);
	const selectCandidate = (candidate: TaskLookupCandidate) => {
		controller.selectCandidate(candidate);
		setPreviewRequestKey((value) => value + 1);
		if (isMobile) setMobilePanel("candidate_details");
	};
	const openCandidate = () => {
		const reference = controller.candidatePreview?.taskReference;
		if (reference) {
			controller.close();
			onOpenTask(reference.workspaceId, reference.taskId);
		}
	};
	const candidate = controller.selectedCandidate;
	const modules = {
		query_history: (
			<div className="flex flex-col gap-1 p-2">
				<Button
					icon={<Plus size={14} />}
					disabled={controller.isPending}
					onClick={() => void controller.startNewConversation()}
				>
					新建查询会话
				</Button>
				{controller.isLoading && controller.conversations.length === 0 ? (
					<p role="status" className="kb-skeleton h-10 rounded-md" aria-label="正在加载查询历史" />
				) : null}
				{!controller.isLoading && controller.conversations.length === 0 ? (
					<p className="p-2 text-xs text-text-secondary">提交第一条问题后，查询过程和结果会保存在这里。</p>
				) : null}
				{controller.conversations.map((entry) => (
					<button
						type="button"
						key={entry.conversationId}
						disabled={controller.isPending}
						aria-current={entry.conversationId === conversationId ? "true" : undefined}
						onClick={() => controller.selectConversation(entry)}
						className={cn(
							"rounded-md p-2 text-left hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent",
							entry.conversationId === conversationId && "bg-surface-3",
						)}
					>
						<span className="block break-words text-sm">{entry.title}</span>
						<span className="text-xs text-text-secondary">
							{entry.turns.length} 轮 · {new Date(entry.updatedAt).toLocaleString()}
							{entry.turns.at(-1)?.status === "running" ? " · 检索中" : ""}
						</span>
					</button>
				))}
			</div>
		),
		candidate_details: (
			<div className="space-y-3 p-3 text-sm">
				{candidate ? (
					<>
						<h2 className="break-words font-medium">{controller.candidatePreview?.title ?? candidate.title}</h2>
						<p className="text-xs text-text-secondary">
							{candidate.projectName} / {candidate.taskReference.taskId} ·{" "}
							{STAGE_LABELS[controller.candidatePreview?.columnId ?? candidate.columnId] ?? candidate.columnId}
						</p>
						<p className="whitespace-pre-wrap break-words">{candidate.matchingReason}</p>
						{candidate.evidence.length ? (
							<div>
								<h3 className="mb-1 text-xs font-medium text-text-secondary">匹配依据</h3>
								<ul className="list-disc space-y-1 pl-4">
									{candidate.evidence.map((evidence, index) => (
										<li key={`${index}-${evidence}`} className="break-words">
											{evidence}
										</li>
									))}
								</ul>
							</div>
						) : null}
						{candidate.limitations.map((limitation, index) => (
							<p key={`${index}-${limitation}`} className="text-xs text-status-orange">
								{limitation}
							</p>
						))}
						{controller.previewError ? (
							<p role="alert" className="text-status-red">
								{controller.previewError}
							</p>
						) : controller.candidatePreview ? (
							<>
								<div className="flex flex-wrap gap-2">
									<Button variant="primary" icon={<ExternalLink size={13} />} onClick={openCandidate}>
										打开任务
									</Button>
									<Button
										onClick={() => {
											const url = new URL(
												buildProjectTaskDeepLinkUrl(
													candidate.taskReference.workspaceId,
													candidate.taskReference.taskId,
												),
												window.location.origin,
											);
											void navigator.clipboard.writeText(url.toString()).catch(() => undefined);
										}}
									>
										复制任务链接
									</Button>
								</div>
								<Button
									onClick={() => {
										controller.setDraftQuestion(
											`${controller.draftQuestion}${controller.draftQuestion ? "\n" : ""}请进一步比较 ${candidate.projectName}/${candidate.taskReference.taskId}：`,
										);
										setMobilePanel("conversation");
									}}
								>
									加入下一轮提问
								</Button>
								{controller.candidatePreview.columnId !== candidate.columnId ? (
									<p className="text-xs text-status-orange">
										此任务所在列已在检索后变化，以上显示当前所在列。
									</p>
								) : null}
								<h3 className="text-xs font-medium text-text-secondary">当前任务要求</h3>
								<pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
									{controller.candidatePreview.prompt}
								</pre>
							</>
						) : (
							<p role="status" className="kb-skeleton h-20 rounded-md" aria-label="正在读取候选详情" />
						)}
					</>
				) : (
					<p className="text-text-secondary">选择一个候选，在此核对要求与匹配理由；点击“打开任务”再进入任务。</p>
				)}
			</div>
		),
		query_scope_and_executor: (
			<div className="space-y-3 p-3">
				<label className="flex flex-col gap-1 text-xs">
					检索项目
					<select
						aria-label="查卡检索项目"
						value={
							controller.scope.projectIds.length > 1
								? JSON.stringify(controller.scope.projectIds)
								: (controller.scope.projectIds[0] ?? "")
						}
						disabled={controller.isRunning}
						onChange={(event) => {
							if (event.target.value.startsWith("[")) return;
							controller.setScope({
								...controller.scope,
								projectIds: event.target.value ? [event.target.value] : [],
							});
						}}
						className="h-11 rounded-md border border-border bg-surface-2 px-2 text-base md:h-9 md:text-xs"
					>
						<option value="">全部已注册项目</option>
						{controller.scope.projectIds.length > 1 ? (
							<option value={JSON.stringify(controller.scope.projectIds)}>
								已选 {controller.scope.projectIds.length} 个项目
							</option>
						) : null}
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				</label>
				<fieldset disabled={controller.isRunning} className="space-y-2">
					<legend className="mb-2 text-xs">任务所在列，全部不选表示不限</legend>
					<div className="flex flex-wrap gap-2">
						{Object.entries(STAGE_LABELS).map(([id, label]) => (
							<label key={id} className="flex min-h-11 items-center gap-1 text-xs md:min-h-8">
								<input
									type="checkbox"
									checked={controller.scope.columnIds.includes(id)}
									onChange={(event) =>
										controller.setScope({
											...controller.scope,
											columnIds: event.target.checked
												? [...controller.scope.columnIds, id]
												: controller.scope.columnIds.filter((value) => value !== id),
										})
									}
								/>
								{label}
							</label>
						))}
					</div>
				</fieldset>
				<p className="text-xs text-text-secondary">范围修改应用于下一轮，历史结果保留当时范围。</p>
				<TaskLookupExecutorSettings controller={controller} />
			</div>
		),
	};
	const chat = (
		<section aria-label="AI 查卡对话" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
			<div
				ref={transcriptRef}
				role="log"
				aria-label="查卡对话历史"
				onScroll={(event) => {
					const element = event.currentTarget;
					shouldFollowLatestTurnRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
					if (conversationId) conversationScrollPositions.set(conversationId, event.currentTarget.scrollTop);
				}}
				className="min-h-0 flex-1 space-y-6 overflow-auto p-4"
			>
				{!controller.conversation?.turns.length ? (
					<div className="mx-auto max-w-[70ch] space-y-3 py-8">
						<Search size={24} className="text-accent" />
						<h1 className="text-lg font-semibold">描述你要找的任务</h1>
						<p className="text-sm text-text-secondary">
							例如：是否已有任务在做持久多轮查卡？可以继续补充项目、阶段或功能细节。
						</p>
					</div>
				) : null}
				{controller.conversation?.turns.map((turn) => (
					<article key={turn.turnId} className="mx-auto max-w-[75ch] space-y-3">
						<p className="whitespace-pre-wrap break-words border-b border-border pb-2 font-medium">
							{turn.questionText}
						</p>
						<p className="text-xs text-text-secondary">
							{new Date(turn.startedAt).toLocaleString()} · {STATUS_LABELS[turn.status]} ·{" "}
							{turn.scope.projectIds.length ? turn.scope.projectIds.join(", ") : "全部项目"}
						</p>
						{controller.conversation ? (
							<TaskLookupTurnExecutionDetails
								conversation={controller.conversation}
								turn={turn}
								onRetry={() => void controller.retryTurn(turn)}
								isRetryDisabled={controller.isRunning || controller.isPending}
							/>
						) : null}
						{turn.errorMessage ? (
							<p role="alert" className="whitespace-pre-wrap break-words text-sm text-status-red">
								{turn.errorMessage}
							</p>
						) : null}
						{turn.result ? (
							<>
								<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
									{turn.result.answerText}
								</p>
								{turn.result.candidates.length === 0 ? (
									<p className="text-sm text-text-secondary">当前范围和材料下没有找到候选任务。</p>
								) : (
									<div className="divide-y divide-border border-y border-border">
										{turn.result.candidates.map((entry) => (
											<button
												type="button"
												key={`${entry.taskReference.workspaceId}/${entry.taskReference.taskId}`}
												aria-label={`预览候选 ${entry.title}`}
												onClick={() => selectCandidate(entry)}
												className="block w-full space-y-1 px-1 py-3 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
											>
												<span className="block break-words text-sm font-medium">{entry.title}</span>
												<span className="block text-xs text-text-secondary">
													{entry.projectName} / {entry.taskReference.taskId} ·{" "}
													{STAGE_LABELS[entry.columnId] ?? entry.columnId}
												</span>
												<span className="block break-words text-sm">{entry.matchingReason}</span>
											</button>
										))}
									</div>
								)}
								{turn.result.contextCompleteness.length ? (
									<details className="text-xs text-text-secondary">
										<summary>材料完整度与局限</summary>
										<p className="mt-2">
											部分索引背景材料缺失或被裁剪。可在候选详情核对当前完整要求；材料不足不代表相关功能不存在。
										</p>
									</details>
								) : null}
							</>
						) : null}
					</article>
				))}
			</div>
			{controller.errorMessage ? (
				<div role="alert" className="flex items-center gap-2 border-t border-border p-2 text-xs text-status-red">
					<span className="min-w-0 flex-1 break-words">{controller.errorMessage}</span>
					<Button onClick={controller.refresh}>重新读取</Button>
				</div>
			) : null}
			<form
				className="shrink-0 space-y-2 border-t border-border p-3"
				onSubmit={(event) => {
					event.preventDefault();
					void controller.submitQuestion();
				}}
			>
				<p className="text-xs text-text-secondary">
					下一轮范围：{controller.scope.projectIds.length ? controller.scope.projectIds.join(", ") : "全部项目"} ·{" "}
					{controller.scope.columnIds.length
						? controller.scope.columnIds.map((id) => STAGE_LABELS[id] ?? id).join(", ")
						: "全部列"}
				</p>
				<textarea
					aria-label="查卡问题"
					value={controller.draftQuestion}
					onChange={(event) => controller.setDraftQuestion(event.target.value)}
					placeholder="描述任务，或补充上一轮的条件…"
					rows={3}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							!isKeyboardEventEmittedDuringImeComposition(event)
						) {
							event.preventDefault();
							void controller.submitQuestion();
						}
					}}
					className="w-full resize-none rounded-md border border-border-bright bg-surface-1 p-2 text-base placeholder:text-text-secondary outline-none focus:border-accent md:text-sm"
				/>
				<div className="flex justify-end gap-2">
					{controller.isRunning ? (
						<Button
							icon={<Square size={13} />}
							disabled={controller.isPending}
							onClick={() => void controller.cancelTurn()}
						>
							取消本轮
						</Button>
					) : null}
					<Button
						variant="primary"
						type="submit"
						icon={<Send size={13} />}
						disabled={controller.isRunning || controller.isPending || !controller.draftQuestion.trim()}
					>
						查询任务
					</Button>
				</div>
			</form>
		</section>
	);
	return (
		<div data-task-lookup-workbench="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			<header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
				<Button icon={<ArrowLeft size={14} />} onClick={controller.close}>
					{returnLabel}
				</Button>
				<span className="min-w-0 truncate text-sm font-medium">
					AI 查卡{controller.conversation ? ` · ${controller.conversation.title}` : ""}
				</span>
			</header>
			{isMobile ? (
				<>
					<nav aria-label="查卡工作台页签" className="flex shrink-0 overflow-x-auto border-b border-border">
						{(["conversation", ...Object.keys(MODULE_LABELS)] as const).map((panel) => (
							<button
								key={panel}
								type="button"
								aria-pressed={mobilePanel === panel}
								onClick={() => setMobilePanel(panel as typeof mobilePanel)}
								className={cn(
									"min-h-11 shrink-0 px-3 text-xs",
									mobilePanel === panel && "bg-surface-3 text-accent",
								)}
							>
								{panel === "conversation" ? "查卡对话" : MODULE_LABELS[panel as TaskLookupWorkbenchModule]}
							</button>
						))}
					</nav>
					<div className="flex min-h-0 flex-1 flex-col overflow-auto">
						{mobilePanel === "conversation" ? chat : modules[mobilePanel]}
					</div>
				</>
			) : (
				<div
					ref={layoutRef}
					data-focus-view-panel-arrangement={arrangement.arrangement}
					className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isBelow && "flex-col")}
				>
					<div className="flex min-h-0 min-w-0" style={{ flex: `${agentRatio} 1 0` }}>
						{chat}
					</div>
					<ResizeHandle
						orientation={isBelow ? "horizontal" : "vertical"}
						ariaLabel="调整查卡对话与工作栏大小"
						tabIndex={0}
						ariaValueNow={Math.round(agentRatio * 100)}
						ariaValueMin={30}
						ariaValueMax={80}
						onKeyDown={(event) => {
							if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
								event.preventDefault();
								setAgentRatio(
									Math.max(
										0.3,
										Math.min(0.8, agentRatio + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -0.05 : 0.05)),
									),
								);
							}
						}}
						onMouseDown={(event) => {
							const size = isBelow ? layoutRef.current?.offsetHeight : layoutRef.current?.offsetWidth;
							if (!size) return;
							const start = isBelow ? event.clientY : event.clientX;
							const apply = (position: number) =>
								setAgentRatio(Math.max(0.3, Math.min(0.8, agentRatio + (position - start) / size)));
							startDrag(event, {
								axis: isBelow ? "y" : "x",
								cursor: isBelow ? "ns-resize" : "ew-resize",
								onMove: apply,
								onEnd: apply,
							});
						}}
					/>
					<div className="flex min-h-0 min-w-0" style={{ flex: `${1 - agentRatio} 1 0` }}>
						<TaskWorkbench
							workbenchTitle="查卡工作台"
							modules={modules}
							moduleLabels={MODULE_LABELS}
							defaultSlots={DEFAULT_SLOTS}
							moduleSlotsStorageKey={LocalStorageKey.TaskLookupWorkbenchModuleSlots}
							isBelowAgent={isBelow}
							arrangementPreference={arrangement.preference}
							onArrangementPreferenceChange={arrangement.setPreference}
							slotRatio={slotRatio}
							onSlotRatioChange={(ratio) => setSlotRatio(Math.max(0.15, Math.min(0.85, ratio)))}
							moduleSelectionRequest={{ slot: 1, module: "candidate_details", requestKey: previewRequestKey }}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
