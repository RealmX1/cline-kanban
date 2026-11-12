import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { resolveLastAgentConversationUserHandoffObservation } from "@runtime-agent-conversation-activity-observation";
import { resolveSessionFacets } from "@runtime-session-activity";
import { FileText, MessageCircleQuestion, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationSessionNameEditor } from "@/components/conversation-session-name-editor";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { TruncatedIdentifierChipWithCopyOnClick } from "@/components/shared/truncated-identifier-chip-with-copy-on-click";
import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	openSideSessionCreationWorkbench,
	refreshSideSessionCreationWorkbenchContext,
} from "@/state/side-session-creation-workbench-store";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { IndependentTaskCreationAction } from "./independent-task-creation-action";
import { TaskMainSessionHandoverAction } from "./task-main-session-handover-action";

type TaskOriginalPromptCard = Pick<BoardCard, "title" | "prompt" | "images" | "createdAt">;

type NewTaskConversationSessionContextSource = "started_from_scratch" | "forked_from_main_current_turn";

interface CreateTaskConversationSessionRequest {
	codexConfigurationProfileId?: string;
	agentId: RuntimeAgentId;
	sessionRole: "by_the_way" | "task_collaborator";
	initialUserQuestion: string;
	contextSource: NewTaskConversationSessionContextSource;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	contextSourceTaskConversationSessionId?: string;
}

// 每一行露出两个标识符：
//   · **会话 id**（旧主会话可以等于卡片 id，交接后仍保留各自 ID）——用户拿它对照日志、URL 与运行时诊断；
//   · **agent 原生会话 id**——harness 自己的 session id（`~/.claude/projects/**/<id>.jsonl` 就是它），
//     标签用记录里的 sourceAgentId 渲染，**不硬编码 agent 名**：这条 sidecar 由 hook stdin 落下，
//     跑的是哪个 harness 由它自己说了算。
// sidecar 缺席时（Cline / ACP 会话，或还没触发过 hook 的老数据）整块不渲染，不摆占位符——
// 一个空壳只会让人以为「这条会话的 id 是空的」。
function TaskConversationSessionIdentifierChips({
	summary,
	taskConversationSessionId,
}: {
	summary: RuntimeTaskSessionSummary;
	taskConversationSessionId: string;
}): React.ReactElement {
	const agentNativeConversationSessionIdentity = summary.agentNativeConversationSessionIdentity;
	return (
		// pr-9 给行右下角那个绝对定位的按钮让位（主会话行的「查看完整 prompt」）。
		<div className="flex flex-wrap items-center gap-1 px-2 pb-2 pr-9">
			<TruncatedIdentifierChipWithCopyOnClick
				identifierLabel="Session"
				identifierValue={taskConversationSessionId}
			/>
			{agentNativeConversationSessionIdentity ? (
				<TruncatedIdentifierChipWithCopyOnClick
					identifierLabel={agentNativeConversationSessionIdentity.sourceAgentId}
					identifierValue={agentNativeConversationSessionIdentity.nativeSessionId}
				/>
			) : null}
			{summary.codexEffectivePermissionMode && (
				<span className="text-[10px] text-text-secondary">
					当前权限：
					{summary.codexEffectivePermissionMode === "bypass_all_permission_prompts"
						? "全部允许"
						: "受审批或沙箱限制"}
				</span>
			)}
			{summary.codexConfigurationWriterBinding && summary.codexEffectivePermissionMode === null && (
				<span className="text-[10px] text-text-secondary">当前权限：待原生核验</span>
			)}
			{summary.codexConfigurationProfileRetainedInputRecovery && (
				<span role="status" className="text-[10px] text-status-gold">
					{summary.codexConfigurationProfileRetainedInputRecovery.reason}
				</span>
			)}
		</div>
	);
}

function isSideConversationSessionForTask(summary: RuntimeTaskSessionSummary, workspaceTaskId: string): boolean {
	const metadata = summary.taskConversationSessionMetadata;
	return metadata?.workspaceTaskId === workspaceTaskId && metadata.taskConversationSessionRole !== "main";
}

function getMainSessionTurnNumber(summary: RuntimeTaskSessionSummary): number {
	return summary.latestTurnCheckpoint?.turn ?? (summary.startedAt === null ? 0 : 1);
}

function getSessionStatusLabel(summary: RuntimeTaskSessionSummary): string {
	const facets = resolveSessionFacets(summary);
	if (facets.turnOwner === "agent") {
		return facets.liveness === "retrying" ? "Retrying" : "Answering";
	}
	if (facets.turnOwner === "user") {
		return facets.liveness === "failed" ? "Failed" : "Ready";
	}
	return "Idle";
}

function readTaskConversationSessionReadReceipts(): Record<string, number> {
	const storedValue = readLocalStorageItem(LocalStorageKey.TaskConversationSessionReadReceipts);
	if (!storedValue) {
		return {};
	}
	try {
		const parsedValue: unknown = JSON.parse(storedValue);
		if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsedValue).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

export function TaskConversationSessionsPanel({
	isTaskAgentExecutionDisabled = false,
	headerNavigationContent,
	headerEndActions,
	workspaceId,
	taskCard,
	workspaceTaskId,
	mainSessionSummary,
	mainSessionUserMessagePreview,
	mainSessionOriginalPromptCard,
	effectiveAgentId,
	agents,
	taskSessions,
	selectedTaskConversationSessionId,
	onSelectTaskConversationSession,
	onCreateTaskConversationSession: _onCreateTaskConversationSession,
}: {
	headerNavigationContent?: ReactNode;
	headerEndActions?: ReactNode;
	isTaskAgentExecutionDisabled?: boolean;
	workspaceId?: string | null;
	taskCard?: BoardCard;
	workspaceTaskId: string;
	mainSessionSummary: RuntimeTaskSessionSummary;
	mainSessionUserMessagePreview: string;
	// 任务的初始 prompt 全文。移动端 Focus View 不渲染左侧 ColumnContextPanel，卡片上的
	// 「View original prompt」入口因此整个消失 —— 这里的 Main session 行本就在展示这段 prompt
	// 的两行预览，把「看全文」挂在它旁边是移动端唯一自然的落点。
	mainSessionOriginalPromptCard: TaskOriginalPromptCard;
	effectiveAgentId: RuntimeAgentId;
	agents?: RuntimeAgentDefinition[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	selectedTaskConversationSessionId: string;
	onSelectTaskConversationSession: (taskConversationSessionId: string) => void;
	onCreateTaskConversationSession: (
		request: CreateTaskConversationSessionRequest,
	) => Promise<{ ok: boolean; message?: string }>;
}): React.ReactElement {
	const [isOriginalPromptDialogOpen, setIsOriginalPromptDialogOpen] = useState(false);
	const panelMounted = useRef(true);
	const displayedTaskIdentity = JSON.stringify([
		workspaceId,
		workspaceTaskId,
		taskCard?.createdAt ?? mainSessionOriginalPromptCard.createdAt,
	]);
	const displayedTaskIdentityRef = useRef(displayedTaskIdentity);
	displayedTaskIdentityRef.current = displayedTaskIdentity;
	useEffect(() => {
		if (workspaceId && taskCard)
			refreshSideSessionCreationWorkbenchContext({ workspaceId, task: taskCard, mainSessionSummary, taskSessions });
	}, [workspaceId, taskCard, mainSessionSummary, taskSessions]);
	useEffect(
		() => () => {
			panelMounted.current = false;
		},
		[],
	);

	const [readUserHandoffObservedAtMsBySessionId, setReadUserHandoffObservedAtMsBySessionId] = useState<
		Record<string, number>
	>(readTaskConversationSessionReadReceipts);
	const markSessionUserHandoffAsRead = useCallback((summary: RuntimeTaskSessionSummary) => {
		const handoffObservedAtMs = resolveLastAgentConversationUserHandoffObservation(summary)?.observedAtMs;
		if (handoffObservedAtMs == null) return;
		setReadUserHandoffObservedAtMsBySessionId((currentReadReceipts) => {
			// 旧版存的是摘要更新时间，可能晚于交棒；保留较大值，避免升级后已读回答重新亮点。
			if ((currentReadReceipts[summary.taskId] ?? 0) >= handoffObservedAtMs) return currentReadReceipts;
			const nextReadReceipts = { ...currentReadReceipts, [summary.taskId]: handoffObservedAtMs };
			writeLocalStorageItem(LocalStorageKey.TaskConversationSessionReadReceipts, JSON.stringify(nextReadReceipts));
			return nextReadReceipts;
		});
	}, []);
	const mainSessionTurnNumber = getMainSessionTurnNumber(mainSessionSummary);
	const sideConversationSessions = useMemo(
		() =>
			Object.values(taskSessions)
				.filter((summary) => isSideConversationSessionForTask(summary, workspaceTaskId))
				.sort((left, right) => right.updatedAt - left.updatedAt),
		[taskSessions, workspaceTaskId],
	);

	useEffect(() => {
		const selectedSummary = taskSessions[selectedTaskConversationSessionId];
		if (!selectedSummary) {
			return;
		}
		markSessionUserHandoffAsRead(selectedSummary);
	}, [selectedTaskConversationSessionId, taskSessions, markSessionUserHandoffAsRead]);

	useEffect(() => {
		const synchronizeReadReceiptsAcrossTabs = (event: StorageEvent) => {
			if (event.key === LocalStorageKey.TaskConversationSessionReadReceipts) {
				setReadUserHandoffObservedAtMsBySessionId(readTaskConversationSessionReadReceipts());
			}
		};
		window.addEventListener("storage", synchronizeReadReceiptsAcrossTabs);
		return () => window.removeEventListener("storage", synchronizeReadReceiptsAcrossTabs);
	}, []);

	const selectSession = (summary: RuntimeTaskSessionSummary) => {
		markSessionUserHandoffAsRead(summary);
		onSelectTaskConversationSession(summary.taskId);
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex h-8 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2">
				{headerNavigationContent ?? <span className="text-xs font-medium">Sessions</span>}
				<Button
					variant="ghost"
					size="sm"
					icon={<Plus size={14} />}
					className="ml-auto h-6"
					onClick={() => {
						if (!workspaceId || !taskCard) return;
						openSideSessionCreationWorkbench({
							workspaceId,
							task: taskCard,
							mainSessionSummary,
							agentId: effectiveAgentId,
							agents,
							taskSessions,
							onCreated: (sessionId) => {
								if (panelMounted.current && displayedTaskIdentityRef.current === displayedTaskIdentity)
									onSelectTaskConversationSession(sessionId);
							},
						});
					}}
					disabled={isTaskAgentExecutionDisabled}
				>
					新建会话
				</Button>
				{headerEndActions}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{workspaceId && taskCard?.independentTaskCreationProvenance && (
					<a
						className="mb-2 block break-words px-2 text-xs text-accent underline"
						href={`${buildProjectTaskDeepLinkUrl(taskCard.independentTaskCreationProvenance.sourceWorkspaceId, taskCard.independentTaskCreationProvenance.sourceTaskId)}&conversationSession=${encodeURIComponent(taskCard.independentTaskCreationProvenance.sourceTaskConversationSessionId)}`}
					>
						来自任务 {taskCard.independentTaskCreationProvenance.sourceTaskId} 的会话{" "}
						{taskCard.independentTaskCreationProvenance.sourceTaskConversationSessionId}
						{taskCard.independentTaskCreationProvenance.inheritedGitWorkingStateIncludedUncommittedChanges
							? "（含来源未提交修改）"
							: ""}
					</a>
				)}
				{workspaceId && taskCard && !isTaskAgentExecutionDisabled && (
					<TaskMainSessionHandoverAction
						workspaceId={workspaceId}
						taskCard={taskCard}
						mainSessionSummary={mainSessionSummary}
					/>
				)}
				{/* 「查看完整 prompt」是行内 button，不能嵌在选择会话的 button 里（嵌套 button 是无效 HTML），
					    故两者作为兄弟元素放进同一个 relative 容器，前者绝对定位到右下角。 */}
				{/* 底色挂在容器上而不是 button 上：id 条是 button 的兄弟节点（见下），底色留在 button 上
					    会让同一张卡片视觉上裂成两半。 */}
				<div
					className={cn(
						"relative mb-1 rounded-md hover:bg-surface-3",
						selectedTaskConversationSessionId === mainSessionSummary.taskId && "bg-surface-3",
					)}
				>
					<button
						type="button"
						className="w-full rounded-md px-2 pb-1 pt-2 text-left"
						data-task-conversation-session-id={mainSessionSummary.taskId}
						aria-current={selectedTaskConversationSessionId === mainSessionSummary.taskId ? "true" : undefined}
						onClick={() => selectSession(mainSessionSummary)}
					>
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium text-text-primary">
								{mainSessionSummary.taskConversationSessionMetadata?.conversationSessionName || "Main session"}
							</span>
							<span className="ml-auto text-[11px] text-text-tertiary">
								{getSessionStatusLabel(mainSessionSummary)}
							</span>
						</div>
						<p className="mt-1 line-clamp-2 pr-9 text-xs text-text-secondary">{mainSessionUserMessagePreview}</p>
					</button>
					<TaskConversationSessionIdentifierChips
						summary={mainSessionSummary}
						taskConversationSessionId={mainSessionSummary.taskId}
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<FileText size={14} />}
						onClick={() => setIsOriginalPromptDialogOpen(true)}
						aria-label="View the original prompt for this task"
						className={cn("absolute bottom-1 right-1", MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
					/>
				</div>
				<TaskOriginalPromptDialog
					open={isOriginalPromptDialogOpen}
					card={mainSessionOriginalPromptCard}
					onClose={() => setIsOriginalPromptDialogOpen(false)}
				/>
				{sideConversationSessions.map((summary) => {
					const metadata = summary.taskConversationSessionMetadata;
					if (!metadata) {
						return null;
					}
					const turnsAgo = Math.max(0, mainSessionTurnNumber - (metadata.mainSessionOriginTurnNumber ?? 0));
					// PTY 重绘、恢复和元数据更新都会推进 updatedAt，只有真实交棒才能产生新的未读回答。
					const handoffObservation = resolveLastAgentConversationUserHandoffObservation(summary);
					const hasUnreadCompletion =
						resolveSessionFacets(summary).turnOwner === "user" &&
						handoffObservation !== null &&
						(readUserHandoffObservedAtMsBySessionId[summary.taskId] ?? 0) < handoffObservation.observedAtMs &&
						selectedTaskConversationSessionId !== summary.taskId;
					return (
						// id 复制芯片是 button，不能嵌进这个整行可点的 button 里（嵌套 button 是无效 HTML），
						// 故与它并列放进同一个容器；底色同样挂在容器上，保持一张卡片的观感。
						<div
							key={summary.taskId}
							className={cn(
								"mb-1 rounded-md hover:bg-surface-3",
								selectedTaskConversationSessionId === summary.taskId && "bg-surface-3",
							)}
						>
							<button
								type="button"
								className="w-full rounded-md px-2 pb-1 pt-2 text-left"
								data-task-conversation-session-id={summary.taskId}
								aria-current={selectedTaskConversationSessionId === summary.taskId ? "true" : undefined}
								onClick={() => selectSession(summary)}
							>
								<div className="flex flex-wrap items-center gap-2">
									{metadata.conversationSessionName && (
										<span className="text-xs font-medium text-text-primary">
											{metadata.conversationSessionName}
										</span>
									)}
									<MessageCircleQuestion size={13} className="text-status-purple" />
									<span className="text-xs font-medium text-text-primary">
										{metadata.taskConversationSessionHasHeldMainResponsibility ||
										metadata.taskConversationSessionRoleAtCreation === "main"
											? "前主会话"
											: metadata.taskConversationSessionRole === "task_collaborator"
												? "协作会话"
												: "By the way"}
									</span>
									<span className="text-[11px] text-text-tertiary">
										{getRuntimeAgentCatalogEntry(summary.agentId ?? "codex")?.label ?? summary.agentId}
									</span>
									{hasUnreadCompletion ? (
										<span role="img" className="h-2 w-2 rounded-full bg-accent" aria-label="Unread answer" />
									) : null}
									<span className="ml-auto text-[11px] text-text-tertiary">
										{getSessionStatusLabel(summary)}
									</span>
								</div>
								<p className="mt-1 line-clamp-2 text-xs text-text-secondary">
									{metadata.latestUserMessagePreview?.trim() ||
										(summary.agentConversationPromptSubmissionAcceptance?.status === "accepted" ||
										(summary.agentResponseGenerationTurnSequence ?? 0) > 0
											? "已发送消息"
											: "尚未发送消息")}
								</p>
								<p className="mt-1 text-[11px] text-text-tertiary">
									{metadata.contextSourceTaskConversationSessionId
										? `继承自会话 ${metadata.contextSourceTaskConversationSessionId}`
										: metadata.taskConversationSessionContextSource === "forked_from_main_current_turn"
											? `Forked from main · ${turnsAgo} turns ago`
											: metadata.creatorTaskConversationSessionId
												? `全新上下文 · 创建者 ${metadata.creatorTaskConversationSessionId}`
												: `Started from scratch · ${turnsAgo} turns ago`}
								</p>
							</button>
							{workspaceId && taskCard && !isTaskAgentExecutionDisabled && (
								<ConversationSessionNameEditor
									workspaceId={workspaceId}
									taskCard={taskCard}
									summary={summary}
								/>
							)}
							<TaskConversationSessionIdentifierChips
								summary={summary}
								taskConversationSessionId={summary.taskId}
							/>
							{workspaceId &&
								!isTaskAgentExecutionDisabled &&
								!metadata.taskConversationSessionHasHeldMainResponsibility &&
								metadata.taskConversationSessionRoleAtCreation !== "main" && (
									<IndependentTaskCreationAction
										workspaceId={workspaceId}
										sourceTaskId={workspaceTaskId}
										expectedTaskIncarnationCreatedAtEpochMs={
											taskCard?.createdAt ?? mainSessionOriginalPromptCard.createdAt
										}
										sourceSessionId={summary.taskId}
									/>
								)}
						</div>
					);
				})}
				{sideConversationSessions.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-text-tertiary">
						<MessageCircleQuestion size={24} />
						<span>
							{isTaskAgentExecutionDisabled
								? "此任务没有其他会话。"
								: "创建协作会话处理工作，或用 By the way 询问侧问。"}
						</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
